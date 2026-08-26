interface Point3 {
  x: number;
  y: number;
  z: number;
}

interface Rect2D {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface NodeBoundsOptions {
  includeDescendantVisualUnion?: boolean;
  relativeNode?: unknown;
  relativeToPath?: string;
}

type PointFactory = (x: number, y: number, z: number) => Point3;

/**
 * 读取编辑态节点自身 UI 矩形、世界矩形、锚点和可选后代并集。
 *
 * @param nodeValue Creator 当前文档中的运行时节点。
 * @param options 后代并集和相对坐标节点选项。
 * @param createPoint 创建 Creator Vec3 兼容点的工厂。
 * @returns 可序列化的编辑态 UI bounds；节点无 UITransform 时自身矩形为 null。
 */
export function readNodeBounds(
  nodeValue: unknown,
  options: NodeBoundsOptions,
  createPoint: PointFactory
) {
  const node = readObject(nodeValue);
  const own = readOwnBounds(node, createPoint);
  const descendantPoints = options.includeDescendantVisualUnion
    ? readDescendantWorldPoints(node, createPoint)
    : [];
  const descendantWorldRect = rectFromPoints(descendantPoints);
  const relativeNode = readObject(options.relativeNode);
  const hasRelativeNode = Object.keys(relativeNode).length > 0;
  const relativeOwnPoints = hasRelativeNode && own
    ? own.worldPoints.map((point) => toRelativePoint(relativeNode, point, createPoint))
    : [];
  const relativeDescendantPoints = hasRelativeNode
    ? descendantPoints.map((point) => toRelativePoint(relativeNode, point, createPoint))
    : [];
  return {
    hasUiTransform: own !== null,
    localRect: own?.localRect ?? null,
    worldRect: own?.worldRect ?? null,
    anchor: own ? { normalized: own.anchor, world: own.worldAnchor } : null,
    ...(options.includeDescendantVisualUnion ? {
      descendantVisualUnion: descendantWorldRect ? {
        worldRect: descendantWorldRect,
        ...(hasRelativeNode ? { relativeRect: rectFromPoints(relativeDescendantPoints) } : {})
      } : null
    } : {}),
    ...(hasRelativeNode ? {
      relativeTo: {
        nodeUuid: readNodeUuid(relativeNode),
        path: options.relativeToPath ?? null,
        rect: own ? rectFromPoints(relativeOwnPoints) : null,
        anchor: own ? toRelativePoint(relativeNode, own.worldAnchor, createPoint) : null
      }
    } : {})
  };
}

function readOwnBounds(node: Record<string, unknown>, createPoint: PointFactory) {
  const ui = readUiTransform(node);
  if (!ui) return null;
  const contentSize = readObject(ui.contentSize);
  const anchor = readObject(ui.anchorPoint);
  const width = readFiniteNumber(contentSize.width);
  const height = readFiniteNumber(contentSize.height);
  const anchorX = readFiniteNumber(anchor.x);
  const anchorY = readFiniteNumber(anchor.y);
  const convert = ui.convertToWorldSpaceAR;
  if (
    width === null
    || height === null
    || anchorX === null
    || anchorY === null
    || typeof convert !== 'function'
  ) return null;
  const localRect = {
    x: -width * anchorX,
    y: -height * anchorY,
    width,
    height
  };
  const worldPoints = rectPoints(localRect).map((point) => {
    const input = createPoint(point.x, point.y, 0);
    return readPoint(convert.call(ui, input) ?? input) ?? input;
  });
  const worldAnchor = readPoint(node.worldPosition)
    ?? readPoint(convert.call(ui, createPoint(0, 0, 0)))
    ?? { x: 0, y: 0, z: 0 };
  return {
    localRect,
    worldRect: rectFromPoints(worldPoints),
    worldPoints,
    worldAnchor,
    anchor: { x: anchorX, y: anchorY }
  };
}

function readDescendantWorldPoints(node: Record<string, unknown>, createPoint: PointFactory): Point3[] {
  const points: Point3[] = [];
  for (const childValue of readChildren(node)) {
    const child = readObject(childValue);
    if (child.activeInHierarchy === false || child.active === false) continue;
    const own = readOwnBounds(child, createPoint);
    if (own && own.localRect.width > 0 && own.localRect.height > 0) points.push(...own.worldPoints);
    points.push(...readDescendantWorldPoints(child, createPoint));
  }
  return points;
}

function readUiTransform(node: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof node.getComponent !== 'function') return null;
  const getComponent = node.getComponent as (type: string) => unknown;
  const ui = getComponent.call(node, 'cc.UITransform') ?? getComponent.call(node, 'UITransform');
  const record = readObject(ui);
  return Object.keys(record).length > 0 ? record : null;
}

function toRelativePoint(
  relativeNode: Record<string, unknown>,
  worldPoint: Point3,
  createPoint: PointFactory
): Point3 {
  if (typeof relativeNode.inverseTransformPoint !== 'function') return worldPoint;
  const output = createPoint(0, 0, 0);
  const inverseTransformPoint = relativeNode.inverseTransformPoint as (out: Point3, point: Point3) => unknown;
  return readPoint(inverseTransformPoint.call(relativeNode, output, worldPoint) ?? output) ?? output;
}

function rectPoints(rect: Rect2D): Point3[] {
  return [
    { x: rect.x, y: rect.y, z: 0 },
    { x: rect.x + rect.width, y: rect.y, z: 0 },
    { x: rect.x + rect.width, y: rect.y + rect.height, z: 0 },
    { x: rect.x, y: rect.y + rect.height, z: 0 }
  ];
}

function rectFromPoints(points: Point3[]): Rect2D | null {
  if (points.length === 0) return null;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function readChildren(node: Record<string, unknown>): unknown[] {
  return Array.isArray(node.children) ? node.children : Array.isArray(node._children) ? node._children : [];
}

function readNodeUuid(node: Record<string, unknown>): string | null {
  return typeof node.uuid === 'string' && node.uuid
    ? node.uuid
    : typeof node._uuid === 'string' && node._uuid ? node._uuid : null;
}

function readPoint(value: unknown): Point3 | null {
  const point = readObject(value);
  const x = readFiniteNumber(point.x);
  const y = readFiniteNumber(point.y);
  const z = readFiniteNumber(point.z) ?? 0;
  return x === null || y === null ? null : { x, y, z };
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
