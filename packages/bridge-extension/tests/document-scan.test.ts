import { describe, expect, it } from 'vitest';
import { DocumentSnapshotSchema } from '../../protocol/src/index.js';
import { scanCurrentDocument, type DocumentScanSource } from '../src/document-scan.js';

describe('scanCurrentDocument', () => {
  it('按层级顺序完整读取 74 个节点和 212 个组件，并限制 Creator 查询并发', async () => {
    const fixture = createDocumentFixture();
    const activity = createActivityTracker();
    const source: DocumentScanSource = {
      queryNodeTree: async () => fixture.hierarchy,
      queryNode: async (nodeUuid) => activity.run(() => fixture.nodeDumps.get(nodeUuid)),
      queryComponent: async (componentUuid) => activity.run(() => fixture.componentDumps.get(componentUuid))
    };

    const snapshot = await scanCurrentDocument({
      mode: 'full',
      pageSize: 100,
      includeRaw: false,
      concurrency: 3,
      document: {
        assetUuid: null,
        path: null,
        filePath: null,
        documentType: null
      }
    }, source, new Map([
      ['script-uuid', 'db://assets/script/CustomView.ts']
    ]));

    expect(() => DocumentSnapshotSchema.parse(snapshot)).not.toThrow();
    expect(snapshot.coverage).toMatchObject({
      nodes: { total: 74, decoded: 74 },
      components: { total: 212, decoded: 212 },
      properties: { total: 637, decoded: 637 },
      references: { total: 213, resolved: 213 }
    });
    expect(snapshot.nodes).toHaveLength(74);
    expect(snapshot.componentSchemas).toHaveLength(212);
    expect(snapshot.nodes[0]).toMatchObject({
      kind: 'node',
      identity: { objectUuid: 'node-0' },
      name: 'Node 0',
      path: '/'
    });
    expect(snapshot.nodes[73]).toMatchObject({
      identity: { objectUuid: 'node-73' },
      name: 'Node 73'
    });
    expect(snapshot.componentSchemas[0]).toMatchObject({
      componentUuid: 'component-0-0',
      nodeUuid: 'node-0',
      nodePath: '/',
      componentIndex: 0,
      className: 'CustomView',
      scriptUuid: 'script-uuid',
      scriptPath: 'db://assets/script/CustomView.ts'
    });
    const {
      componentUuid: omittedComponentUuid,
      ...componentWithoutUuid
    } = snapshot.componentSchemas[0];
    expect(omittedComponentUuid).toBe('component-0-0');
    expect(() => DocumentSnapshotSchema.parse({
      ...snapshot,
      componentSchemas: [componentWithoutUuid, ...snapshot.componentSchemas.slice(1)]
    })).toThrow();
    expect(snapshot.unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'document.assetUuid', reason: 'PUBLIC_API_NOT_CONFIRMED' }),
      expect.objectContaining({ path: 'document.documentType', reason: 'PUBLIC_API_NOT_CONFIRMED' })
    ]));
    expect(snapshot.raw).toBeUndefined();
    expect(activity.maxActive()).toBeGreaterThan(1);
    expect(activity.maxActive()).toBeLessThanOrEqual(3);
  });

  it('summary 模式只读取层级摘要，不查询节点和组件完整 Dump', async () => {
    const fixture = createDocumentFixture();
    let hierarchyQueryCount = 0;
    const source: DocumentScanSource = {
      queryNodeTree: async () => {
        hierarchyQueryCount += 1;
        return fixture.hierarchy;
      },
      queryNode: async () => {
        throw new Error('SUMMARY_SHOULD_NOT_QUERY_NODE');
      },
      queryComponent: async () => {
        throw new Error('SUMMARY_SHOULD_NOT_QUERY_COMPONENT');
      }
    };

    const snapshot = await scanCurrentDocument({
      mode: 'summary',
      pageSize: 100,
      includeRaw: false
    }, source);

    expect(() => DocumentSnapshotSchema.parse(snapshot)).not.toThrow();
    expect(hierarchyQueryCount).toBe(1);
    expect(snapshot.nodes).toHaveLength(74);
    expect(snapshot.componentSchemas).toEqual([]);
    expect(snapshot.coverage).toMatchObject({
      nodes: { total: 74, decoded: 74 },
      components: { total: 212, decoded: 0 },
      properties: { total: 0, decoded: 0 },
      references: { total: 0, resolved: 0 }
    });
    expect(snapshot.nodes[0]).toMatchObject({
      identity: { objectUuid: 'node-0' },
      name: 'Node 0',
      path: '/',
      active: true
    });
  });

  it('使用 Revision cursor 分页返回节点及其对应组件，并从 cursor 恢复页大小', async () => {
    const fixture = createDocumentFixture();
    const source: DocumentScanSource = {
      queryNodeTree: async () => fixture.hierarchy,
      queryNode: async (nodeUuid) => readFixtureValue(fixture.nodeDumps, nodeUuid),
      queryComponent: async (componentUuid) => readFixtureValue(
        fixture.componentDumps,
        componentUuid
      )
    };

    const firstPage = await scanCurrentDocument({
      mode: 'full',
      pageSize: 10,
      document: {
        assetUuid: 'document-uuid',
        path: 'db://assets/ui/Test.prefab',
        filePath: 'E:/project/assets/ui/Test.prefab',
        documentType: 'prefab'
      }
    }, source);

    expect(firstPage.page).toMatchObject({
      offset: 0,
      pageSize: 10,
      totalNodes: 74,
      nextCursor: expect.any(String)
    });
    expect(firstPage.nodes).toHaveLength(10);
    expect(firstPage.nodes[0].identity.objectUuid).toBe('node-0');
    expect(firstPage.nodes[9].identity.objectUuid).toBe('node-9');
    expect(firstPage.componentSchemas).toHaveLength(30);
    expect(firstPage.componentSchemas[29].nodeUuid).toBe('node-9');

    const secondPage = await scanCurrentDocument({
      cursor: firstPage.page.nextCursor
    }, source);

    expect(secondPage.revision).toBe(firstPage.revision);
    expect(secondPage.mode).toBe('full');
    expect(secondPage.document).toEqual(firstPage.document);
    expect(secondPage.page).toMatchObject({
      offset: 10,
      pageSize: 10,
      totalNodes: 74,
      nextCursor: expect.any(String)
    });
    expect(secondPage.nodes).toHaveLength(10);
    expect(secondPage.nodes[0].identity.objectUuid).toBe('node-10');
    expect(secondPage.nodes[9].identity.objectUuid).toBe('node-19');
    expect(secondPage.componentSchemas).toHaveLength(30);
    expect(secondPage.componentSchemas[0].nodeUuid).toBe('node-10');
    expect(secondPage.unresolved).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'SCRIPT_ASSET_PATH_NOT_FOUND' })
    ]));
  });

  it('文档内容变化后拒绝旧 cursor，并返回 SCAN_CURSOR_STALE', async () => {
    const fixture = createDocumentFixture();
    const source: DocumentScanSource = {
      queryNodeTree: async () => fixture.hierarchy,
      queryNode: async (nodeUuid) => readFixtureValue(fixture.nodeDumps, nodeUuid),
      queryComponent: async (componentUuid) => readFixtureValue(
        fixture.componentDumps,
        componentUuid
      )
    };
    const firstPage = await scanCurrentDocument({
      mode: 'full',
      pageSize: 10
    }, source);
    const originalRootDump = readFixtureValue(fixture.nodeDumps, 'node-0');
    fixture.nodeDumps.set('node-0', {
      ...originalRootDump,
      name: { value: 'Changed Root' }
    });

    await expect(scanCurrentDocument({
      cursor: firstPage.page.nextCursor
    }, source)).rejects.toMatchObject({
      code: 'SCAN_CURSOR_STALE',
      details: {
        expectedRevision: firstPage.revision,
        currentRevision: expect.any(String)
      }
    });
  });

  it('内容相同但文档资产身份变化时也拒绝旧 cursor', async () => {
    const fixture = createDocumentFixture();
    const source: DocumentScanSource = {
      queryNodeTree: async () => fixture.hierarchy,
      queryNode: async () => {
        throw new Error('SUMMARY_SHOULD_NOT_QUERY_NODE');
      },
      queryComponent: async () => {
        throw new Error('SUMMARY_SHOULD_NOT_QUERY_COMPONENT');
      }
    };
    const firstPage = await scanCurrentDocument({
      mode: 'summary',
      pageSize: 10,
      document: {
        assetUuid: 'document-a',
        path: 'db://assets/ui/A.prefab',
        filePath: 'E:/project/assets/ui/A.prefab',
        documentType: 'prefab'
      }
    }, source);

    await expect(scanCurrentDocument({
      cursor: firstPage.page.nextCursor,
      document: {
        assetUuid: 'document-b',
        path: 'db://assets/ui/B.prefab',
        filePath: 'E:/project/assets/ui/B.prefab',
        documentType: 'prefab'
      }
    }, source)).rejects.toMatchObject({
      code: 'SCAN_CURSOR_STALE',
      details: {
        expectedRevision: firstPage.revision,
        currentRevision: expect.any(String)
      }
    });
  });

  it('全量扫描期间层级变化时拒绝混合快照', async () => {
    const fixture = createDocumentFixture();
    const changedHierarchy = {
      ...fixture.hierarchy,
      name: 'Changed During Scan'
    };
    let hierarchyQueryCount = 0;
    const source: DocumentScanSource = {
      queryNodeTree: async () => {
        hierarchyQueryCount += 1;
        return hierarchyQueryCount === 1 ? fixture.hierarchy : changedHierarchy;
      },
      queryNode: async (nodeUuid) => readFixtureValue(fixture.nodeDumps, nodeUuid),
      queryComponent: async (componentUuid) => readFixtureValue(
        fixture.componentDumps,
        componentUuid
      )
    };

    await expect(scanCurrentDocument({
      mode: 'full',
      pageSize: 100
    }, source)).rejects.toMatchObject({
      code: 'DOCUMENT_CHANGED_DURING_SCAN',
      details: {
        initialHierarchyRevision: expect.any(String),
        currentHierarchyRevision: expect.any(String)
      }
    });
    expect(hierarchyQueryCount).toBe(2);
  });

  it('Creator 节点查询失败时停止继续调度，并返回节点上下文', async () => {
    const fixture = createDocumentFixture();
    let nodeQueryCount = 0;
    let componentQueryCount = 0;
    const source: DocumentScanSource = {
      queryNodeTree: async () => fixture.hierarchy,
      queryNode: async (nodeUuid) => {
        nodeQueryCount += 1;
        if (nodeUuid === 'node-1') throw new Error('SCENE_BUSY');
        await new Promise((resolve) => setTimeout(resolve, 5));
        return readFixtureValue(fixture.nodeDumps, nodeUuid);
      },
      queryComponent: async (componentUuid) => {
        componentQueryCount += 1;
        return readFixtureValue(fixture.componentDumps, componentUuid);
      }
    };

    await expect(scanCurrentDocument({
      mode: 'full',
      concurrency: 2
    }, source)).rejects.toMatchObject({
      code: 'DOCUMENT_NODE_QUERY_FAILED',
      details: {
        nodeUuid: 'node-1',
        reason: 'SCENE_BUSY'
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(nodeQueryCount).toBeLessThanOrEqual(2);
    expect(componentQueryCount).toBe(0);
  });

  it('Creator 组件查询失败时停止继续调度，并返回组件上下文', async () => {
    const fixture = createDocumentFixture();
    let componentQueryCount = 0;
    const source: DocumentScanSource = {
      queryNodeTree: async () => fixture.hierarchy,
      queryNode: async (nodeUuid) => readFixtureValue(fixture.nodeDumps, nodeUuid),
      queryComponent: async (componentUuid) => {
        componentQueryCount += 1;
        if (componentUuid === 'component-0-1') throw new Error('SCENE_BUSY');
        await new Promise((resolve) => setTimeout(resolve, 5));
        return readFixtureValue(fixture.componentDumps, componentUuid);
      }
    };

    await expect(scanCurrentDocument({
      mode: 'full',
      concurrency: 2
    }, source)).rejects.toMatchObject({
      code: 'DOCUMENT_COMPONENT_QUERY_FAILED',
      details: {
        componentUuid: 'component-0-1',
        nodeUuid: 'node-0',
        componentIndex: 1,
        reason: 'SCENE_BUSY'
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(componentQueryCount).toBeLessThanOrEqual(2);
  });

  it('拒绝非法扫描模式，且不调用 Creator 查询', async () => {
    let hierarchyQueryCount = 0;
    const source: DocumentScanSource = {
      queryNodeTree: async () => {
        hierarchyQueryCount += 1;
        return {};
      },
      queryNode: async () => ({}),
      queryComponent: async () => ({})
    };

    await expect(scanCurrentDocument({
      mode: 'detail' as unknown as 'full'
    }, source)).rejects.toMatchObject({
      code: 'INVALID_DOCUMENT_SCAN_MODE',
      details: { mode: 'detail' }
    });
    expect(hierarchyQueryCount).toBe(0);
  });
});

function createDocumentFixture(): {
  hierarchy: Record<string, unknown>;
  nodeDumps: Map<string, unknown>;
  componentDumps: Map<string, unknown>;
} {
  const nodeDumps = new Map<string, unknown>();
  const componentDumps = new Map<string, unknown>();
  const children: Record<string, unknown>[] = [];

  for (let nodeIndex = 0; nodeIndex < 74; nodeIndex += 1) {
    const nodeUuid = `node-${nodeIndex}`;
    const componentCount = nodeIndex < 64 ? 3 : 2;
    const componentSummaries: Record<string, unknown>[] = [];
    for (let componentIndex = 0; componentIndex < componentCount; componentIndex += 1) {
      const componentUuid = `component-${nodeIndex}-${componentIndex}`;
      const isCustom = nodeIndex === 0 && componentIndex === 0;
      componentSummaries.push({
        isCustom,
        type: isCustom ? 'CustomView' : 'cc.UITransform',
        value: componentUuid,
        extends: isCustom
          ? ['cc.Component', 'cc.Object']
          : ['cc.Component', 'cc.Object']
      });
      componentDumps.set(componentUuid, createComponentDump(
        componentUuid,
        nodeUuid,
        isCustom
      ));
    }

    const summary = {
      name: `Node ${nodeIndex}`,
      active: true,
      locked: false,
      type: nodeIndex === 0 ? 'cc.Scene' : 'cc.Node',
      uuid: nodeUuid,
      children: [],
      prefab: {
        state: 0,
        isNested: false,
        assetUuid: ''
      },
      parent: nodeIndex === 0 ? '' : 'node-0',
      path: nodeIndex === 0 ? '/' : `Node ${nodeIndex}`,
      isScene: nodeIndex === 0,
      readonly: false,
      components: componentSummaries
    };
    if (nodeIndex > 0) children.push(summary);
    nodeDumps.set(nodeUuid, {
      uuid: { value: nodeUuid },
      name: { value: `Node ${nodeIndex}` },
      active: { value: true },
      layer: { value: 1 },
      position: { value: { x: nodeIndex, y: 0, z: 0 } },
      rotation: { value: { x: 0, y: 0, z: 0, w: 1 } },
      scale: { value: { x: 1, y: 1, z: 1 } },
      parent: { value: nodeIndex === 0 ? null : { uuid: 'node-0' } },
      children: nodeIndex === 0
        ? Array.from({ length: 73 }, (_, index) => ({ uuid: `node-${index + 1}` }))
        : [],
      __type__: nodeIndex === 0 ? 'cc.Scene' : 'cc.Node',
      __comps__: []
    });
  }

  return {
    hierarchy: {
      name: 'Node 0',
      active: true,
      locked: false,
      type: 'cc.Scene',
      uuid: 'node-0',
      children,
      prefab: { state: 0, isNested: false, assetUuid: '' },
      parent: '',
      path: '/',
      isScene: true,
      readonly: false,
      components: Array.from({ length: 3 }, (_, componentIndex) => ({
        isCustom: componentIndex === 0,
        type: componentIndex === 0 ? 'CustomView' : 'cc.UITransform',
        value: `component-0-${componentIndex}`,
        extends: ['cc.Component', 'cc.Object']
      }))
    },
    nodeDumps,
    componentDumps
  };
}

function createComponentDump(
  componentUuid: string,
  nodeUuid: string,
  isCustom: boolean
): Record<string, unknown> {
  const values: Record<string, unknown> = {
    uuid: { value: componentUuid, type: 'String', visible: false, readonly: false },
    node: {
      value: { uuid: nodeUuid },
      default: null,
      type: 'cc.Node',
      visible: false,
      readonly: false,
      extends: ['cc.Object']
    },
    enabled: { value: true, default: true, type: 'Boolean', visible: true, readonly: false }
  };
  if (isCustom) {
    values.__scriptAsset = {
      value: { uuid: 'script-uuid' },
      type: 'cc.Script',
      visible: true,
      readonly: true,
      extends: ['cc.Asset', 'cc.Object']
    };
  }
  return {
    value: values,
    type: isCustom ? 'CustomView' : 'cc.UITransform',
    cid: isCustom ? 'custom-type-id' : 'cc.UITransform',
    extends: ['cc.Component', 'cc.Object']
  };
}

function readFixtureValue<T>(values: Map<string, T>, key: string): T {
  const value = values.get(key);
  if (value === undefined) throw new Error(`fixture value missing: ${key}`);
  return value;
}

function createActivityTracker(): {
  run: <T>(readValue: () => T | undefined) => Promise<T>;
  maxActive: () => number;
} {
  let active = 0;
  let maximum = 0;
  return {
    run: async <T>(readValue: () => T | undefined): Promise<T> => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      const value = readValue();
      active -= 1;
      if (value === undefined) throw new Error('fixture value missing');
      return value;
    },
    maxActive: () => maximum
  };
}
