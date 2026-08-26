import { describe, expect, it } from 'vitest';
import { readNodeBounds } from '../src/scene-bounds.js';

interface Point3 {
  x: number;
  y: number;
  z: number;
}

function createNode(options: {
  uuid: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  children?: unknown[];
}) {
  const ui = options.width === undefined ? null : {
    contentSize: { width: options.width, height: options.height },
    anchorPoint: { x: 0.5, y: 0.5 },
    convertToWorldSpaceAR(point: Point3) {
      return { x: point.x + options.x, y: point.y + options.y, z: point.z };
    }
  };
  return {
    uuid: options.uuid,
    activeInHierarchy: true,
    worldPosition: { x: options.x, y: options.y, z: 0 },
    children: options.children ?? [],
    getComponent: () => ui,
    inverseTransformPoint(out: Point3, point: Point3) {
      out.x = point.x - options.x;
      out.y = point.y - options.y;
      out.z = point.z;
      return out;
    }
  };
}

describe('readNodeBounds', () => {
  it('返回自身、后代并集和相对坐标矩形', () => {
    const child = createNode({ uuid: 'child', x: 50, y: 0, width: 20, height: 10 });
    const node = createNode({ uuid: 'node', x: 10, y: 20, width: 100, height: 40, children: [child] });
    const relative = createNode({ uuid: 'relative', x: 5, y: 5 });

    const bounds = readNodeBounds(node, {
      includeDescendantVisualUnion: true,
      relativeNode: relative,
      relativeToPath: 'Root/Relative'
    }, (x, y, z) => ({ x, y, z }));

    expect(bounds).toMatchObject({
      hasUiTransform: true,
      localRect: { x: -50, y: -20, width: 100, height: 40 },
      worldRect: { x: -40, y: 0, width: 100, height: 40 },
      anchor: { normalized: { x: 0.5, y: 0.5 }, world: { x: 10, y: 20, z: 0 } },
      descendantVisualUnion: {
        worldRect: { x: 40, y: -5, width: 20, height: 10 },
        relativeRect: { x: 35, y: -10, width: 20, height: 10 }
      },
      relativeTo: {
        nodeUuid: 'relative',
        path: 'Root/Relative',
        rect: { x: -45, y: -5, width: 100, height: 40 },
        anchor: { x: 5, y: 15, z: 0 }
      }
    });
  });

  it('节点无 UITransform 时仍可返回后代并集', () => {
    const child = createNode({ uuid: 'child', x: 10, y: 10, width: 20, height: 20 });
    const node = createNode({ uuid: 'node', x: 0, y: 0, children: [child] });

    expect(readNodeBounds(node, { includeDescendantVisualUnion: true }, (x, y, z) => ({ x, y, z })))
      .toMatchObject({
        hasUiTransform: false,
        localRect: null,
        worldRect: null,
        descendantVisualUnion: { worldRect: { x: 0, y: 0, width: 20, height: 20 } }
      });
  });
});
