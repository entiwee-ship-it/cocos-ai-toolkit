import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { buildRuntimeScript, readRuntimeNodeBounds } from '../src/runtime-inject.js';

afterEach(() => vi.unstubAllGlobals());

/** 相机投影与节点旋转分开模拟，确保不再依赖屏幕中心或后代 AABB。 */
function engine() {
  class Vec3 { constructor(public x = 0, public y = 0, public z = 0) {} }
  const scene: any = { name: 'main', uuid: 'scene-uuid', _id: 'scene-uuid', children: [], components: [], active: true };
  const root: any = { name: 'Panel', uuid: 'Node.42', _id: 'Node.42', parent: scene, children: [], components: [], active: true, activeInHierarchy: true, layer: 8 };
  const ui = {
    width: 100, height: 40, anchorX: 0.5, anchorY: 0.5,
    convertToWorldSpaceAR: (p: Vec3) => new Vec3(300 - p.y, 200 + p.x, 0),
    getBoundingBoxToWorld: vi.fn(() => ({ x: -5000, y: -5000, width: 10000, height: 10000 }))
  };
  root.getComponent = () => ui;
  root.worldPosition = new Vec3(300, 200);
  root.getSiblingIndex = () => 0;
  const camera = { node: { name: 'UI Camera' }, priority: 7, worldToScreen: (out: Vec3, value: Vec3) => Object.assign(out, { x: value.x * 2, y: value.y * 2, z: 0.5 }) };
  scene.children = [root];
  const cc = { Vec3, UITransform: {}, Layers: { Enum: { UI_2D: 8 } }, director: { getScene: () => scene, root: { batcher2D: { getFirstRenderCamera: () => camera } } }, screen: { windowSize: { width: 1000, height: 800 } } };
  return { cc, scene, root, ui };
}

describe('运行节点范围和来源', () => {
  it('使用实际相机投影节点自身四角，保留旋转、尺寸和画布缩放', async () => {
    const { cc, ui } = engine();
    vi.stubGlobal('System', { import: async () => cc });
    vi.stubGlobal('document', { getElementById: () => ({ getBoundingClientRect: () => ({ width: 500, height: 400 }) }) });
    const result = await readRuntimeNodeBounds({ paths: ['/main~0/Panel~0'] }) as any;
    expect(result.entries[0]).toMatchObject({ found: true, hasBounds: true, rect: { x: 280, y: 150, width: 40, height: 100 }, anchor: { x: 300, y: 200 }, viewport: { width: 500, height: 400 } });
    expect(result.entries[0].points).toEqual([{ x: 320, y: 250 }, { x: 320, y: 150 }, { x: 280, y: 150 }, { x: 280, y: 250 }]);
    expect(ui.getBoundingBoxToWorld).not.toHaveBeenCalled();
  });

  it('没有渲染相机时明确返回不可投影，而不是猜测节点范围', async () => {
    const { cc } = engine();
    cc.director.root.batcher2D.getFirstRenderCamera = () => null as any;
    vi.stubGlobal('System', { import: async () => cc });
    const result = await readRuntimeNodeBounds({ paths: ['/main~0/Panel~0'] }) as any;
    expect(result.entries[0]).toMatchObject({ found: true, hasBounds: false, reason: 'render-camera-unavailable' });
  });

  it('运行时生成 ID 不再被当成场景来源；嵌套预制体采用自身资产身份', async () => {
    const { cc, root } = engine();
    root._prefab = { asset: { _uuid: 'nested-prefab' }, fileId: 'source-node-file-id', root };
    const context = { System: { import: async () => cc } };
    const node = await runInNewContext(buildRuntimeScript('readRuntimeNodeDetails', { path: '/main~0/Panel~0' }), context);
    expect(node).toMatchObject({ found: true, nodeUuid: 'Node.42', dynamic: true, depth: 1, siblingIndex: 0, layer: 8, layerName: 'UI_2D', origin: { kind: 'prefab', assetUuid: 'nested-prefab', fileId: 'source-node-file-id', rootUuid: 'Node.42', rootPath: '/main~0/Panel~0', instanceRoot: true } });
    const tree = await runInNewContext(buildRuntimeScript('readRuntimeHierarchy', { maxDepth: 3 }), context);
    expect(tree.children[0]).toMatchObject({ dynamic: true, origin: { kind: 'prefab', assetUuid: 'nested-prefab' } });
    root._prefab = null;
    const generated = await runInNewContext(buildRuntimeScript('readRuntimeNodeDetails', { path: '/main~0/Panel~0' }), context);
    expect(generated.origin).toEqual({ kind: 'runtime' });
  });
});
