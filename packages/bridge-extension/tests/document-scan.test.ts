import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { DocumentSnapshotSchema } from '../../protocol/src/index.js';
import {
  clearDefaultDocumentScanSessions,
  createDocumentScanSessionStore,
  scanCurrentDocument,
  type DocumentScanSource
} from '../src/document-scan.js';

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

  it('从完整节点 Dump 提取 Prefab 实例来源、FileID、节点路径和 Override 统计', async () => {
    const fixture = createDocumentFixture();
    const hierarchyChildren = fixture.hierarchy.children as Record<string, unknown>[];
    hierarchyChildren[0].prefab = {
      state: 2,
      isNested: true,
      assetUuid: 'goods-card-prefab'
    };
    const nodeDump = readFixtureValue(fixture.nodeDumps, 'node-1') as Record<string, unknown>;
    fixture.nodeDumps.set('node-1', {
      ...nodeDump,
      __prefab__: {
        fileId: 'goods-root',
        rootUuid: 'node-1',
        sync: true,
        prefabStateInfo: { state: 2, isNested: true },
        instance: { value: {
          fileId: { value: 'goods-instance' },
          prefabRootNode: { value: { uuid: 'node-0' } },
          propertyOverrides: { value: [{ value: {
            targetInfo: { value: { localID: { value: [{ value: 'goods-root' }] } } },
            propertyPath: { value: [{ value: '_active' }] },
            value: { value: false, type: 'Boolean' }
          } }] },
          targetOverrides: { value: [] },
          mountedChildren: { value: [] },
          mountedComponents: { value: [] },
          removedComponents: { value: [] }
        } }
      }
    });
    const source: DocumentScanSource = {
      queryNodeTree: async () => fixture.hierarchy,
      queryNode: async (nodeUuid) => readFixtureValue(fixture.nodeDumps, nodeUuid),
      queryComponent: async (componentUuid) => readFixtureValue(
        fixture.componentDumps,
        componentUuid
      )
    };

    const snapshot = await scanCurrentDocument({
      mode: 'full',
      pageSize: 100,
      document: {
        assetUuid: 'page-prefab',
        path: 'db://assets/page.prefab',
        filePath: 'E:/project/assets/page.prefab',
        documentType: 'prefab'
      }
    }, source);

    expect(() => DocumentSnapshotSchema.parse(snapshot)).not.toThrow();
    expect(snapshot.prefabInstances).toContainEqual(expect.objectContaining({
      ownerDocumentAssetUuid: 'page-prefab',
      sourcePrefabAssetUuid: 'goods-card-prefab',
      sourceObjectFileId: 'goods-root',
      instanceFileId: 'goods-instance',
      hostNodePath: 'Node 1'
    }));
    expect(snapshot.coverage.prefabInstances).toEqual({ total: 1, resolved: 1 });
    expect(snapshot.coverage.overrides).toEqual({ total: 1, decoded: 1 });
    expect(snapshot.prefabInstances[0].unresolved).not.toContainEqual({
      path: 'sourcePrefabAssetUuid',
      reason: 'SOURCE_PREFAB_ASSET_UUID_MISSING'
    });
  });

  it('把组件 Prefab FileID 写入文档组件 Schema', async () => {
    const fixture = createDocumentFixture();
    const componentDump = readFixtureValue(
      fixture.componentDumps,
      'component-0-0'
    ) as Record<string, unknown>;
    fixture.componentDumps.set('component-0-0', {
      ...componentDump,
      __prefab__: { fileId: 'component-file-id' }
    });
    const source: DocumentScanSource = {
      queryNodeTree: async () => fixture.hierarchy,
      queryNode: async (nodeUuid) => readFixtureValue(fixture.nodeDumps, nodeUuid),
      queryComponent: async (componentUuid) => readFixtureValue(
        fixture.componentDumps,
        componentUuid
      )
    };

    const snapshot = await scanCurrentDocument({ mode: 'full' }, source);

    expect(snapshot.componentSchemas[0]).toMatchObject({
      componentUuid: 'component-0-0',
      componentFileId: 'component-file-id'
    });
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

  it('空固定快照从 offset 0 返回空页而不是游标越界', async () => {
    const sessionStore = createDocumentScanSessionStore();
    const document = {
      assetUuid: 'empty-prefab',
      path: 'db://assets/empty.prefab',
      filePath: 'E:/project/assets/empty.prefab',
      documentType: 'prefab' as const
    };
    const content = {
      document: {
        ...document,
        available: true,
        raw: {}
      },
      revision: 'empty-revision',
      mode: 'summary' as const,
      nodes: [],
      componentSchemas: [],
      prefabInstances: [],
      coverage: {
        nodes: { total: 0, decoded: 0 },
        components: { total: 0, decoded: 0 },
        properties: { total: 0, decoded: 0 },
        references: { total: 0, resolved: 0 },
        prefabInstances: { total: 0, resolved: 0 },
        overrides: { total: 0, decoded: 0 }
      },
      unresolved: [],
      diagnostics: []
    };
    const session = sessionStore.create(content, false);
    const cursor = Buffer.from(JSON.stringify({
      version: 1,
      snapshotId: session.snapshotId,
      revision: content.revision,
      offset: 0,
      pageSize: 100,
      mode: content.mode,
      includeRaw: false,
      document
    }), 'utf8').toString('base64url');
    const source: DocumentScanSource = {
      queryNodeTree: async () => {
        throw new Error('EMPTY_CURSOR_SHOULD_NOT_QUERY_CREATOR');
      },
      queryNode: async () => {
        throw new Error('EMPTY_CURSOR_SHOULD_NOT_QUERY_CREATOR');
      },
      queryComponent: async () => {
        throw new Error('EMPTY_CURSOR_SHOULD_NOT_QUERY_CREATOR');
      }
    };

    try {
      const snapshot = await scanCurrentDocument({ cursor }, source, new Map(), {
        assetUuid: document.assetUuid,
        mode: document.documentType,
        source: 'test',
        failures: []
      }, sessionStore);

      expect(() => DocumentSnapshotSchema.parse(snapshot)).not.toThrow();
      expect(snapshot.page).toEqual({
        offset: 0,
        pageSize: 100,
        totalNodes: 0,
        nextCursor: null
      });
      expect(snapshot.nodes).toEqual([]);
      expect(snapshot.componentSchemas).toEqual([]);
      expect(snapshot.prefabInstances).toEqual([]);
    } finally {
      sessionStore.dispose();
    }
  });

  it('文档 Asset UUID 未确认时也不把当前 Prefab 根误计为嵌套实例', async () => {
    const fixture = createDocumentFixture();
    fixture.hierarchy.prefab = {
      state: 1,
      isNested: false,
      assetUuid: 'owner-prefab'
    };
    const source: DocumentScanSource = {
      queryNodeTree: async () => fixture.hierarchy,
      queryNode: async () => {
        throw new Error('SUMMARY_SHOULD_NOT_QUERY_NODE');
      },
      queryComponent: async () => {
        throw new Error('SUMMARY_SHOULD_NOT_QUERY_COMPONENT');
      }
    };

    const snapshot = await scanCurrentDocument({ mode: 'summary' }, source);

    expect(snapshot.coverage.prefabInstances).toEqual({ total: 0, resolved: 0 });
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

  it('cursor 固定第一页快照，后续页不重新读取 Creator，新的首屏扫描才观察内容变化', async () => {
    const fixture = createDocumentFixture();
    let allowQueries = true;
    const source: DocumentScanSource = {
      queryNodeTree: async () => {
        if (!allowQueries) throw new Error('CURSOR_SHOULD_USE_FIXED_SNAPSHOT');
        return fixture.hierarchy;
      },
      queryNode: async (nodeUuid) => {
        if (!allowQueries) throw new Error('CURSOR_SHOULD_USE_FIXED_SNAPSHOT');
        return readFixtureValue(fixture.nodeDumps, nodeUuid);
      },
      queryComponent: async (componentUuid) => {
        if (!allowQueries) throw new Error('CURSOR_SHOULD_USE_FIXED_SNAPSHOT');
        return readFixtureValue(fixture.componentDumps, componentUuid);
      }
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
    allowQueries = false;

    const secondPage = await scanCurrentDocument({
      cursor: firstPage.page.nextCursor
    }, source);

    expect(secondPage.revision).toBe(firstPage.revision);
    expect(secondPage.nodes[0].identity.objectUuid).toBe('node-10');

    allowQueries = true;
    const refreshedFirstPage = await scanCurrentDocument({
      mode: 'full',
      pageSize: 10
    }, source);
    expect(refreshedFirstPage.revision).not.toBe(firstPage.revision);
    expect(refreshedFirstPage.nodes[0].name).toBe('Changed Root');
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
        reason: 'SNAPSHOT_CONTEXT_CHANGED',
        expectedDocument: { assetUuid: 'document-a' },
        currentDocument: { assetUuid: 'document-b' }
      }
    });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    '拒绝非法快照会话 TTL: %s',
    (ttlMs) => {
      expect(() => createDocumentScanSessionStore({ ttlMs })).toThrowError(
        'INVALID_DOCUMENT_SCAN_SESSION_STORE'
      );
    }
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    '拒绝返回非法时间的快照会话时钟: %s',
    async (currentTime) => {
      vi.useFakeTimers();
      const fixture = createDocumentFixture();
      const sessionStore = createDocumentScanSessionStore({
        now: () => currentTime
      });
      const source: DocumentScanSource = {
        queryNodeTree: async () => fixture.hierarchy,
        queryNode: async () => {
          throw new Error('SUMMARY_SHOULD_NOT_QUERY_NODE');
        },
        queryComponent: async () => {
          throw new Error('SUMMARY_SHOULD_NOT_QUERY_COMPONENT');
        }
      };
      try {
        await expect(scanCurrentDocument({
          mode: 'summary'
        }, source, new Map(), undefined, sessionStore)).rejects.toMatchObject({
          code: 'INVALID_DOCUMENT_SCAN_SESSION_STORE',
          details: { currentTime }
        });
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it('默认会话仓库重置后拒绝卸载中的旧扫描，并允许新生命周期继续扫描', async () => {
    clearDefaultDocumentScanSessions();
    const fixture = createDocumentFixture();
    let resolveHierarchy: ((value: unknown) => void) | null = null;
    const pendingHierarchy = new Promise<unknown>((resolve) => {
      resolveHierarchy = resolve;
    });
    const pendingSource: DocumentScanSource = {
      queryNodeTree: () => pendingHierarchy,
      queryNode: async () => {
        throw new Error('SUMMARY_SHOULD_NOT_QUERY_NODE');
      },
      queryComponent: async () => {
        throw new Error('SUMMARY_SHOULD_NOT_QUERY_COMPONENT');
      }
    };
    const pendingScan = scanCurrentDocument({ mode: 'summary' }, pendingSource);

    clearDefaultDocumentScanSessions();
    resolveHierarchy?.(fixture.hierarchy);

    await expect(pendingScan).rejects.toMatchObject({
      code: 'DOCUMENT_SCAN_SESSION_STORE_DISPOSED'
    });

    const currentSource: DocumentScanSource = {
      queryNodeTree: async () => fixture.hierarchy,
      queryNode: async () => {
        throw new Error('SUMMARY_SHOULD_NOT_QUERY_NODE');
      },
      queryComponent: async () => {
        throw new Error('SUMMARY_SHOULD_NOT_QUERY_COMPONENT');
      }
    };
    const currentSnapshot = await scanCurrentDocument({ mode: 'summary' }, currentSource);
    expect(currentSnapshot.nodes).toHaveLength(74);
    clearDefaultDocumentScanSessions();
  });

  it('clear 主动释放快照会话、取消清理计时器，并让旧 cursor 返回 stale', async () => {
    vi.useFakeTimers();
    const fixture = createDocumentFixture();
    const sessionStore = createDocumentScanSessionStore();
    const source: DocumentScanSource = {
      queryNodeTree: async () => fixture.hierarchy,
      queryNode: async () => {
        throw new Error('SUMMARY_SHOULD_NOT_QUERY_NODE');
      },
      queryComponent: async () => {
        throw new Error('SUMMARY_SHOULD_NOT_QUERY_COMPONENT');
      }
    };
    try {
      const firstPage = await scanCurrentDocument({
        mode: 'summary',
        pageSize: 10
      }, source, new Map(), undefined, sessionStore);

      sessionStore.clear();

      expect(vi.getTimerCount()).toBe(0);
      await expect(scanCurrentDocument({
        cursor: firstPage.page.nextCursor
      }, source, new Map(), undefined, sessionStore)).rejects.toMatchObject({
        code: 'SCAN_CURSOR_STALE',
        details: { reason: 'SNAPSHOT_SESSION_NOT_FOUND' }
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('快照会话无人继续读写时也按 TTL 定时释放', async () => {
    vi.useFakeTimers();
    const fixture = createDocumentFixture();
    const sessionStore = createDocumentScanSessionStore({
      ttlMs: 10,
      now: () => 0
    });
    const source: DocumentScanSource = {
      queryNodeTree: async () => fixture.hierarchy,
      queryNode: async () => {
        throw new Error('SUMMARY_SHOULD_NOT_QUERY_NODE');
      },
      queryComponent: async () => {
        throw new Error('SUMMARY_SHOULD_NOT_QUERY_COMPONENT');
      }
    };
    try {
      const firstPage = await scanCurrentDocument({
        mode: 'summary',
        pageSize: 10
      }, source, new Map(), undefined, sessionStore);

      await vi.advanceTimersByTimeAsync(10);

      expect(vi.getTimerCount()).toBe(0);
      await expect(scanCurrentDocument({
        cursor: firstPage.page.nextCursor
      }, source, new Map(), undefined, sessionStore)).rejects.toMatchObject({
        code: 'SCAN_CURSOR_STALE',
        details: { reason: 'SNAPSHOT_SESSION_NOT_FOUND' }
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('快照会话过期后旧 cursor 返回 stale，且不重新读取 Creator', async () => {
    const fixture = createDocumentFixture();
    let now = 1000;
    let hierarchyQueryCount = 0;
    const sessionStore = createDocumentScanSessionStore({
      ttlMs: 10,
      now: () => now
    });
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
    const firstPage = await scanCurrentDocument({
      mode: 'summary',
      pageSize: 10
    }, source, new Map(), undefined, sessionStore);
    now += 11;

    await expect(scanCurrentDocument({
      cursor: firstPage.page.nextCursor
    }, source, new Map(), undefined, sessionStore)).rejects.toMatchObject({
      code: 'SCAN_CURSOR_STALE',
      details: { reason: 'SNAPSHOT_SESSION_NOT_FOUND' }
    });
    expect(hierarchyQueryCount).toBe(1);
  });

  it('快照会话达到容量上限时逐出最旧会话', async () => {
    const fixture = createDocumentFixture();
    let hierarchyQueryCount = 0;
    const sessionStore = createDocumentScanSessionStore({ maxEntries: 1 });
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
    const firstPage = await scanCurrentDocument({
      mode: 'summary',
      pageSize: 10,
      document: {
        assetUuid: 'document-a',
        path: 'db://assets/ui/A.prefab',
        filePath: 'E:/project/assets/ui/A.prefab',
        documentType: 'prefab'
      }
    }, source, new Map(), undefined, sessionStore);
    await scanCurrentDocument({
      mode: 'summary',
      pageSize: 10,
      document: {
        assetUuid: 'document-b',
        path: 'db://assets/ui/B.prefab',
        filePath: 'E:/project/assets/ui/B.prefab',
        documentType: 'prefab'
      }
    }, source, new Map(), undefined, sessionStore);

    await expect(scanCurrentDocument({
      cursor: firstPage.page.nextCursor
    }, source, new Map(), undefined, sessionStore)).rejects.toMatchObject({
      code: 'SCAN_CURSOR_STALE',
      details: { reason: 'SNAPSHOT_SESSION_NOT_FOUND' }
    });
    expect(hierarchyQueryCount).toBe(2);
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
