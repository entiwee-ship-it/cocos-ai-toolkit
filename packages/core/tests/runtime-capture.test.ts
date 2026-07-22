import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { cropPng, decodePng, diffPng, drawOverlay, encodePng } from '../src/runtime-capture.js';

/** 构造纯色 PNG。 */
function createSolidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let index = 0; index < width * height; index += 1) {
    png.data[index * 4] = rgba[0];
    png.data[index * 4 + 1] = rgba[1];
    png.data[index * 4 + 2] = rgba[2];
    png.data[index * 4 + 3] = rgba[3];
  }
  return PNG.sync.write(png);
}

/** 修改指定像素颜色。 */
function withPixel(source: Buffer, x: number, y: number, rgba: [number, number, number, number]): Buffer {
  const png = PNG.sync.read(source);
  const offset = (y * png.width + x) * 4;
  png.data[offset] = rgba[0];
  png.data[offset + 1] = rgba[1];
  png.data[offset + 2] = rgba[2];
  png.data[offset + 3] = rgba[3];
  return PNG.sync.write(png);
}

function readPixel(buffer: Buffer, x: number, y: number): [number, number, number, number] {
  const png = PNG.sync.read(buffer);
  const offset = (y * png.width + x) * 4;
  return [png.data[offset], png.data[offset + 1], png.data[offset + 2], png.data[offset + 3]];
}

describe('decodePng / encodePng', () => {
  it('编解码往返保持尺寸与像素', () => {
    const source = createSolidPng(4, 4, [10, 20, 30, 255]);
    const decoded = decodePng(source);
    expect(decoded).toMatchObject({ width: 4, height: 4 });
    const reencoded = encodePng(decoded);
    expect(readPixel(reencoded, 2, 2)).toEqual([10, 20, 30, 255]);
  });
});

describe('cropPng', () => {
  it('按区域裁剪并保留像素内容', () => {
    const source = withPixel(createSolidPng(8, 8, [0, 0, 0, 255]), 3, 4, [255, 0, 0, 255]);
    const cropped = cropPng(source, { x: 2, y: 2, width: 4, height: 4 });
    const decoded = decodePng(cropped);
    expect(decoded).toMatchObject({ width: 4, height: 4 });
    // 原图 (3,4) 的红点在裁剪后位于 (1,2)
    expect(readPixel(cropped, 1, 2)).toEqual([255, 0, 0, 255]);
  });

  it('越界裁剪拒绝', () => {
    const source = createSolidPng(8, 8, [0, 0, 0, 255]);
    expect(() => cropPng(source, { x: 6, y: 0, width: 4, height: 4 })).toThrow('CROP_OUT_OF_BOUNDS');
    expect(() => cropPng(source, { x: -1, y: 0, width: 4, height: 4 })).toThrow('CROP_OUT_OF_BOUNDS');
  });
});

describe('diffPng', () => {
  it('完全相同图像差异为零', () => {
    const a = createSolidPng(4, 4, [50, 50, 50, 255]);
    const result = diffPng(a, a);
    expect(result.diffRatio).toBe(0);
    expect(result.diffPixelCount).toBe(0);
  });

  it('差异像素计数、比例与差异图标记', () => {
    const baseline = createSolidPng(4, 4, [50, 50, 50, 255]);
    const current = withPixel(baseline, 1, 1, [200, 50, 50, 255]);
    const result = diffPng(baseline, current);
    expect(result.diffPixelCount).toBe(1);
    expect(result.diffRatio).toBeCloseTo(1 / 16, 5);
    // 差异图：差异像素标红
    expect(readPixel(result.diffPng, 1, 1)).toEqual([255, 0, 0, 255]);
    // 非差异像素不标红
    expect(readPixel(result.diffPng, 0, 0)).not.toEqual([255, 0, 0, 255]);
  });

  it('容差内的颜色抖动不计为差异', () => {
    const baseline = createSolidPng(2, 2, [100, 100, 100, 255]);
    const current = withPixel(baseline, 0, 0, [105, 103, 100, 255]);
    expect(diffPng(baseline, current, { tolerance: 10 }).diffPixelCount).toBe(0);
    expect(diffPng(baseline, current, { tolerance: 2 }).diffPixelCount).toBe(1);
  });

  it('尺寸不一致时抛出明确错误', () => {
    const a = createSolidPng(4, 4, [0, 0, 0, 255]);
    const b = createSolidPng(2, 2, [0, 0, 0, 255]);
    expect(() => diffPng(a, b)).toThrow('IMAGE_SIZE_MISMATCH');
  });
});

describe('drawOverlay', () => {
  it('绘制节点边界矩形（四边线，内部不变）', () => {
    const source = createSolidPng(10, 10, [0, 0, 0, 255]);
    const overlaid = drawOverlay(source, { rects: [{ x: 2, y: 2, width: 4, height: 4 }] });
    // 四角为边界色
    expect(readPixel(overlaid, 2, 2)).toEqual([255, 0, 0, 255]);
    expect(readPixel(overlaid, 5, 2)).toEqual([255, 0, 0, 255]);
    expect(readPixel(overlaid, 2, 5)).toEqual([255, 0, 0, 255]);
    expect(readPixel(overlaid, 5, 5)).toEqual([255, 0, 0, 255]);
    // 中心保持原色
    expect(readPixel(overlaid, 3, 3)).toEqual([0, 0, 0, 255]);
  });

  it('绘制锚点十字', () => {
    const source = createSolidPng(11, 11, [0, 0, 0, 255]);
    const overlaid = drawOverlay(source, { anchors: [{ x: 5, y: 5 }] });
    expect(readPixel(overlaid, 5, 5)).toEqual([0, 255, 0, 255]);
    expect(readPixel(overlaid, 5, 4)).toEqual([0, 255, 0, 255]);
    expect(readPixel(overlaid, 4, 5)).toEqual([0, 255, 0, 255]);
    expect(readPixel(overlaid, 5, 6)).toEqual([0, 255, 0, 255]);
    expect(readPixel(overlaid, 6, 5)).toEqual([0, 255, 0, 255]);
    // 对角位置不受影响
    expect(readPixel(overlaid, 4, 4)).toEqual([0, 0, 0, 255]);
  });
});
