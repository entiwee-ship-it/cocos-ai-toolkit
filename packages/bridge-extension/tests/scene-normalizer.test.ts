import { describe, expect, it } from 'vitest';
import { normalizeComponentDump, normalizeNodeDump } from '../src/scene-probe.js';

describe('scene normalizer', () => {
  it('保留节点身份、Transform、层级和完整原始 Dump', () => {
    const raw = {
      uuid: { value: 'node-1' }, name: { value: 'Main Camera' }, active: { value: true },
      layer: { value: 1073741824 }, position: { value: { x: 1, y: 2, z: 3 } },
      rotation: { value: { x: 4, y: 5, z: 6 } }, scale: { value: { x: 1, y: 1, z: 1 } },
      parent: { value: { uuid: 'scene-1' } }, children: [{ uuid: 'child-1' }], __type__: 'cc.Node', __comps__: []
    };
    const node = normalizeNodeDump(raw, 2);
    expect(node).toMatchObject({
      identity: { objectUuid: 'node-1' }, name: 'Main Camera', active: true,
      layer: 1073741824, siblingIndex: 2, parentUuid: 'scene-1', childUuids: ['child-1'],
      transform: { position: { x: 1, y: 2, z: 3 } }
    });
    expect(node.raw).toEqual(raw);
  });

  it('区分 Node、Component、Asset 引用并保留自定义组件信息', () => {
    const raw = {
      value: {
        uuid: { value: 'component-1' }, node: { type: 'cc.Node', value: { uuid: 'node-1' } },
        target: { type: 'cc.Camera', value: { uuid: 'component-2' }, extends: ['cc.Component'] },
        sprite: { type: 'cc.SpriteFrame', value: { uuid: 'asset-1' }, extends: ['cc.Asset'] },
        score: { type: 'Number', value: 3 }, futureProperty: { value: { opaque: true } }
      }, type: 'GameController', cid: 'custom-cid', extends: ['cc.Component', 'cc.Object']
    };
    const component = normalizeComponentDump(raw);
    expect(component.identity.objectUuid).toBe('component-1');
    expect(component.class).toMatchObject({ className: 'GameController', typeId: 'custom-cid', custom: true });
    expect(component.properties.node.valueKind).toBe('node-reference');
    expect(component.properties.target.valueKind).toBe('component-reference');
    expect(component.properties.sprite.valueKind).toBe('asset-reference');
    expect(component.unresolved).toContainEqual(expect.objectContaining({ path: 'properties.futureProperty' }));
    expect(component.raw).toEqual(raw);
  });
});
