import { PNG } from 'pngjs';

/**
 * 视觉验证图像处理（阶段五）：PNG 编解码、区域裁剪、像素级差异图、边界/锚点叠加。
 * 纯 JS 实现（pngjs），无原生依赖。视觉结果仅作辅助证据。
 */

export interface PngImage {
  width: number;
  height: number;
  data: Buffer;
}

export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlayAnchor {
  x: number;
  y: number;
}

/** 解码 PNG 字节。 */
export function decodePng(buffer: Buffer): PngImage {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height, data: Buffer.from(png.data) };
}

/** 编码为 PNG 字节。 */
export function encodePng(image: PngImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  image.data.copy(png.data);
  return PNG.sync.write(png);
}

/**
 * 按区域裁剪 PNG。
 *
 * @param buffer 源 PNG 字节。
 * @param rect 裁剪区域（像素坐标，必须完全位于图像内）。
 * @returns 裁剪后的 PNG 字节。
 */
export function cropPng(buffer: Buffer, rect: CaptureRect): Buffer {
  const source = decodePng(buffer);
  if (
    !Number.isInteger(rect.x) || !Number.isInteger(rect.y)
    || !Number.isInteger(rect.width) || !Number.isInteger(rect.height)
    || rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1
    || rect.x + rect.width > source.width || rect.y + rect.height > source.height
  ) {
    throw new Error('CROP_OUT_OF_BOUNDS');
  }
  const target = new PNG({ width: rect.width, height: rect.height });
  for (let row = 0; row < rect.height; row += 1) {
    const sourceStart = ((rect.y + row) * source.width + rect.x) * 4;
    source.data.copy(target.data, row * rect.width * 4, sourceStart, sourceStart + rect.width * 4);
  }
  return PNG.sync.write(target);
}

export interface DiffResult {
  /** 差异像素占总像素比例（0..1）。 */
  diffRatio: number;
  diffPixelCount: number;
  /** 差异图：差异像素标红，其余保留原图降灰。 */
  diffPng: Buffer;
}

/**
 * 像素级图像差异比较：RGB 通道最大差值超过 tolerance 记为差异像素。
 *
 * @param baseline 基准 PNG 字节。
 * @param current 当前 PNG 字节（尺寸必须与基准一致）。
 * @param options tolerance 单通道容差（0..255，默认 0）。
 * @returns 差异比例、差异像素数与差异图。
 */
export function diffPng(baseline: Buffer, current: Buffer, options: { tolerance?: number } = {}): DiffResult {
  const base = decodePng(baseline);
  const actual = decodePng(current);
  if (base.width !== actual.width || base.height !== actual.height) {
    throw new Error('IMAGE_SIZE_MISMATCH');
  }
  const tolerance = options.tolerance ?? 0;
  const total = base.width * base.height;
  let diffPixelCount = 0;
  const diffImage = new PNG({ width: base.width, height: base.height });
  for (let index = 0; index < total; index += 1) {
    const offset = index * 4;
    const delta = Math.max(
      Math.abs(base.data[offset] - actual.data[offset]),
      Math.abs(base.data[offset + 1] - actual.data[offset + 1]),
      Math.abs(base.data[offset + 2] - actual.data[offset + 2])
    );
    if (delta > tolerance) {
      diffPixelCount += 1;
      diffImage.data[offset] = 255;
      diffImage.data[offset + 1] = 0;
      diffImage.data[offset + 2] = 0;
      diffImage.data[offset + 3] = 255;
    } else {
      // 降灰保留原图背景，便于定位差异区域
      const gray = Math.round(
        (actual.data[offset] + actual.data[offset + 1] + actual.data[offset + 2]) / 6
      );
      diffImage.data[offset] = gray;
      diffImage.data[offset + 1] = gray;
      diffImage.data[offset + 2] = gray;
      diffImage.data[offset + 3] = 255;
    }
  }
  return {
    diffRatio: total === 0 ? 0 : diffPixelCount / total,
    diffPixelCount,
    diffPng: PNG.sync.write(diffImage)
  };
}

export interface DrawOverlayOptions {
  /** 节点边界矩形列表（红色四边线）。 */
  rects?: CaptureRect[];
  /** 锚点列表（绿色十字）。 */
  anchors?: OverlayAnchor[];
}

/**
 * 在 PNG 上叠加绘制节点边界与锚点。
 *
 * @param buffer 源 PNG 字节。
 * @param options 矩形与锚点列表（像素坐标；越界部分自动裁剪）。
 * @returns 叠加后的 PNG 字节。
 */
export function drawOverlay(buffer: Buffer, options: DrawOverlayOptions): Buffer {
  const image = decodePng(buffer);
  const setPixel = (x: number, y: number, rgba: [number, number, number, number]): void => {
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
    const offset = (y * image.width + x) * 4;
    image.data[offset] = rgba[0];
    image.data[offset + 1] = rgba[1];
    image.data[offset + 2] = rgba[2];
    image.data[offset + 3] = rgba[3];
  };
  const red: [number, number, number, number] = [255, 0, 0, 255];
  const green: [number, number, number, number] = [0, 255, 0, 255];

  for (const rect of options.rects ?? []) {
    const left = Math.round(rect.x);
    const top = Math.round(rect.y);
    const right = Math.round(rect.x + rect.width) - 1;
    const bottom = Math.round(rect.y + rect.height) - 1;
    for (let x = left; x <= right; x += 1) {
      setPixel(x, top, red);
      setPixel(x, bottom, red);
    }
    for (let y = top; y <= bottom; y += 1) {
      setPixel(left, y, red);
      setPixel(right, y, red);
    }
  }
  for (const anchor of options.anchors ?? []) {
    const cx = Math.round(anchor.x);
    const cy = Math.round(anchor.y);
    for (let delta = -3; delta <= 3; delta += 1) {
      setPixel(cx + delta, cy, green);
      setPixel(cx, cy + delta, green);
    }
  }
  return encodePng(image);
}
