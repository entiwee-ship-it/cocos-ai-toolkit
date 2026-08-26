import { describe, expect, it, vi } from 'vitest';
import { ProbeError } from '../src/probe-errors.js';
import {
  executeNodeWriteOperation,
  type NodeInfo,
  type NodeWriterDependencies
} from '../src/node-writer.js';

describe('node.create', () => {
  it('在指定父节点下创建节点并返回证据', async () => {
    const dependencies = createDependencies();
    const result = await executeNodeWriteOperation(
      { type: 'node.create', parentNodeUuid: 'parent-1', name: 'TempNode', layer: 2, active: false },
      dependencies
    );

    expect(dependencies.calls).toEqual([
      'getNodeInfo:parent-1',
      'createNode:parent-1:TempNode',
      'setNodeLayer:new-node-1:2',
      'setNodeActive:new-node-1:false',
      'getNodeInfo:new-node-1'
    ]);
    expect(result.nodeUuid).toBe('new-node-1');
    expect(result.before).toBeNull();
    expect(result.after).toMatchObject({ name: 'TempNode', layer: 2, active: false });
  });

  it('父节点不存在时拒绝创建', async () => {
    const dependencies = createDependencies({ existingNodes: [] });
    await expect(executeNodeWriteOperation(
      { type: 'node.create', parentNodeUuid: 'missing-parent', name: 'TempNode' },
      dependencies
    )).rejects.toThrow('NODE_PARENT_NOT_FOUND');
  });
});

describe('node.delete', () => {
  it('删除节点并保留 before 证据', async () => {
    const dependencies = createDependencies();
    const result = await executeNodeWriteOperation(
      { type: 'node.delete', nodeUuid: 'node-1' },
      dependencies
    );

    expect(result.before).toMatchObject({ uuid: 'node-1', name: 'NodeOne' });
    expect(result.after).toBeNull();
    expect(dependencies.calls).toContain('removeNode:node-1');
  });

  it('目标节点不存在时返回稳定错误码', async () => {
    const dependencies = createDependencies();
    await expect(executeNodeWriteOperation(
      { type: 'node.delete', nodeUuid: 'missing' },
      dependencies
    )).rejects.toThrow('NODE_NOT_FOUND');
  });
});

describe('node.rename', () => {
  it('重命名并返回 before/after 证据', async () => {
    const dependencies = createDependencies();
    const result = await executeNodeWriteOperation(
      { type: 'node.rename', nodeUuid: 'node-1', name: 'Renamed' },
      dependencies
    );

    expect(result.before).toMatchObject({ name: 'NodeOne' });
    expect(result.after).toMatchObject({ name: 'Renamed' });
  });
});

describe('node.reparent', () => {
  it('移动节点到新父节点并支持 siblingIndex', async () => {
    const dependencies = createDependencies();
    const result = await executeNodeWriteOperation(
      { type: 'node.reparent', nodeUuid: 'node-2', newParentUuid: 'parent-2', siblingIndex: 0 },
      dependencies
    );

    expect(dependencies.calls).toContain('reparentNode:node-2:parent-2:0');
    expect(result.before).toMatchObject({ parentUuid: 'parent-1', stablePath: '/parent-1/node-2' });
    expect(result.after).toMatchObject({ parentUuid: 'parent-2', stablePath: '/parent-2/node-2' });
  });

  it('禁止把父节点挂到自己子孙下形成环', async () => {
    const dependencies = createDependencies();
    // parent-1 是 node-2 的祖先：node-2 → parent-1 构成 REPARENT_CYCLE
    await expect(executeNodeWriteOperation(
      { type: 'node.reparent', nodeUuid: 'parent-1', newParentUuid: 'node-2' },
      dependencies
    )).rejects.toThrow('REPARENT_CYCLE');

    await expect(executeNodeWriteOperation(
      { type: 'node.reparent', nodeUuid: 'node-1', newParentUuid: 'node-1' },
      dependencies
    )).rejects.toThrow('REPARENT_CYCLE');
  });

  it('新父节点不存在时拒绝移动', async () => {
    const dependencies = createDependencies();
    await expect(executeNodeWriteOperation(
      { type: 'node.reparent', nodeUuid: 'node-1', newParentUuid: 'missing-parent' },
      dependencies
    )).rejects.toThrow('NODE_PARENT_NOT_FOUND');
  });
});

describe('node.duplicate', () => {
  it('复制子树并按需改名和移动父节点', async () => {
    const dependencies = createDependencies();
    const result = await executeNodeWriteOperation(
      { type: 'node.duplicate', nodeUuid: 'node-1', parentUuid: 'parent-2', name: 'NodeOneCopy' },
      dependencies
    );

    expect(dependencies.calls).toEqual([
      'getNodeInfo:node-1',
      'duplicateNode:node-1',
      'renameNode:dup-node-1:NodeOneCopy',
      'reparentNode:dup-node-1:parent-2:',
      'getNodeInfo:dup-node-1'
    ]);
    expect(result.nodeUuid).toBe('dup-node-1');
  });

  it('复制后改名/移动失败时清理半成品副本再抛错', async () => {
    const dependencies = createDependencies({ failReparent: true });
    const error = await executeNodeWriteOperation(
      { type: 'node.duplicate', nodeUuid: 'node-1', parentUuid: 'missing-parent' },
      dependencies
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProbeError);
    expect((error as ProbeError).code).toBe('NODE_PARENT_NOT_FOUND');
    expect(dependencies.calls).toContain('removeNode:dup-node-1');
  });
});

describe('node.set_active / set_layer / set_transform', () => {
  it('set_active 返回布尔 before/after', async () => {
    const dependencies = createDependencies();
    const result = await executeNodeWriteOperation(
      { type: 'node.set_active', nodeUuid: 'node-1', active: false },
      dependencies
    );

    expect(result.before).toMatchObject({ active: true });
    expect(result.after).toMatchObject({ active: false });
  });

  it('set_layer 返回层级 before/after', async () => {
    const dependencies = createDependencies();
    const result = await executeNodeWriteOperation(
      { type: 'node.set_layer', nodeUuid: 'node-1', layer: 8 },
      dependencies
    );

    expect(result.before).toMatchObject({ layer: 1 });
    expect(result.after).toMatchObject({ layer: 8 });
  });

  it('set_transform 只写提供的分量并返回前后值', async () => {
    const dependencies = createDependencies();
    const result = await executeNodeWriteOperation(
      { type: 'node.set_transform', nodeUuid: 'node-1', localTransform: { position: { x: 5, y: 6, z: 0 } } },
      dependencies
    );

    expect(dependencies.calls).toContain('setNodeTransform:node-1:{"position":{"x":5,"y":6,"z":0}}');
    expect(result.before).toMatchObject({ position: { x: 1, y: 2, z: 3 } });
    expect(result.after).toMatchObject({ position: { x: 5, y: 6, z: 0 } });
  });
});

interface MockDependencies extends NodeWriterDependencies {
  calls: string[];
}

function createDependencies(options: {
  existingNodes?: string[];
  failReparent?: boolean;
} = {}): MockDependencies {
  const calls: string[] = [];
  const nodes = new Map<string, NodeInfo>();
  const ancestors = new Map<string, string[]>();
  const existing = options.existingNodes ?? ['parent-1', 'parent-2', 'node-1', 'node-2'];
  for (const uuid of existing) {
    nodes.set(uuid, nodeInfo(uuid, uuid === 'node-2' ? 'parent-1' : 'parent-1'));
  }
  ancestors.set('node-1', ['parent-1']);
  ancestors.set('node-2', ['parent-1']);
  ancestors.set('parent-1', []);
  ancestors.set('parent-2', []);

  return {
    calls,
    getNodeInfo: async (uuid) => {
      calls.push(`getNodeInfo:${uuid}`);
      return nodes.get(uuid) ?? null;
    },
    listAncestors: async (uuid) => ancestors.get(uuid) ?? [],
    createNode: async (parentUuid, name) => {
      calls.push(`createNode:${parentUuid}:${name}`);
      nodes.set('new-node-1', nodeInfo('new-node-1', parentUuid, { name }));
      return 'new-node-1';
    },
    removeNode: async (uuid) => {
      calls.push(`removeNode:${uuid}`);
      nodes.delete(uuid);
    },
    renameNode: async (uuid, name) => {
      calls.push(`renameNode:${uuid}:${name}`);
      const info = nodes.get(uuid);
      if (info) nodes.set(uuid, { ...info, name });
    },
    setNodeActive: async (uuid, active) => {
      calls.push(`setNodeActive:${uuid}:${active}`);
      const info = nodes.get(uuid);
      if (info) nodes.set(uuid, { ...info, active });
    },
    setNodeLayer: async (uuid, layer) => {
      calls.push(`setNodeLayer:${uuid}:${layer}`);
      const info = nodes.get(uuid);
      if (info) nodes.set(uuid, { ...info, layer });
    },
    setNodeTransform: async (uuid, transform) => {
      calls.push(`setNodeTransform:${uuid}:${JSON.stringify(transform)}`);
      const info = nodes.get(uuid);
      if (info) {
        nodes.set(uuid, {
          ...info,
          position: transform.position ?? info.position,
          rotation: transform.rotation ?? info.rotation,
          scale: transform.scale ?? info.scale
        });
      }
    },
    reparentNode: async (uuid, newParentUuid, siblingIndex) => {
      calls.push(`reparentNode:${uuid}:${newParentUuid}:${siblingIndex ?? ''}`);
      if (options.failReparent || !nodes.has(newParentUuid)) {
        throw new ProbeError('NODE_PARENT_NOT_FOUND', { parentNodeUuid: newParentUuid });
      }
      const info = nodes.get(uuid);
      if (info) nodes.set(uuid, { ...info, parentUuid: newParentUuid, stablePath: `/${newParentUuid}/${uuid}` });
    },
    duplicateNode: async (uuid) => {
      calls.push(`duplicateNode:${uuid}`);
      if (!nodes.has(uuid)) return null;
      const source = nodes.get(uuid) as NodeInfo;
      nodes.set('dup-node-1', { ...source, uuid: 'dup-node-1' });
      return 'dup-node-1';
    }
  };
}

function nodeInfo(uuid: string, parentUuid: string | null, overrides: Partial<NodeInfo> = {}): NodeInfo {
  return {
    uuid,
    name: uuid === 'node-1' ? 'NodeOne' : `Node-${uuid}`,
    stablePath: `/${parentUuid ?? 'root'}/${uuid}`,
    active: true,
    layer: 1,
    parentUuid,
    position: { x: 1, y: 2, z: 3 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
    ...overrides
  };
}
