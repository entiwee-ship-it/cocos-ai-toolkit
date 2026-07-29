import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCommand } from '../src/commands.js';
import {
  designApplyExitCode,
  executeCommand,
  assertDesignWriteDocumentIdentity,
  readCurrentWriteRevision,
  resolveDesignSourceAssetPath,
  restoreDesignWriteDocument,
  summarizeDesignSnapshot,
  verifyPlanItemFromSnapshot
} from '../src/index.js';

const TARGET_JSON = JSON.stringify({
  document: { scope: 'current-document' },
  tree: [{
    id: '$root', name: 'root',
    children: [{ id: '$label', name: 'label', components: [{ type: 'cc.Label', properties: { fontSize: 28 } }] }]
  }]
});

const COMPONENT_TARGET_JSON = JSON.stringify({
  document: { scope: 'current-document' },
  tree: [{ id: '$root', name: 'root', components: [{ type: 'cc.Button' }] }]
});

const SCRIPT_COMPONENT_TARGET_JSON = JSON.stringify({
  document: { scope: 'current-document' },
  tree: [{ id: '$root', name: 'root', components: [{ type: 'GameLogic', scriptUuid: 'script-game' }] }]
});

const SOURCE_TARGET_JSON = JSON.stringify({
  document: { scope: 'source-prefab', assetUuid: 'prefab-source' },
  tree: [{ id: '$root', name: 'root' }]
});

const APPLY_SOURCE_TARGET_JSON = JSON.stringify({
  document: { scope: 'apply-to-source', assetUuid: 'prefab-source' },
  tree: [{ id: '$root', name: 'root' }]
});

const REVISION_JSON = JSON.stringify({
  document: 'sha256:document',
  hierarchy: 'sha256:hierarchy',
  assetDatabase: null,
  scriptCompilation: null,
  prefabGraph: 'sha256:prefab-graph'
});

describe('声明式 CLI 命令', () => {
  it('解析 design-inspect / design-plan / design-preview / design-verify / design-export / design-apply', () => {
    expect(parseCommand([
      'write-revision', '--project-id', 'project-1'
    ])).toEqual({ command: 'write-revision', projectId: 'project-1' });
    expect(parseCommand([
      'design-inspect', '--project-id', 'project-1', '--root-uuid', 'node-root'
    ])).toEqual({
      command: 'design-inspect', projectId: 'project-1', rootUuid: 'node-root'
    });
    expect(parseCommand([
      'design-plan', '--project-id', 'project-1', '--target', TARGET_JSON
    ])).toMatchObject({ command: 'design-plan', projectId: 'project-1' });
    expect(parseCommand([
      'design-preview', '--project-id', 'project-1', '--target', TARGET_JSON
    ])).toMatchObject({ command: 'design-preview', projectId: 'project-1' });
    expect(parseCommand([
      'design-verify', '--project-id', 'project-1', '--target', TARGET_JSON
    ])).toMatchObject({ command: 'design-verify', projectId: 'project-1' });
    expect(parseCommand([
      'design-export', '--project-id', 'project-1', '--root-uuid', 'node-root',
      '--scope', 'current-document', '--asset-uuid', 'scene-1'
    ])).toEqual({
      command: 'design-export', projectId: 'project-1', rootUuid: 'node-root',
      scope: 'current-document', assetUuid: 'scene-1'
    });
    expect(parseCommand([
      'design-apply', '--project-id', 'project-1', '--target', TARGET_JSON,
      '--execution-id', 'apply-1'
    ])).toMatchObject({
      command: 'design-apply', projectId: 'project-1', executionId: 'apply-1'
    });
  });

  it('拒绝非法目标 JSON 与不合规逻辑 ID', () => {
    expect(() => parseCommand([
      'design-plan', '--project-id', 'project-1', '--target', '{'
    ])).toThrow('INVALID_DESIGN_TARGET_JSON');
    expect(() => parseCommand([
      'design-plan', '--project-id', 'project-1', '--target', JSON.stringify({
        document: { scope: 'current-document' }, tree: [{ id: 'root', name: 'root' }]
      })
    ])).toThrow('INVALID_DESIGN_TARGET');
    expect(() => parseCommand([
      'design-plan', '--project-id', 'project-1', '--target', JSON.stringify({
        document: { scope: 'current-document' },
        tree: [{ id: '$root', components: [{ type: 'cc.Button' }, { type: 'cc.Button' }] }]
      })
    ])).toThrow('INVALID_DESIGN_TARGET');
  });

  it('跨文档 apply 必须显式提供五维 revision', () => {
    expect(() => parseCommand([
      'design-apply', '--project-id', 'project-1', '--target', SOURCE_TARGET_JSON
    ])).toThrow('DESIGN_REVISION_REQUIRED');

    expect(parseCommand([
      'design-apply', '--project-id', 'project-1', '--target', SOURCE_TARGET_JSON,
      '--revision', REVISION_JSON
    ])).toMatchObject({
      command: 'design-apply',
      revision: {
        document: 'sha256:document',
        hierarchy: 'sha256:hierarchy',
        prefabGraph: 'sha256:prefab-graph'
      }
    });
  });

  it('source-prefab 目标资产必须等于当前打开文档资产', async () => {
    const client = createDesignClient();

    await expect(executeCommand(
      parseCommand([
        'design-apply', '--project-id', 'project-1', '--target', SOURCE_TARGET_JSON,
        '--revision', REVISION_JSON
      ]),
      client
    )).rejects.toThrow('SOURCE_PREFAB_DOCUMENT_MISMATCH');

    expect(client.methods).toEqual(['probe.documentSnapshot']);
  });

  it('source-prefab 即使 UUID 相同也拒绝把 Scene 当作源 Prefab', async () => {
    const client = createDesignClient();
    const sceneTarget = JSON.stringify({
      document: { scope: 'source-prefab', assetUuid: 'scene-1' },
      tree: [{ id: '$root', name: 'root' }]
    });

    await expect(executeCommand(
      parseCommand([
        'design-apply', '--project-id', 'project-1', '--target', sceneTarget,
        '--revision', REVISION_JSON
      ]),
      client
    )).rejects.toThrow('SOURCE_PREFAB_DOCUMENT_REQUIRED');

    expect(client.methods).toEqual(['probe.documentSnapshot']);
  });

  it('跨文档执行前拒绝当前写文档身份已切换', () => {
    expect(() => assertDesignWriteDocumentIdentity('scene-1', {
      documentId: 'scene-other',
      revision: {
        document: 'sha256:doc', hierarchy: 'sha256:hier',
        assetDatabase: null, scriptCompilation: null, prefabGraph: 'sha256:prefab'
      }
    })).toThrow('DESIGN_WRITE_DOCUMENT_CHANGED');
  });

  it('Prefab 图扫描后重新打开并核对最初设计文档', async () => {
    let stateReadCount = 0;
    const client: DesignClient = {
      methods: [],
      async request(method) {
        this.methods.push(method);
        if (method === 'probe.openAsset') return { opened: true, uuid: 'scene-1' };
        if (method === 'probe.editorState') {
          stateReadCount += 1;
          return { ready: { scene: stateReadCount > 1, assetDatabase: true } };
        }
        if (method === 'probe.writeRevision') {
          return {
            documentId: 'scene-1',
            revision: {
              document: 'sha256:doc', hierarchy: 'sha256:hier',
              assetDatabase: null, scriptCompilation: null, prefabGraph: 'sha256:prefab'
            }
          };
        }
        throw new Error(`UNEXPECTED_METHOD:${method}`);
      }
    };

    await expect(restoreDesignWriteDocument(
      client,
      { projectId: 'project-1' },
      'scene-1'
    )).resolves.toMatchObject({ documentId: 'scene-1' });
    expect(client.methods).toEqual([
      'probe.openAsset', 'probe.editorState', 'probe.editorState', 'probe.writeRevision'
    ]);
  });

  it('Prefab 图扫描失败时也恢复最初设计文档', async () => {
    const snapshot = createSnapshot();
    snapshot.document = {
      ...snapshot.document,
      assetUuid: 'prefab-source',
      path: 'db://assets/source.prefab',
      filePath: 'E:/project/assets/source.prefab',
      documentType: 'prefab'
    };
    const client: DesignClient = {
      methods: [],
      async request(method) {
        this.methods.push(method);
        if (method === 'probe.documentSnapshot') return snapshot;
        if (method === 'server.editors') throw new Error('SCAN_FAILED');
        if (method === 'probe.openAsset') return { opened: true, uuid: 'prefab-source' };
        if (method === 'probe.editorState') {
          return { ready: { scene: true, assetDatabase: true } };
        }
        if (method === 'probe.writeRevision') {
          return {
            documentId: 'prefab-source',
            revision: {
              document: 'sha256:doc', hierarchy: 'sha256:hier',
              assetDatabase: null, scriptCompilation: null, prefabGraph: 'sha256:prefab'
            }
          };
        }
        throw new Error(`UNEXPECTED_METHOD:${method}`);
      }
    };

    await expect(executeCommand(
      parseCommand(['design-plan', '--project-id', 'project-1', '--target', SOURCE_TARGET_JSON]),
      client
    )).rejects.toThrow('SCAN_FAILED');
    expect(client.methods).toEqual([
      'probe.documentSnapshot', 'server.editors',
      'probe.openAsset', 'probe.editorState', 'probe.writeRevision'
    ]);
  });

  it('跨文档影响扫描前要求初始文档具备资产 UUID', async () => {
    const snapshot = createSnapshot();
    snapshot.document = { ...snapshot.document, assetUuid: null };
    const client: DesignClient = {
      methods: [],
      async request(method) {
        this.methods.push(method);
        if (method === 'probe.documentSnapshot') return snapshot;
        throw new Error(`UNEXPECTED_SCAN:${method}`);
      }
    };

    await expect(executeCommand(
      parseCommand(['design-plan', '--project-id', 'project-1', '--target', APPLY_SOURCE_TARGET_JSON]),
      client
    )).rejects.toThrow('DESIGN_WRITE_DOCUMENT_IDENTITY_REQUIRED');
    expect(client.methods).toEqual(['probe.documentSnapshot']);
  });

  it('apply-to-source 影响分析使用源 Prefab 路径而不是当前 Scene 路径', () => {
    expect(resolveDesignSourceAssetPath(
      { scope: 'apply-to-source', assetUuid: 'prefab-source' },
      {
        assetUuid: 'scene-1',
        path: 'db://assets/main.scene',
        filePath: 'E:/project/assets/main.scene',
        documentType: 'scene',
        available: true,
        raw: {}
      },
      {
        nodes: [
          { assetUuid: 'scene-1', path: 'db://assets/main.scene', documentType: 'scene' },
          { assetUuid: 'prefab-source', path: 'db://assets/panel.prefab', documentType: 'prefab' }
        ],
        edges: [],
        targetMap: { targets: {}, children: {} },
        unresolved: [],
        diagnostics: []
      }
    )).toBe('db://assets/panel.prefab');
  });

  it('inspect 输出结构、组件、覆盖风险摘要，且只走只读请求', async () => {
    const client = createDesignClient();
    const result = await executeCommand(
      parseCommand(['design-inspect', '--project-id', 'project-1']),
      client
    ) as Record<string, unknown>;

    expect(result).toMatchObject({
      revision: 'revision-1',
      tree: [{
        uuid: 'node-root', name: 'root',
        children: [{
          uuid: 'node-label', name: 'label',
          components: [{ type: 'cc.Label', properties: { fontSize: 24 } }]
        }]
      }]
    });
    expect(client.methods).toEqual(['probe.documentSnapshot']);
  });

  it('inspect 从真实 Bridge 顶层 componentSchemas 还原组件和属性', () => {
    const result = summarizeDesignSnapshot(createBridgeComponentSnapshot());

    expect(result.tree[0].children[0].components).toEqual([expect.objectContaining({
      uuid: 'component-label',
      type: 'cc.Label',
      properties: { fontSize: 24 }
    })]);
  });

  it('inspect 把数组内引用按嵌套属性路径从顶层 componentSchemas 还原', () => {
    const snapshot = createBridgeComponentSnapshot();
    const schema = snapshot.componentSchemas[0] as {
      properties: Array<Record<string, unknown>>;
    };
    schema.properties.push({
      propertyPath: 'targets',
      serializedName: 'targets',
      displayName: 'Targets',
      declaredType: 'cc.Node',
      actualType: 'Array',
      valueKind: 'array',
      nullable: false,
      serializable: true,
      visible: true,
      readonly: false,
      defaultValue: [],
      currentValue: [{
        value: { uuid: 'node-root' },
        type: 'cc.Node',
        extends: ['cc.Object']
      }],
      references: [{
        kind: 'node', objectUuid: 'node-root', fileId: 'file-root',
        nodePath: 'root', available: true
      }],
      inspectorMetadata: {},
      rawClassAttributes: {
        name: 'targets',
        value: [{
          value: { uuid: 'node-root' },
          type: 'cc.Node',
          extends: ['cc.Object']
        }],
        type: 'cc.Node',
        isArray: true,
        extends: ['cc.Object']
      },
      rawConsumedKeys: []
    });

    const result = summarizeDesignSnapshot(snapshot);
    expect(result.tree[0].children[0].components[0]).toMatchObject({
      properties: { targets: expect.any(Array) },
      references: {
        'targets[0]': {
          kind: 'node', objectUuid: 'node-root', fileId: 'file-root',
          nodePath: 'root', available: true
        }
      }
    });
  });

  it('plan 复用差异与排序引擎，preview 只渲染而不执行写请求', async () => {
    const planClient = createDesignClient();
    const plan = await executeCommand(
      parseCommand(['design-plan', '--project-id', 'project-1', '--target', TARGET_JSON]),
      planClient
    ) as { items: Array<Record<string, unknown>> };
    expect(plan.items).toContainEqual(expect.objectContaining({
      kind: 'component.set_property', target: '$label', propertyPath: 'fontSize', value: 28
    }));

    const previewClient = createDesignClient();
    const preview = await executeCommand(
      parseCommand(['design-preview', '--project-id', 'project-1', '--target', TARGET_JSON]),
      previewClient
    ) as { mode: string; operationCount: number; operations: Array<Record<string, unknown>> };
    expect(preview).toMatchObject({ mode: 'preview', operationCount: 1 });
    expect(preview.operations[0]).toMatchObject({
      kind: 'component.set_property', target: '$label'
    });
    expect([...planClient.methods, ...previewClient.methods]).not.toContain('probe.writePrepare');
    expect([...planClient.methods, ...previewClient.methods]).not.toContain('probe.writeConfirm');
  });

  it('verify 与 export 都只重读快照，导出结果可直接作为目标文档', async () => {
    const verifyClient = createDesignClient();
    const verifyTarget = JSON.stringify({
      document: { scope: 'current-document', assetUuid: 'scene-1' },
      tree: [{
        id: '$root', fileId: 'file-root', name: 'root',
        children: [{
          id: '$label', fileId: 'file-label', name: 'label',
          components: [{ type: 'cc.Label', properties: { fontSize: 24 } }]
        }]
      }]
    });
    const report = await executeCommand(
      parseCommand(['design-verify', '--project-id', 'project-1', '--target', verifyTarget]),
      verifyClient
    ) as { passed: boolean; items: Array<{ passed: boolean }> };
    expect(report.passed).toBe(true);
    expect(report.items.every((item) => item.passed)).toBe(true);

    const exportClient = createDesignClient();
    const exported = await executeCommand(
      parseCommand(['design-export', '--project-id', 'project-1', '--root-uuid', 'node-root']),
      exportClient
    ) as { document: { scope: string; assetUuid?: string }; tree: Array<{ id: string; children?: unknown[] }> };
    expect(exported).toMatchObject({
      document: { scope: 'current-document', assetUuid: 'scene-1' },
      tree: [{ id: '$node-file-root', children: [{ id: '$node-file-label' }] }]
    });
    expect(exportClient.methods).toEqual(['probe.documentSnapshot']);
  });

  it('apply 经写事务通道执行、独立重读验证并写入 journal', async () => {
    const journalRoot = await mkdtemp(join(tmpdir(), 'cocos-ai-design-apply-'));
    try {
      const client = createDesignApplyClient();
      const result = await executeCommand(
        parseCommand([
          'design-apply', '--project-id', 'project-1', '--target', TARGET_JSON,
          '--execution-id', 'apply-1'
        ]),
        client,
        undefined,
        { journalRoot }
      ) as { status: string; verification: { passed: boolean } };

      expect(result).toMatchObject({ status: 'committed', verification: { passed: true } });
      expect(client.methods).toEqual([
        'probe.documentSnapshot',
        'probe.writePrepare',
        'probe.writeConfirm',
        'probe.documentSnapshot'
      ]);
      const journal = (await readFile(
        join(journalRoot, 'write-journal', 'apply-1-001.jsonl'),
        'utf8'
      )).trim().split('\n').map((line) => JSON.parse(line) as { event: string });
      expect(journal.map((entry) => entry.event)).toEqual(['write-prepare', 'write-confirm']);
    } finally {
      await rm(journalRoot, { recursive: true, force: true });
    }
  });

  it('apply 只有 committed 结果返回成功退出码', () => {
    expect(designApplyExitCode({ status: 'committed' })).toBe(0);
    expect(designApplyExitCode({ status: 'failed' })).toBe(1);
    expect(designApplyExitCode({ status: 'rolled-back' })).toBe(1);
    expect(designApplyExitCode({ status: 'manual-recovery-required' })).toBe(1);
  });

  it('confirm 审计失败后保留干净回滚结果并报告审计缺口', async () => {
    const journalRoot = await mkdtemp(join(tmpdir(), 'cocos-ai-design-audit-failure-'));
    try {
      const client = createAuditFailureApplyClient(journalRoot);
      const result = await executeCommand(
        parseCommand([
          'design-apply', '--project-id', 'project-1', '--target', TARGET_JSON,
          '--execution-id', 'apply-audit-failure'
        ]),
        client,
        undefined,
        { journalRoot }
      ) as { status: string; auditFailures: Array<{ phase: string }> };

      expect(result.status).toBe('rolled-back');
      expect(result.auditFailures.map((failure) => failure.phase)).toEqual(['confirm', 'rollback']);
      expect(client.methods).toContain('probe.transactionRollback');
    } finally {
      await rm(journalRoot, { recursive: true, force: true });
    }
  });

  it('confirm 返回 failed 且 journal 失败时仍记录审计缺口', async () => {
    const journalRoot = await mkdtemp(join(tmpdir(), 'cocos-ai-design-failed-audit-'));
    try {
      const client = createFailedAuditApplyClient(journalRoot);
      const result = await executeCommand(
        parseCommand([
          'design-apply', '--project-id', 'project-1', '--target', TARGET_JSON,
          '--execution-id', 'apply-failed-audit'
        ]),
        client,
        undefined,
        { journalRoot }
      ) as { status: string; auditFailures: Array<{ phase: string }> };

      expect(result.status).toBe('failed');
      expect(result.auditFailures).toMatchObject([{ phase: 'confirm' }]);
    } finally {
      await rm(journalRoot, { recursive: true, force: true });
    }
  });

  it('prepare 已 validated 但 journal 失败时要求人工恢复并保留审计缺口', async () => {
    const journalRoot = await mkdtemp(join(tmpdir(), 'cocos-ai-design-prepare-audit-'));
    try {
      await writeFile(join(journalRoot, 'write-journal'), 'blocked\n', 'utf8');
      const client = createDesignApplyClient();
      const result = await executeCommand(
        parseCommand([
          'design-apply', '--project-id', 'project-1', '--target', TARGET_JSON,
          '--execution-id', 'apply-prepare-audit'
        ]),
        client,
        undefined,
        { journalRoot }
      ) as { status: string; auditFailures: Array<{ phase: string }> };

      expect(result.status).toBe('manual-recovery-required');
      expect(result.auditFailures).toMatchObject([{ phase: 'prepare' }]);
      expect(client.methods).toEqual(['probe.documentSnapshot', 'probe.writePrepare']);
    } finally {
      await rm(journalRoot, { recursive: true, force: true });
    }
  });

  it('组件提交后出现多个同类型新实例时拒绝猜测 UUID 并回滚', async () => {
    const journalRoot = await mkdtemp(join(tmpdir(), 'cocos-ai-design-component-'));
    try {
      const client = createAmbiguousComponentApplyClient();
      const result = await executeCommand(
        parseCommand([
          'design-apply', '--project-id', 'project-1', '--target', COMPONENT_TARGET_JSON,
          '--execution-id', 'apply-component-ambiguous'
        ]),
        client,
        undefined,
        { journalRoot }
      ) as { status: string; failedStep: { code: string } };

      expect(result).toMatchObject({
        status: 'rolled-back',
        failedStep: { code: 'CREATED_COMPONENT_NOT_FOUND' }
      });
      expect(client.methods).toContain('probe.transactionRollback');
    } finally {
      await rm(journalRoot, { recursive: true, force: true });
    }
  });

  it('component.add 从真实 Bridge 顶层 componentSchemas 解析新组件 UUID', async () => {
    const journalRoot = await mkdtemp(join(tmpdir(), 'cocos-ai-design-bridge-component-'));
    try {
      const client = createBridgeComponentApplyClient();
      const result = await executeCommand(
        parseCommand([
          'design-apply', '--project-id', 'project-1', '--target', COMPONENT_TARGET_JSON,
          '--execution-id', 'apply-bridge-component'
        ]),
        client,
        undefined,
        { journalRoot }
      ) as { status: string; resolutions: { components: Record<string, string> } };

      expect(result).toMatchObject({
        status: 'committed',
        resolutions: { components: { '$root::cc.Button': 'component-button' } }
      });
      expect(client.methods).not.toContain('probe.transactionRollback');
    } finally {
      await rm(journalRoot, { recursive: true, force: true });
    }
  });

  it('自定义脚本计划先核对脚本资产，再由 component.add 守卫完成编译等待', async () => {
    const journalRoot = await mkdtemp(join(tmpdir(), 'cocos-ai-design-script-'));
    try {
      const client = createScriptComponentApplyClient();
      const result = await executeCommand(
        parseCommand([
          'design-apply', '--project-id', 'project-1', '--target', SCRIPT_COMPONENT_TARGET_JSON,
          '--execution-id', 'apply-script'
        ]),
        client,
        undefined,
        { journalRoot }
      ) as { status: string };

      expect(result.status).toBe('committed');
      expect(client.methods).toEqual([
        'probe.documentSnapshot',
        'probe.assetIndex',
        'probe.writePrepare',
        'probe.writeConfirm',
        'probe.documentSnapshot'
      ]);
    } finally {
      await rm(journalRoot, { recursive: true, force: true });
    }
  });

  it('component.add 提交后不允许把既有组件 UUID 当作新组件', async () => {
    const journalRoot = await mkdtemp(join(tmpdir(), 'cocos-ai-design-existing-component-'));
    try {
      const client = createExistingComponentMasqueradeClient();
      const result = await executeCommand(
        parseCommand([
          'design-apply', '--project-id', 'project-1', '--target', COMPONENT_TARGET_JSON,
          '--execution-id', 'apply-existing-component'
        ]),
        client,
        undefined,
        { journalRoot }
      ) as { status: string; failedStep: { code: string } };

      expect(result).toMatchObject({
        status: 'rolled-back',
        failedStep: { code: 'CREATED_COMPONENT_NOT_FOUND' }
      });
    } finally {
      await rm(journalRoot, { recursive: true, force: true });
    }
  });

  it('通过只读 Bridge 能力刷新五维 write revision', async () => {
    const client: DesignClient = {
      methods: [],
      async request(method) {
        this.methods.push(method);
        return {
          documentId: 'prefab-source',
          revision: {
            document: 'sha256:doc-1', hierarchy: 'sha256:hier-1',
            assetDatabase: null, scriptCompilation: null, prefabGraph: 'sha256:prefab-1'
          }
        };
      }
    };

    await expect(readCurrentWriteRevision(
      client,
      { projectId: 'project-1' }
    )).resolves.toMatchObject({ document: 'sha256:doc-1', prefabGraph: 'sha256:prefab-1' });
    expect(client.methods).toEqual(['probe.writeRevision']);
  });

  it('公开 write-revision 命令返回当前写文档身份与五维 revision', async () => {
    const client: DesignClient = {
      methods: [],
      async request(method) {
        this.methods.push(method);
        return {
          documentId: 'scene-1',
          revision: {
            document: 'sha256:doc', hierarchy: 'sha256:hier',
            assetDatabase: null, scriptCompilation: null, prefabGraph: 'sha256:prefab'
          }
        };
      }
    };

    await expect(executeCommand(
      parseCommand(['write-revision', '--project-id', 'project-1']),
      client
    )).resolves.toMatchObject({
      documentId: 'scene-1',
      revision: { document: 'sha256:doc', prefabGraph: 'sha256:prefab' }
    });
    expect(client.methods).toEqual(['probe.writeRevision']);
  });

  it('apply-to-source 独立重读核对实例仍关联预期源 Prefab 且 FileID 关系完整', () => {
    const item = {
      kind: 'prefab.apply_to_source',
      target: '$instance',
      params: {
        instanceRootLogicalId: '$instance',
        sourcePrefabAssetUuid: 'prefab-source'
      }
    };
    const context = {
      nodeResolutions: { '$instance': 'node-root' },
      componentResolutions: {},
      transactionResult: null
    };
    const snapshot = createSnapshot();
    snapshot.prefabInstances = [createPrefabInstance()];

    expect(verifyPlanItemFromSnapshot(item, context, snapshot)).toMatchObject({
      passed: true,
      expected: {
        instanceRootObjectUuid: 'node-root',
        sourcePrefabAssetUuid: 'prefab-source',
        relationComplete: true
      }
    });

    snapshot.prefabInstances = [{ ...createPrefabInstance(), instanceFileId: null }];
    expect(verifyPlanItemFromSnapshot(item, context, snapshot)).toMatchObject({
      passed: false,
      actual: { relationComplete: false }
    });

    snapshot.prefabInstances = [{
      ...createPrefabInstance(),
      unresolved: [{ path: 'instanceFileId', reason: '实例 FileID 无法解析' }]
    }];
    expect(verifyPlanItemFromSnapshot(item, context, snapshot)).toMatchObject({
      passed: false,
      actual: { relationComplete: false }
    });
  });

  it('prefab.instantiate 独立重读核对源资产和完整实例 FileID', () => {
    const item = {
      kind: 'prefab.instantiate',
      target: '$instance',
      params: { prefabAssetUuid: 'prefab-source', name: 'root' }
    };
    const context = {
      nodeResolutions: { '$instance': 'node-root' },
      componentResolutions: {},
      transactionResult: null
    };
    const snapshot = createSnapshot();
    snapshot.prefabInstances = [createPrefabInstance()];

    expect(verifyPlanItemFromSnapshot(item, context, snapshot)).toMatchObject({
      passed: true,
      actual: {
        instanceRootObjectUuid: 'node-root',
        sourcePrefabAssetUuid: 'prefab-source',
        relationComplete: true
      }
    });

    snapshot.prefabInstances = [{ ...createPrefabInstance(), sourcePrefabAssetUuid: 'prefab-other' }];
    expect(verifyPlanItemFromSnapshot(item, context, snapshot)).toMatchObject({
      passed: false,
      actual: { sourcePrefabAssetUuid: 'prefab-other' }
    });
  });

  it('component.remove 独立重读只认计划物化出的精确组件 UUID', () => {
    const item = {
      kind: 'component.remove',
      target: '$root',
      params: { componentUuid: 'component-remove-target', componentType: 'cc.Button' }
    };
    const context = {
      nodeResolutions: { '$root': 'node-root' },
      componentResolutions: {},
      transactionResult: null
    };
    const stillPresent = createSnapshot(24, ['component-remove-target', 'component-keep']);
    expect(verifyPlanItemFromSnapshot(item, context, stillPresent)).toMatchObject({ passed: false });

    const removed = createSnapshot(24, ['component-keep']);
    expect(verifyPlanItemFromSnapshot(item, context, removed)).toMatchObject({
      expected: 'missing', actual: 'missing', passed: true
    });
  });

  it('prefab.instance_override 独立重读同时核对属性值和覆盖记录', () => {
    const item = {
      kind: 'prefab.instance_override',
      target: '$label',
      propertyPath: 'fontSize',
      value: 28,
      params: {
        instanceRootLogicalId: '$instance',
        componentUuid: 'component-label'
      }
    };
    const context = {
      nodeResolutions: { '$instance': 'node-root', '$label': 'node-label' },
      componentResolutions: {},
      transactionResult: null
    };
    const snapshot = createSnapshot(28);
    snapshot.prefabInstances = [{
      ...createPrefabInstance(),
      propertyOverrides: [{
        index: 0,
        targetLocalIds: ['component-label-file'],
        propertyPath: ['fontSize'],
        declaredType: 'number',
        sourceValue: 24,
        overrideValue: 28,
        effectiveValue: 28,
        raw: {}
      }]
    }];

    expect(verifyPlanItemFromSnapshot(item, context, snapshot)).toMatchObject({ passed: true });
    snapshot.prefabInstances[0].propertyOverrides = [];
    expect(verifyPlanItemFromSnapshot(item, context, snapshot)).toMatchObject({ passed: false });
  });
});

interface DesignClient {
  methods: string[];
  request(method: string, payload: unknown): Promise<unknown>;
}

/** 创建返回单页完整文档快照的只读 Client。 */
function createDesignClient(): DesignClient {
  const methods: string[] = [];
  return {
    methods,
    async request(method) {
      methods.push(method);
      if (method !== 'probe.documentSnapshot') throw new Error(`UNEXPECTED_METHOD:${method}`);
      return createSnapshot();
    }
  };
}

/** 创建会在 confirm 后更新属性值的声明式写入 Client。 */
function createDesignApplyClient(): DesignClient {
  const methods: string[] = [];
  let fontSize = 24;
  return {
    methods,
    async request(method, payload) {
      methods.push(method);
      if (method === 'probe.documentSnapshot') return createSnapshot(fontSize);
      const transactionId = (payload as { params: { transactionId: string } }).params.transactionId;
      if (method === 'probe.writePrepare') {
        return createWriteResult(transactionId, 'validated', 0);
      }
      if (method === 'probe.writeConfirm') {
        fontSize = 28;
        return createWriteResult(transactionId, 'committed', 1);
      }
      if (method === 'probe.transactionRollback') {
        fontSize = 24;
        return {
          ...createWriteResult(transactionId, 'rolled-back', 1),
          verification: null,
          rollbackEvidence: { attempted: true, succeeded: true, verifiedClean: true }
        };
      }
      throw new Error(`UNEXPECTED_METHOD:${method}`);
    }
  };
}

/** 创建 confirm 已提交但其后审计目录失效的 Client。 */
function createAuditFailureApplyClient(journalRoot: string): DesignClient {
  const methods: string[] = [];
  let fontSize = 24;
  return {
    methods,
    async request(method, payload) {
      methods.push(method);
      if (method === 'probe.documentSnapshot') return createSnapshot(fontSize);
      const transactionId = (payload as { params: { transactionId: string } }).params.transactionId;
      if (method === 'probe.writePrepare') return createWriteResult(transactionId, 'validated', 0);
      if (method === 'probe.writeConfirm') {
        fontSize = 28;
        const journalDirectory = join(journalRoot, 'write-journal');
        await rm(journalDirectory, { recursive: true, force: true });
        await writeFile(journalDirectory, 'blocked\n', 'utf8');
        return createWriteResult(transactionId, 'committed', 1);
      }
      if (method === 'probe.transactionRollback') {
        fontSize = 24;
        return {
          ...createWriteResult(transactionId, 'rolled-back', 1),
          verification: null,
          rollbackEvidence: { attempted: true, succeeded: true, verifiedClean: true }
        };
      }
      throw new Error(`UNEXPECTED_METHOD:${method}`);
    }
  };
}

/** 创建 confirm 已失败且其后审计目录失效的 Client。 */
function createFailedAuditApplyClient(journalRoot: string): DesignClient {
  const methods: string[] = [];
  return {
    methods,
    async request(method, payload) {
      methods.push(method);
      if (method === 'probe.documentSnapshot') return createSnapshot();
      const transactionId = (payload as { params: { transactionId: string } }).params.transactionId;
      if (method === 'probe.writePrepare') return createWriteResult(transactionId, 'validated', 0);
      if (method === 'probe.writeConfirm') {
        const journalDirectory = join(journalRoot, 'write-journal');
        await rm(journalDirectory, { recursive: true, force: true });
        await writeFile(journalDirectory, 'blocked\n', 'utf8');
        return {
          ...createWriteResult(transactionId, 'failed', 0),
          failure: { code: 'FAKE_CONFIRM_FAILURE', message: '模拟确认失败', operationIndex: 0 }
        };
      }
      throw new Error(`UNEXPECTED_METHOD:${method}`);
    }
  };
}

/** 创建一次挂载后出现两个同类型新组件的歧义快照。 */
function createAmbiguousComponentApplyClient(): DesignClient {
  const methods: string[] = [];
  let buttonUuids: string[] = [];
  return {
    methods,
    async request(method, payload) {
      methods.push(method);
      if (method === 'probe.documentSnapshot') return createSnapshot(24, buttonUuids);
      const transactionId = (payload as { params: { transactionId: string } }).params.transactionId;
      if (method === 'probe.writePrepare') return createWriteResult(transactionId, 'validated', 0);
      if (method === 'probe.writeConfirm') {
        buttonUuids = ['component-button-a', 'component-button-b'];
        return createWriteResult(transactionId, 'committed', 1);
      }
      if (method === 'probe.transactionRollback') {
        buttonUuids = [];
        return {
          ...createWriteResult(transactionId, 'rolled-back', 1),
          verification: null,
          rollbackEvidence: { attempted: true, succeeded: true, verifiedClean: true }
        };
      }
      throw new Error(`UNEXPECTED_METHOD:${method}`);
    }
  };
}

/** 创建使用真实 Bridge 顶层 componentSchemas 返回新组件的 Client。 */
function createBridgeComponentApplyClient(): DesignClient {
  const methods: string[] = [];
  let mounted = false;
  return {
    methods,
    async request(method, payload) {
      methods.push(method);
      if (method === 'probe.documentSnapshot') {
        return createBridgeComponentSnapshot(24, mounted ? ['component-button'] : []);
      }
      const transactionId = (payload as { params: { transactionId: string } }).params.transactionId;
      if (method === 'probe.writePrepare') return createWriteResult(transactionId, 'validated', 0);
      if (method === 'probe.writeConfirm') {
        mounted = true;
        return createWriteResult(transactionId, 'committed', 1);
      }
      if (method === 'probe.transactionRollback') {
        mounted = false;
        return {
          ...createWriteResult(transactionId, 'rolled-back', 1),
          verification: null,
          rollbackEvidence: { attempted: true, succeeded: true, verifiedClean: true }
        };
      }
      throw new Error(`UNEXPECTED_METHOD:${method}`);
    }
  };
}

/** 创建脚本资产存在且挂载后可重读到自定义组件的 Client。 */
function createScriptComponentApplyClient(): DesignClient {
  const methods: string[] = [];
  let mounted = false;
  return {
    methods,
    async request(method, payload) {
      methods.push(method);
      if (method === 'probe.documentSnapshot') {
        return createSnapshot(24, [], mounted ? [{ uuid: 'component-game', type: 'GameLogic' }] : []);
      }
      if (method === 'probe.assetIndex') {
        return {
          assets: [], documents: [], unresolved: [],
          scripts: [{
            assetUuid: 'script-game', scriptPath: 'db://assets/GameLogic.ts',
            filePath: 'E:/project/assets/GameLogic.ts', classNames: ['GameLogic'], available: true, raw: {}
          }]
        };
      }
      const transactionId = (payload as { params: { transactionId: string } }).params.transactionId;
      if (method === 'probe.writePrepare') return createWriteResult(transactionId, 'validated', 0);
      if (method === 'probe.writeConfirm') {
        mounted = true;
        return createWriteResult(transactionId, 'committed', 1);
      }
      if (method === 'probe.transactionRollback') {
        mounted = false;
        return {
          ...createWriteResult(transactionId, 'rolled-back', 1),
          verification: null,
          rollbackEvidence: { attempted: true, succeeded: true, verifiedClean: true }
        };
      }
      throw new Error(`UNEXPECTED_METHOD:${method}`);
    }
  };
}

/** 创建既有组件在 confirm 后伪装为目标类型、但没有新增 UUID 的 Client。 */
function createExistingComponentMasqueradeClient(): DesignClient {
  const methods: string[] = [];
  let confirmed = false;
  return {
    methods,
    async request(method, payload) {
      methods.push(method);
      if (method === 'probe.documentSnapshot') {
        return createSnapshot(24, [], [{
          uuid: 'component-existing',
          type: confirmed ? 'cc.Button' : 'cc.ButtonAlias'
        }]);
      }
      const transactionId = (payload as { params: { transactionId: string } }).params.transactionId;
      if (method === 'probe.writePrepare') return createWriteResult(transactionId, 'validated', 0);
      if (method === 'probe.writeConfirm') {
        confirmed = true;
        return createWriteResult(transactionId, 'committed', 1);
      }
      if (method === 'probe.transactionRollback') {
        confirmed = false;
        return {
          ...createWriteResult(transactionId, 'rolled-back', 1),
          verification: null,
          rollbackEvidence: { attempted: true, succeeded: true, verifiedClean: true }
        };
      }
      throw new Error(`UNEXPECTED_METHOD:${method}`);
    }
  };
}

function createSnapshot(
  fontSize = 24,
  buttonUuids: string[] = [],
  extraComponents: Array<{ uuid: string; type: string }> = []
) {
  const emptyIdentity = {
    sessionId: null, assetUuid: null, fileId: null, typeId: null, scriptUuid: null
  };
  return {
    document: {
      assetUuid: 'scene-1', path: 'db://assets/main.scene', filePath: 'E:/project/assets/main.scene',
      documentType: 'scene', available: true, raw: {}
    },
    revision: 'revision-1',
    mode: 'full',
    page: { offset: 0, pageSize: 500, totalNodes: 2, nextCursor: null },
    nodes: [
      {
        kind: 'node', identity: { ...emptyIdentity, objectUuid: 'node-root', fileId: 'file-root' },
        name: 'root', path: 'root', parentObjectUuid: null, childObjectUuids: ['node-label'],
        components: [...buttonUuids.map((objectUuid) => ({
          kind: 'component',
          identity: { ...emptyIdentity, objectUuid, typeId: 'cc.Button' },
          className: 'cc.Button',
          properties: [],
          rawSerializedState: {}
        })), ...extraComponents.map((component) => ({
          kind: 'component',
          identity: { ...emptyIdentity, objectUuid: component.uuid, typeId: component.type },
          className: component.type,
          properties: [],
          rawSerializedState: {}
        }))]
      },
      {
        kind: 'node', identity: { ...emptyIdentity, objectUuid: 'node-label', fileId: 'file-label' },
        name: 'label', path: 'root/label', parentObjectUuid: 'node-root', childObjectUuids: [],
        components: [{
          kind: 'component',
          identity: { ...emptyIdentity, objectUuid: 'component-label', typeId: 'cc.Label' },
          className: 'cc.Label',
          properties: [{
            propertyPath: 'fontSize', declaredType: 'number', valueKind: 'number',
            effectiveValue: fontSize, sourceValue: fontSize, overrideValue: null, valueSource: 'local'
          }],
          rawSerializedState: {}
        }]
      }
    ],
    componentSchemas: [], prefabInstances: [],
    coverage: {
      nodes: { total: 2, decoded: 2 }, components: { total: 1, decoded: 1 },
      properties: { total: 1, decoded: 1 }, references: { total: 0, resolved: 0 },
      prefabInstances: { total: 0, resolved: 0 }, overrides: { total: 0, decoded: 0 }
    },
    unresolved: [], diagnostics: []
  };
}

/** 把旧节点内组件夹具转换为 Creator document-scan 的真实顶层组件形状。 */
function createBridgeComponentSnapshot(
  fontSize = 24,
  buttonUuids: string[] = [],
  extraComponents: Array<{ uuid: string; type: string }> = []
) {
  const snapshot = createSnapshot(fontSize, buttonUuids, extraComponents);
  const componentSchemas = snapshot.nodes.flatMap((node) =>
    (node.components ?? []).map((component, componentIndex) => ({
      componentUuid: component.identity.objectUuid as string,
      componentFileId: component.identity.fileId,
      nodeUuid: node.identity.objectUuid as string,
      nodePath: node.path,
      componentIndex,
      className: component.className,
      qualifiedName: component.qualifiedName ?? component.className,
      typeId: component.identity.typeId,
      scriptUuid: component.identity.scriptUuid,
      scriptPath: component.scriptPath ?? null,
      inheritance: component.inheritance ?? [],
      executionOrder: null,
      properties: component.properties.map((property) => ({
        propertyPath: property.propertyPath,
        serializedName: property.propertyPath,
        displayName: property.displayName ?? property.propertyPath,
        declaredType: property.declaredType,
        actualType: property.actualType ?? property.declaredType,
        valueKind: property.valueKind,
        nullable: property.effectiveValue === null,
        serializable: true,
        visible: true,
        readonly: false,
        defaultValue: property.defaultValue ?? null,
        currentValue: property.effectiveValue,
        references: [],
        inspectorMetadata: property.inspectorMetadata ?? {},
        rawClassAttributes: {},
        rawConsumedKeys: []
      })),
      rawClassAttributes: {},
      unresolved: []
    }))
  );
  return {
    ...snapshot,
    nodes: snapshot.nodes.map((node) => ({ ...node, components: [] })),
    componentSchemas
  };
}

function createWriteResult(transactionId: string, status: string, executedOps: number) {
  return {
    transactionId,
    status,
    executedOps,
    verification: status === 'committed'
      ? {
          passed: true,
          verifiedAt: '2026-07-20T00:00:00.000Z',
          items: Array.from({ length: executedOps }, (_, operationIndex) => ({
            operationIndex,
            description: `operation-${operationIndex}`,
            expected: true,
            actual: true,
            passed: true
          }))
        }
      : null,
    failure: null,
    rollbackEvidence: null
  };
}

/** 创建具备完整源对象与实例对象 FileID 关系的 Prefab 实例快照。 */
function createPrefabInstance() {
  return {
    ownerDocumentAssetUuid: 'scene-1',
    hostNodePath: 'root',
    sourcePrefabAssetUuid: 'prefab-source',
    instanceRootObjectUuid: 'node-root',
    sourceObjectFileId: 'source-file-root',
    instanceFileId: 'instance-file-root',
    prefabRootNodeUuid: 'node-root',
    instanceChain: [{
      depth: 0,
      assetUuid: 'prefab-source',
      instanceNodeUuid: 'node-root',
      state: 0,
      isNested: false
    }],
    sync: true,
    state: 0,
    propertyOverrides: [],
    targetOverrides: [],
    mountedChildren: [],
    mountedComponents: [],
    removedComponents: [],
    unresolved: [],
    rawPrefabInfo: {}
  };
}
