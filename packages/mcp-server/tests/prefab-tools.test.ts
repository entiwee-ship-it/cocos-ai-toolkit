import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadonlyProbeClient } from '@cocos-ai/core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCocosMcpServer } from '../src/server.js';

interface ProbeRequest {
  method: string;
  payload: unknown;
}

class RecordingProbeClient implements ReadonlyProbeClient {
  readonly requests: ProbeRequest[] = [];

  constructor(private readonly respond: (method: string, payload: unknown) => unknown) {}

  async request(method: string, payload: unknown): Promise<unknown> {
    this.requests.push({ method, payload });
    return this.respond(method, payload);
  }
}

const harnesses: Array<{ server: McpServer; client: Client }> = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(async ({ server, client }) => {
    await client.close();
    await server.close();
  }));
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Prefab 场景只读工具', () => {
  it('cocos_prefab_search 只返回 Prefab，并在高层结果上稳定分页', async () => {
    const assets = [
      createAsset('prefab-a', 'db://assets/ui/PanelA.prefab', 'cc.Prefab'),
      createAsset('texture-a', 'db://assets/ui/PanelA.png', 'cc.ImageAsset'),
      createAsset('prefab-b', 'db://assets/ui/PanelB.prefab', 'cc.Prefab')
    ];
    const probe = new RecordingProbeClient((method) => {
      if (method === 'server.editors') return [createEditor()];
      if (method === 'probe.assetIndex') return createAssetIndex(assets);
      throw new Error(`UNEXPECTED_REQUEST:${method}`);
    });
    const { client } = await createHarness(probe);

    const first = await client.callTool({
      name: 'cocos_prefab_search',
      arguments: { projectId: 'project-a', pattern: 'panel', pageSize: 1 }
    });
    expect(first.isError).not.toBe(true);
    expect(first.structuredContent).toMatchObject({
      query: { pattern: 'panel' },
      page: {
        offset: 0,
        pageSize: 1,
        total: 2,
        items: [{ assetUuid: 'prefab-a', type: 'cc.Prefab' }]
      }
    });
    const cursor = readStructured(first).page.nextCursor as string;
    expect(cursor).toBeTruthy();

    const second = await client.callTool({
      name: 'cocos_prefab_search',
      arguments: { projectId: 'project-a', pattern: 'panel', cursor }
    });
    expect(second.structuredContent).toMatchObject({
      page: { offset: 1, total: 2, items: [{ assetUuid: 'prefab-b' }], nextCursor: null }
    });
  });

  it('cocos_prefab_inspect 先校验资产，再通过 Creator 打开并返回结构与全部引用', async () => {
    const asset = createAsset('prefab-a', 'db://assets/ui/PanelA.prefab', 'cc.Prefab');
    const probe = createPrefabProbe(asset);
    const { client } = await createHarness(probe);

    const result = await client.callTool({
      name: 'cocos_prefab_inspect',
      arguments: { projectId: 'project-a', uuid: 'prefab-a' }
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      asset: { uuid: 'prefab-a', url: 'db://assets/ui/PanelA.prefab', type: 'cc.Prefab' },
      relations: { dependencies: ['texture-a'], users: ['scene-a'] },
      inspect: {
        revision: 'revision-prefab-a',
        tree: [{ name: 'PanelA' }]
      }
    });
    const methods = probe.requests.map((request) => request.method);
    expect(methods.indexOf('probe.assets')).toBeLessThan(methods.indexOf('probe.openAsset'));
    expect(methods.indexOf('probe.openAsset')).toBeLessThan(methods.indexOf('probe.editorState'));
    expect(methods.indexOf('probe.editorState')).toBeLessThan(methods.indexOf('probe.documentSnapshot'));
  });

  it('cocos_prefab_inspect 拒绝非 Prefab 资产且不会打开', async () => {
    const asset = createAsset('texture-a', 'db://assets/ui/PanelA.png', 'cc.ImageAsset');
    const probe = createPrefabProbe(asset);
    const { client } = await createHarness(probe);

    const result = await client.callTool({
      name: 'cocos_prefab_inspect',
      arguments: { projectId: 'project-a', uuid: 'texture-a' }
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('ASSET_NOT_PREFAB');
    expect(probe.requests.map((request) => request.method)).not.toContain('probe.openAsset');
  });

  it('cocos_prefab_verify 自动打开目标并按固定 current-document 身份验证', async () => {
    const asset = createAsset('prefab-a', 'db://assets/ui/PanelA.prefab', 'cc.Prefab');
    const probe = createPrefabProbe(asset);
    const { client } = await createHarness(probe);

    const result = await client.callTool({
      name: 'cocos_prefab_verify',
      arguments: {
        projectId: 'project-a',
        uuid: 'prefab-a',
        tree: [{ id: '$root', fileId: 'file-root', name: 'PanelA' }]
      }
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      asset: { uuid: 'prefab-a' },
      report: { passed: true }
    });
  });
});

describe('Prefab 场景编辑工具', () => {
  it('cocos_prefab_edit preview 只返回预览，不发送事务写请求', async () => {
    const probe = createEditablePrefabProbe();
    const { client } = await createHarness(probe);

    const result = await client.callTool({
      name: 'cocos_prefab_edit',
      arguments: {
        projectId: 'project-a',
        uuid: 'prefab-a',
        tree: createEditedTree(),
        mode: 'preview'
      }
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      mode: 'preview',
      asset: { uuid: 'prefab-a' },
      preview: { mode: 'preview', operationCount: 1 }
    });
    expect(probe.requests.map((request) => request.method)).not.toContain('probe.writePrepare');
  });

  it('cocos_prefab_edit apply 内部先预览，再事务应用并独立重读验证', async () => {
    const probe = createEditablePrefabProbe();
    const { client } = await createHarness(probe);

    const result = await client.callTool({
      name: 'cocos_prefab_edit',
      arguments: {
        projectId: 'project-a',
        uuid: 'prefab-a',
        tree: createEditedTree(),
        mode: 'apply'
      }
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      mode: 'apply',
      preview: { operationCount: 1 },
      apply: { status: 'committed', verification: { passed: true } },
      verification: { passed: true }
    });
    expect(probe.requests.filter((request) => request.method === 'probe.writePrepare')).toHaveLength(1);
    expect(probe.requests.filter((request) => request.method === 'probe.writeConfirm')).toHaveLength(1);
    const firstWrite = probe.requests.findIndex((request) => request.method === 'probe.writePrepare');
    const snapshotsBeforeWrite = probe.requests.slice(0, firstWrite)
      .filter((request) => request.method === 'probe.documentSnapshot');
    expect(snapshotsBeforeWrite.length).toBeGreaterThanOrEqual(2);
  });

  it('cocos_prefab_edit extract_subtree 不用抽取前 fileId 误判最终验证', async () => {
    const probe = createExtractingPrefabProbe();
    const { client } = await createHarness(probe);
    const assetUrl = 'db://assets/ui/ExtractedChild.prefab';

    const result = await client.callTool({
      name: 'cocos_prefab_edit',
      arguments: {
        projectId: 'project-a',
        uuid: 'prefab-a',
        tree: [{
          id: '$root',
          fileId: 'file-root',
          name: 'PanelA',
          path: 'PanelA',
          children: [{
            id: '$child',
            fileId: 'file-child',
            name: 'Child',
            path: 'PanelA/Child'
          }]
        }],
        operations: [{ type: 'document.extract_subtree', nodeId: '$child', assetUrl }],
        mode: 'apply'
      }
    });

    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      mode: 'apply',
      apply: {
        status: 'committed',
        verification: {
          passed: true,
          items: [expect.objectContaining({
            description: 'document.extract_subtree:$child',
            passed: true
          })]
        }
      },
      verification: {
        passed: true,
        items: [expect.objectContaining({ target: '$root', passed: true })]
      }
    });
  });
});

describe('Prefab 场景创建工具', () => {
  it('cocos_prefab_create 的非法 tree 返回可行动结构化输入错误', async () => {
    const probe = createPrefabCreationProbe();
    const { client } = await createHarness(probe);

    const result = await client.callTool({
      name: 'cocos_prefab_create',
      arguments: {
        projectId: 'project-a',
        assetUrl: 'db://assets/ui/Dialog.prefab',
        tree: [{ name: 'Dialog' }],
        rootId: '$dialog',
        mode: 'preview'
      }
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('MCP_INPUT_INVALID');
    expect(JSON.stringify(result.content)).toContain('input-validation');
    expect(JSON.stringify(result.content)).toContain('reason');
    expect(JSON.stringify(result.content)).toContain('nextAction');
    expect(probe.requests).toHaveLength(0);
  });

  it('cocos_prefab_create preview 合并到当前文档根节点且不发送写请求', async () => {
    const probe = createPrefabCreationProbe();
    const { client } = await createHarness(probe);

    const result = await client.callTool({
      name: 'cocos_prefab_create',
      arguments: {
        projectId: 'project-a',
        assetUrl: 'db://assets/ui/Dialog.prefab',
        tree: [{ id: '$dialog', name: 'Dialog' }],
        rootId: '$dialog',
        mode: 'preview'
      }
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      mode: 'preview',
      assetUrl: 'db://assets/ui/Dialog.prefab',
      rootId: '$dialog',
      preview: { mode: 'preview', operationCount: 1 },
      operation: {
        type: 'prefab.create_from_node',
        nodeUuid: '$dialog',
        assetUrl: 'db://assets/ui/Dialog.prefab'
      }
    });
    expect(probe.requests.map((request) => request.method)).not.toContain('probe.writePrepare');
  });

  it('cocos_prefab_create 不回灌当前文档已有的 Creator uuid 引用数组', async () => {
    const probe = createPrefabCreationProbe({ withCreatorReferenceArray: true });
    const { client } = await createHarness(probe);

    const result = await client.callTool({
      name: 'cocos_prefab_create',
      arguments: {
        projectId: 'project-a',
        assetUrl: 'db://assets/ui/Dialog.prefab',
        tree: [{ id: '$dialog', name: 'Dialog' }],
        rootId: '$dialog',
        mode: 'preview'
      }
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      mode: 'preview',
      preview: { mode: 'preview', operationCount: 1 }
    });
  });

  it('cocos_prefab_create 在 URL 或 rootId 非法时于写请求前拒绝', async () => {
    const probe = createPrefabCreationProbe();
    const { client } = await createHarness(probe);

    const invalidUrl = await client.callTool({
      name: 'cocos_prefab_create',
      arguments: {
        projectId: 'project-a',
        assetUrl: 'E:/project-a/assets/Dialog.prefab',
        tree: [{ id: '$dialog', name: 'Dialog' }],
        rootId: '$dialog',
        mode: 'apply'
      }
    });
    expect(invalidUrl.isError).toBe(true);
    expect(JSON.stringify(invalidUrl.content)).toContain('PREFAB_ASSET_URL_INVALID');

    const invalidRoot = await client.callTool({
      name: 'cocos_prefab_create',
      arguments: {
        projectId: 'project-a',
        assetUrl: 'db://assets/ui/Dialog.prefab',
        tree: [{ id: '$dialog', name: 'Dialog' }],
        rootId: '$missing',
        mode: 'apply'
      }
    });
    expect(invalidRoot.isError).toBe(true);
    expect(JSON.stringify(invalidRoot.content)).toContain('PREFAB_ROOT_ID_INVALID');
    expect(probe.requests.map((request) => request.method)).not.toContain('probe.writePrepare');
  });

  it('cocos_prefab_create apply 通过 Creator create_from_node 事务生成并重新打开 Prefab', async () => {
    const probe = createPrefabCreationProbe();
    const { client } = await createHarness(probe);

    const result = await client.callTool({
      name: 'cocos_prefab_create',
      arguments: {
        projectId: 'project-a',
        assetUrl: 'db://assets/ui/Dialog.prefab',
        tree: [{ id: '$dialog', name: 'Dialog', children: [{ id: '$child', name: 'Child' }] }],
        rootId: '$dialog',
        mode: 'apply'
      }
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      mode: 'apply',
      assetUrl: 'db://assets/ui/Dialog.prefab',
      sourceNodeUuid: 'node-dialog',
      create: { status: 'committed', verification: { passed: true } },
      cleanup: {
        strategy: 'removed-temporary-instance',
        transactionIds: expect.arrayContaining([expect.stringMatching(/^prefab-create-cleanup-/)])
      },
      prefab: {
        asset: { uuid: 'prefab-dialog' },
        inspect: { tree: [{ name: 'Dialog' }] }
      }
    });
    const prepareRequests = probe.requests.filter((request) => request.method === 'probe.writePrepare');
    expect(prepareRequests).toHaveLength(4);
    const preparedParams = prepareRequests.map((request) => (
      request.payload as { params: { operations: Array<{ type: string }>; save: boolean; allowDirty?: boolean } }
    ).params);
    expect(preparedParams.find((params) => params.operations[0]?.type === 'node.create')?.save).toBe(false);
    expect(preparedParams.find((params) => params.operations[0]?.type === 'node.create')?.allowDirty).toBeUndefined();
    expect(preparedParams.filter((params) => params.operations[0]?.type === 'node.create')[1]).toMatchObject({
      save: false,
      allowDirty: true
    });
    expect(preparedParams.find((params) => params.operations[0]?.type === 'prefab.create_from_node')).toMatchObject({
      save: false,
      allowDirty: true
    });
    expect(preparedParams.find((params) => params.operations[0]?.type === 'node.delete')).toMatchObject({
      save: false,
      allowDirty: true
    });
    expect(preparedParams.find((params) => params.operations[0]?.type === 'node.delete')?.operations).toEqual([
      { type: 'node.delete', nodeUuid: 'node-dialog' }
    ]);
    expect(probe.requests.map((request) => request.method)).toContain('probe.writeRevision');
    expect(probe.requests.filter((request) => request.method === 'probe.transactionRollback')).toHaveLength(0);
    const cleanupConfirm = probe.requests.findIndex((request) => (
      request.method === 'probe.writeConfirm'
      && readTransactionId(request.payload).startsWith('prefab-create-cleanup-')
    ));
    const openCreatedPrefab = probe.requests.findIndex((request) => request.method === 'probe.openAsset');
    expect(cleanupConfirm).toBeGreaterThanOrEqual(0);
    expect(cleanupConfirm).toBeLessThan(openCreatedPrefab);
  });

  it('cocos_prefab_create 在资产准备失败时回滚已提交的节点树', async () => {
    const probe = createPrefabCreationProbe({ failPrefabPrepare: true });
    const { client } = await createHarness(probe);

    const result = await client.callTool({
      name: 'cocos_prefab_create',
      arguments: {
        projectId: 'project-a',
        assetUrl: 'db://assets/ui/Dialog.prefab',
        tree: [{ id: '$dialog', name: 'Dialog' }],
        rootId: '$dialog',
        mode: 'apply'
      }
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('PREFAB_CREATE_PREPARE_FAILED');
    expect(probe.requests.filter((request) => request.method === 'probe.transactionRollback')).toHaveLength(1);
  });

  it('cocos_prefab_create 在资产确认结果未知时保留节点树且不盲回滚', async () => {
    const probe = createPrefabCreationProbe({ failPrefabConfirm: true });
    const { client } = await createHarness(probe);

    const result = await client.callTool({
      name: 'cocos_prefab_create',
      arguments: {
        projectId: 'project-a',
        assetUrl: 'db://assets/ui/Dialog.prefab',
        tree: [{ id: '$dialog', name: 'Dialog' }],
        rootId: '$dialog',
        mode: 'apply'
      }
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('PREFAB_CREATE_CONFIRM_OUTCOME_UNKNOWN');
    expect(probe.requests.filter((request) => request.method === 'probe.transactionRollback')).toHaveLength(0);
  });
});

describe('Prefab 场景删除工具', () => {
  it('cocos_prefab_delete preview 返回引用影响且不写入', async () => {
    const probe = createPrefabDeletionProbe();
    const { client } = await createHarness(probe);

    const result = await client.callTool({
      name: 'cocos_prefab_delete',
      arguments: { projectId: 'project-a', uuid: 'prefab-a', mode: 'preview' }
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      mode: 'preview',
      asset: { uuid: 'prefab-a', url: 'db://assets/ui/PanelA.prefab' },
      impact: { users: ['scene-a'], userCount: 1, irreversible: true }
    });
    expect(probe.requests.map((request) => request.method)).not.toContain('probe.writePrepare');
  });

  it('cocos_prefab_delete apply 要求精确 URL，存在引用时还要单独确认影响', async () => {
    const probe = createPrefabDeletionProbe();
    const { client } = await createHarness(probe);

    const missingUrl = await client.callTool({
      name: 'cocos_prefab_delete',
      arguments: { projectId: 'project-a', uuid: 'prefab-a', mode: 'apply' }
    });
    expect(missingUrl.isError).toBe(true);
    expect(JSON.stringify(missingUrl.content)).toContain('PREFAB_DELETE_CONFIRMATION_REQUIRED');

    const missingImpact = await client.callTool({
      name: 'cocos_prefab_delete',
      arguments: {
        projectId: 'project-a',
        uuid: 'prefab-a',
        mode: 'apply',
        confirmAssetUrl: 'db://assets/ui/PanelA.prefab'
      }
    });
    expect(missingImpact.isError).toBe(true);
    expect(JSON.stringify(missingImpact.content)).toContain('PREFAB_DELETE_REFERENCES_CONFIRMATION_REQUIRED');
    expect(probe.requests.map((request) => request.method)).not.toContain('probe.writePrepare');
  });

  it('cocos_prefab_delete apply 只通过主进程 asset.delete 删除并确认 AssetDB 已移除', async () => {
    const probe = createPrefabDeletionProbe();
    const { client } = await createHarness(probe);

    const result = await client.callTool({
      name: 'cocos_prefab_delete',
      arguments: {
        projectId: 'project-a',
        uuid: 'prefab-a',
        mode: 'apply',
        confirmAssetUrl: 'db://assets/ui/PanelA.prefab',
        confirmReferenced: true
      }
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      mode: 'apply',
      deleted: true,
      asset: { uuid: 'prefab-a' },
      result: { status: 'committed', verification: { passed: true } }
    });
    const prepare = probe.requests.find((request) => request.method === 'probe.writePrepare');
    expect(prepare).toBeTruthy();
    expect(prepare?.payload).toMatchObject({
      params: {
        operations: [{
          type: 'asset.delete',
          assetUrl: 'db://assets/ui/PanelA.prefab',
          expectedAssetUuid: 'prefab-a'
        }],
        save: false
      }
    });
    expect(probe.requests.map((request) => request.method)).toContain('probe.writeRevision');
    expect(probe.requests.map((request) => request.method)).not.toContain('probe.openAsset');
  });
});

async function createHarness(probeClient: ReadonlyProbeClient) {
  const reportRoot = await mkdtemp(join(tmpdir(), 'cocos-prefab-tools-'));
  temporaryRoots.push(reportRoot);
  const server = createCocosMcpServer(
    { probeClient, reportRoot },
    { profile: 'prefab', enableWrites: true }
  );
  const client = new Client({ name: 'prefab-tools-test', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  harnesses.push({ server, client });
  return { client };
}

function createEditor() {
  return {
    editorInstanceId: 'editor-a',
    projectId: 'project-a',
    projectPath: 'E:/project-a',
    creatorVersion: '3.8.8',
    bridgeVersion: '0.1.28',
    capabilities: [
      'probe.assetIndex',
      'probe.assets',
      'probe.openAsset',
      'probe.editorState',
      'probe.documentSnapshot',
      'probe.writePrepare',
      'probe.writeConfirm',
      'probe.transactionRollback',
      'probe.writeRevision'
    ]
  };
}

function createAsset(assetUuid: string, url: string, type: string) {
  const name = url.split('/').at(-1)?.replace(/\.[^.]+$/, '') ?? assetUuid;
  return {
    assetUuid,
    url,
    filePath: `E:/project-a/${url.slice('db://'.length)}`,
    type,
    importer: type === 'cc.Prefab' ? 'prefab' : 'image',
    name,
    displayName: name,
    source: url,
    path: url,
    isSubAsset: false,
    isBundle: false,
    imported: true,
    invalid: false,
    isDirectory: false,
    visible: true,
    readonly: false,
    available: true,
    raw: { uuid: assetUuid, url }
  };
}

function createAssetIndex(assets: ReturnType<typeof createAsset>[]) {
  return {
    assets,
    scripts: [],
    documents: assets.filter((asset) => asset.type === 'cc.Prefab').map((asset) => ({
      assetUuid: asset.assetUuid,
      path: asset.url,
      filePath: asset.filePath,
      documentType: 'prefab',
      available: true,
      raw: asset.raw
    })),
    unresolved: []
  };
}

function createPrefabProbe(asset: ReturnType<typeof createAsset>) {
  return new RecordingProbeClient((method) => {
    if (method === 'server.editors') return [createEditor()];
    if (method === 'probe.assetIndex') return createAssetIndex([asset]);
    if (method === 'probe.assets') {
      return {
        assets: [createAssetInfo(asset)],
        details: createAssetInfo(asset),
        meta: { uuid: asset.assetUuid },
        dependencies: ['texture-a'],
        users: ['scene-a'],
        unresolved: []
      };
    }
    if (method === 'probe.openAsset') return { opened: true, uuid: asset.assetUuid };
    if (method === 'probe.editorState') return createEditorState(asset.assetUuid);
    if (method === 'probe.documentSnapshot') return createDocumentSnapshot(asset.assetUuid);
    throw new Error(`UNEXPECTED_REQUEST:${method}`);
  });
}

function createEditablePrefabProbe() {
  const asset = createAsset('prefab-a', 'db://assets/ui/PanelA.prefab', 'cc.Prefab');
  let childCreated = false;
  return new RecordingProbeClient((method, payload) => {
    if (method === 'server.editors') return [createEditor()];
    if (method === 'probe.assetIndex') return createAssetIndex([asset]);
    if (method === 'probe.assets') {
      return {
        assets: [createAssetInfo(asset)],
        details: createAssetInfo(asset),
        meta: { uuid: asset.assetUuid },
        dependencies: [],
        users: [],
        unresolved: []
      };
    }
    if (method === 'probe.openAsset') return { opened: true, uuid: asset.assetUuid };
    if (method === 'probe.editorState') return createEditorState(asset.assetUuid);
    if (method === 'probe.documentSnapshot') return createDocumentSnapshot(asset.assetUuid, childCreated);
    if (method === 'probe.writeRevision') {
      return {
        documentId: asset.assetUuid,
        revision: {
          document: 'sha256:prefab-a',
          hierarchy: childCreated ? 'sha256:with-child' : 'sha256:without-child',
          assetDatabase: 'sha256:assets',
          scriptCompilation: 'sha256:scripts',
          prefabGraph: null
        }
      };
    }
    if (method === 'probe.writePrepare') {
      const transactionId = readTransactionId(payload);
      return createWriteResult(transactionId, 'validated', 0);
    }
    if (method === 'probe.writeConfirm') {
      childCreated = true;
      const transactionId = readTransactionId(payload);
      return createWriteResult(transactionId, 'committed', 1);
    }
    if (method === 'probe.transactionRollback') {
      childCreated = false;
      const transactionId = readTransactionId(payload);
      return {
        ...createWriteResult(transactionId, 'rolled-back', 1),
        rollbackEvidence: { attempted: true, succeeded: true, verifiedClean: true }
      };
    }
    throw new Error(`UNEXPECTED_REQUEST:${method}`);
  });
}

function createExtractingPrefabProbe() {
  const hostAsset = createAsset('prefab-a', 'db://assets/ui/PanelA.prefab', 'cc.Prefab');
  const extractedAsset = createAsset(
    'prefab-extracted-child',
    'db://assets/ui/ExtractedChild.prefab',
    'cc.Prefab'
  );
  let committed = false;
  return new RecordingProbeClient((method, payload) => {
    if (method === 'server.editors') return [createEditor()];
    if (method === 'probe.assetIndex') {
      return createAssetIndex(committed ? [hostAsset, extractedAsset] : [hostAsset]);
    }
    if (method === 'probe.assets') {
      return {
        assets: [createAssetInfo(hostAsset)],
        details: createAssetInfo(hostAsset),
        meta: { uuid: hostAsset.assetUuid },
        dependencies: committed ? [extractedAsset.assetUuid] : [],
        users: [],
        unresolved: []
      };
    }
    if (method === 'probe.openAsset') return { opened: true, uuid: hostAsset.assetUuid };
    if (method === 'probe.editorState') return createEditorState(hostAsset.assetUuid);
    if (method === 'probe.documentSnapshot') {
      const snapshot = createDocumentSnapshot(hostAsset.assetUuid, true);
      if (committed) {
        const child = snapshot.nodes[1];
        child.identity.fileId = 'instance-file-child';
        child.name = 'ExtractedChild';
        child.path = 'PanelA/ExtractedChild';
        child.prefabContext = {
          ownerDocumentAssetUuid: hostAsset.assetUuid,
          sourcePrefabAssetUuid: extractedAsset.assetUuid,
          instanceRootObjectUuid: 'node-child',
          sourceObjectFileId: 'source-file-child',
          instanceChain: []
        };
        snapshot.prefabInstances = [{
          ownerDocumentAssetUuid: hostAsset.assetUuid,
          hostNodePath: child.path,
          sourcePrefabAssetUuid: extractedAsset.assetUuid,
          instanceRootObjectUuid: 'node-child',
          sourceObjectFileId: 'source-file-child',
          instanceFileId: 'instance-file-child',
          prefabRootNodeUuid: 'node-child',
          instanceChain: [],
          sync: true,
          state: null,
          propertyOverrides: [],
          targetOverrides: [],
          mountedChildren: [],
          mountedComponents: [],
          removedComponents: [],
          unresolved: [],
          rawPrefabInfo: {},
          raw: {}
        }];
        snapshot.coverage.prefabInstances = { total: 1, resolved: 1 };
      }
      return snapshot;
    }
    if (method === 'probe.writeRevision') {
      return {
        documentId: hostAsset.assetUuid,
        revision: {
          document: 'sha256:prefab-a',
          hierarchy: committed ? 'sha256:extracted' : 'sha256:embedded',
          assetDatabase: committed ? 'sha256:with-extracted' : 'sha256:without-extracted',
          scriptCompilation: null,
          prefabGraph: null
        }
      };
    }
    const transactionId = readTransactionId(payload);
    if (method === 'probe.writePrepare') return createWriteResult(transactionId, 'validated', 0);
    if (method === 'probe.writeConfirm') {
      committed = true;
      return {
        ...createWriteResult(transactionId, 'committed', 1),
        verification: {
          passed: true,
          verifiedAt: '2026-07-29T00:00:00.000Z',
          items: [{
            operationIndex: 0,
            description: `从节点生成预制体 ${extractedAsset.url}`,
            expected: '节点已关联预制体资产',
            actual: extractedAsset.assetUuid,
            passed: true
          }]
        }
      };
    }
    if (method === 'probe.transactionRollback') {
      committed = false;
      return {
        ...createWriteResult(transactionId, 'rolled-back', 1),
        rollbackEvidence: { attempted: true, succeeded: true, verifiedClean: true }
      };
    }
    throw new Error(`UNEXPECTED_REQUEST:${method}`);
  });
}

function createPrefabCreationProbe(options: {
  failPrefabPrepare?: boolean;
  failPrefabConfirm?: boolean;
  withCreatorReferenceArray?: boolean;
} = {}) {
  const createdAsset = createAsset('prefab-dialog', 'db://assets/ui/Dialog.prefab', 'cc.Prefab');
  let createdLevel = 0;
  let assetCreated = false;
  let temporaryInstancePresent = true;
  let currentDocument = 'scene-a';
  const transactionKinds = new Map<string, 'design' | 'prefab' | 'cleanup'>();
  return new RecordingProbeClient((method, payload) => {
    if (method === 'server.editors') return [createEditor()];
    if (method === 'probe.assetIndex') return createAssetIndex(assetCreated ? [createdAsset] : []);
    if (method === 'probe.assets') {
      if (!assetCreated) throw new Error('ASSET_NOT_FOUND');
      return {
        assets: [createAssetInfo(createdAsset)],
        details: createAssetInfo(createdAsset),
        meta: { uuid: createdAsset.assetUuid },
        dependencies: [],
        users: [],
        unresolved: []
      };
    }
    if (method === 'probe.openAsset') {
      currentDocument = createdAsset.assetUuid;
      return { opened: true, uuid: createdAsset.assetUuid };
    }
    if (method === 'probe.editorState') return createEditorState(currentDocument);
    if (method === 'probe.documentSnapshot') {
      const snapshot = currentDocument === createdAsset.assetUuid
        ? createCreatedPrefabSnapshot()
        : createSceneSnapshot(createdLevel, temporaryInstancePresent, assetCreated);
      if (currentDocument !== createdAsset.assetUuid && options.withCreatorReferenceArray) {
        snapshot.nodes[0].components.push({
          kind: 'component' as const,
          identity: {
            sessionId: null,
            assetUuid: null,
            fileId: 'component-file-root',
            objectUuid: 'component-root',
            typeId: 'ReferenceHolder',
            scriptUuid: null
          },
          className: 'ReferenceHolder',
          properties: [{
            propertyPath: 'frames',
            declaredType: 'cc.SpriteFrame[]',
            valueKind: 'array' as const,
            effectiveValue: [{ uuid: 'frame-a' }],
            sourceValue: [{ uuid: 'frame-a' }],
            overrideValue: null,
            valueSource: 'local' as const
          }],
          rawSerializedState: {}
        });
      }
      return snapshot;
    }
    if (method === 'probe.writeRevision') {
      return {
        documentId: 'scene-a',
        revision: {
          document: 'sha256:scene',
          hierarchy: `sha256:created-level-${createdLevel}`,
          assetDatabase: assetCreated ? 'sha256:with-prefab' : 'sha256:no-prefab',
          scriptCompilation: null,
          prefabGraph: null
        }
      };
    }
    if (method === 'probe.writePrepare') {
      const params = (payload as { params: { transactionId: string; operations: Array<{ type: string }> } }).params;
      const transactionKind = params.operations.some((operation) => operation.type === 'prefab.create_from_node')
        ? 'prefab'
        : params.operations.some((operation) => operation.type === 'node.delete')
          ? 'cleanup'
          : 'design';
      transactionKinds.set(params.transactionId, transactionKind);
      if (transactionKind === 'prefab' && options.failPrefabPrepare) {
        throw new Error('PREFAB_PREPARE_REJECTED');
      }
      return createWriteResult(params.transactionId, 'validated', 0);
    }
    if (method === 'probe.writeConfirm') {
      const transactionId = readTransactionId(payload);
      if (transactionKinds.get(transactionId) === 'prefab') {
        if (options.failPrefabConfirm) throw new Error('PREFAB_CONFIRM_CONNECTION_LOST');
        assetCreated = true;
      } else if (transactionKinds.get(transactionId) === 'cleanup') {
        temporaryInstancePresent = false;
      } else createdLevel += 1;
      return createWriteResult(transactionId, 'committed', 1);
    }
    if (method === 'probe.transactionRollback') {
      const transactionId = readTransactionId(payload);
      if (transactionKinds.get(transactionId) === 'design') createdLevel = 0;
      return {
        ...createWriteResult(transactionId, 'rolled-back', 1),
        rollbackEvidence: { attempted: true, succeeded: true, verifiedClean: true }
      };
    }
    throw new Error(`UNEXPECTED_REQUEST:${method}`);
  });
}

function createPrefabDeletionProbe() {
  const asset = createAsset('prefab-a', 'db://assets/ui/PanelA.prefab', 'cc.Prefab');
  let deleted = false;
  return new RecordingProbeClient((method, payload) => {
    if (method === 'server.editors') return [createEditor()];
    if (method === 'probe.assetIndex') return createAssetIndex(deleted ? [] : [asset]);
    if (method === 'probe.assets') {
      if (deleted) throw new Error('ASSET_NOT_FOUND');
      return {
        assets: [createAssetInfo(asset)],
        details: createAssetInfo(asset),
        meta: { uuid: asset.assetUuid },
        dependencies: ['texture-a'],
        users: ['scene-a'],
        unresolved: []
      };
    }
    if (method === 'probe.writeRevision') {
      return {
        documentId: 'scene-a',
        revision: {
          document: 'sha256:scene',
          hierarchy: 'sha256:hierarchy',
          assetDatabase: deleted ? 'sha256:deleted' : 'sha256:with-prefab',
          scriptCompilation: null,
          prefabGraph: null
        }
      };
    }
    if (method === 'probe.writePrepare') {
      return createWriteResult(readTransactionId(payload), 'validated', 0);
    }
    if (method === 'probe.writeConfirm') {
      deleted = true;
      return createWriteResult(readTransactionId(payload), 'committed', 1);
    }
    throw new Error(`UNEXPECTED_REQUEST:${method}`);
  });
}

function createAssetInfo(asset: ReturnType<typeof createAsset>) {
  return {
    uuid: asset.assetUuid,
    url: asset.url,
    file: asset.filePath,
    type: asset.type,
    importer: asset.importer,
    isSubAsset: asset.isSubAsset,
    isBundle: asset.isBundle,
    name: asset.name,
    source: asset.source,
    path: asset.path,
    displayName: asset.displayName,
    imported: asset.imported,
    invalid: asset.invalid,
    isDirectory: asset.isDirectory,
    visible: asset.visible,
    readonly: asset.readonly,
    unknownFieldCount: 0,
    raw: asset.raw
  };
}

function createEditorState(assetUuid: string) {
  return {
    creatorVersion: '3.8.8',
    projectPath: 'E:/project-a',
    projectId: 'project-a',
    document: { assetUuid, dirty: false, mode: 'prefab', source: 'cce.PrefabFacadeManager' },
    ready: { scene: true, assetDatabase: true },
    selection: { node: [], asset: [assetUuid] },
    preview: null,
    unresolved: []
  };
}

function createDocumentSnapshot(assetUuid: string, withChild = false) {
  const emptyIdentity = {
    sessionId: null,
    assetUuid: null,
    fileId: null,
    objectUuid: null,
    typeId: null,
    scriptUuid: null
  };
  return {
    document: {
      assetUuid,
      path: 'db://assets/ui/PanelA.prefab',
      filePath: 'E:/project-a/assets/ui/PanelA.prefab',
      documentType: 'prefab',
      available: true,
      raw: { assetUuid }
    },
    revision: `revision-${assetUuid}`,
    mode: 'full',
    page: { offset: 0, pageSize: 500, totalNodes: withChild ? 2 : 1, nextCursor: null },
    nodes: [{
      kind: 'node',
      identity: { ...emptyIdentity, objectUuid: 'node-root', fileId: 'file-root' },
      name: 'PanelA',
      path: 'PanelA',
      parentObjectUuid: null,
      childObjectUuids: withChild ? ['node-child'] : [],
      components: []
    }, ...(withChild ? [{
      kind: 'node',
      identity: { ...emptyIdentity, objectUuid: 'node-child', fileId: 'file-child' },
      name: 'Child',
      path: 'PanelA/Child',
      parentObjectUuid: 'node-root',
      childObjectUuids: [],
      components: []
    }] : [])],
    componentSchemas: [],
    prefabInstances: [],
    coverage: {
      nodes: { total: withChild ? 2 : 1, decoded: withChild ? 2 : 1 },
      components: { total: 0, decoded: 0 },
      properties: { total: 0, decoded: 0 },
      references: { total: 0, resolved: 0 },
      prefabInstances: { total: 0, resolved: 0 },
      overrides: { total: 0, decoded: 0 }
    },
    unresolved: [],
    diagnostics: [],
    raw: { hierarchy: { uuid: 'node-root' } }
  };
}

function createSceneSnapshot(
  createdLevel: number,
  temporaryInstancePresent = true,
  assetCreated = false
) {
  const withDialog = createdLevel >= 1 && temporaryInstancePresent;
  const snapshot = createDocumentSnapshot('scene-a', withDialog);
  snapshot.document = {
    ...snapshot.document,
    path: 'db://assets/Main.scene',
    filePath: 'E:/project-a/assets/Main.scene',
    documentType: 'scene'
  };
  snapshot.nodes[0].name = 'Scene';
  snapshot.nodes[0].path = 'Scene';
  snapshot.nodes[0].identity.fileId = 'file-scene';
  snapshot.nodes[0].childObjectUuids = withDialog ? ['node-dialog'] : [];
  if (withDialog) {
    snapshot.nodes[1].identity.objectUuid = 'node-dialog';
    snapshot.nodes[1].identity.fileId = 'file-dialog';
    snapshot.nodes[1].name = 'Dialog';
    snapshot.nodes[1].path = 'Scene/Dialog';
    snapshot.nodes[1].parentObjectUuid = 'node-root';
    if (assetCreated) {
      snapshot.nodes[1].prefabContext = {
        ownerDocumentAssetUuid: 'scene-a',
        sourcePrefabAssetUuid: 'prefab-dialog',
        instanceRootObjectUuid: 'node-dialog',
        sourceObjectFileId: 'file-dialog',
        instanceChain: []
      };
      snapshot.prefabInstances = [{
        ownerDocumentAssetUuid: 'scene-a',
        hostNodePath: 'Scene/Dialog',
        sourcePrefabAssetUuid: 'prefab-dialog',
        instanceRootObjectUuid: 'node-dialog',
        sourceObjectFileId: 'file-dialog',
        instanceFileId: 'instance-dialog',
        prefabRootNodeUuid: 'node-dialog',
        instanceChain: [],
        sync: true,
        state: null,
        propertyOverrides: [],
        targetOverrides: [],
        mountedChildren: [],
        mountedComponents: [],
        removedComponents: [],
        unresolved: [],
        rawPrefabInfo: {},
        raw: {}
      }];
      snapshot.coverage.prefabInstances = { total: 1, resolved: 1 };
    }
  }
  if (createdLevel >= 2) {
    snapshot.nodes[1].childObjectUuids = ['node-child'];
    snapshot.nodes.push({
      ...snapshot.nodes[1],
      identity: { ...snapshot.nodes[1].identity, objectUuid: 'node-child', fileId: 'file-child' },
      name: 'Child',
      path: 'Scene/Dialog/Child',
      parentObjectUuid: 'node-dialog',
      childObjectUuids: []
    });
    snapshot.page.totalNodes = 3;
    snapshot.coverage.nodes = { total: 3, decoded: 3 };
  }
  snapshot.revision = `revision-scene-${createdLevel}`;
  return snapshot;
}

function createCreatedPrefabSnapshot() {
  const snapshot = createDocumentSnapshot('prefab-dialog');
  snapshot.document = {
    ...snapshot.document,
    path: 'db://assets/ui/Dialog.prefab',
    filePath: 'E:/project-a/assets/ui/Dialog.prefab'
  };
  snapshot.nodes[0].name = 'Dialog';
  snapshot.nodes[0].path = 'Dialog';
  snapshot.nodes[0].identity.fileId = 'file-dialog';
  snapshot.revision = 'revision-prefab-dialog';
  return snapshot;
}

function createEditedTree() {
  return [{
    id: '$root',
    fileId: 'file-root',
    name: 'PanelA',
    children: [{ id: '$child', name: 'Child' }]
  }];
}

function readTransactionId(payload: unknown): string {
  return (payload as { params: { transactionId: string } }).params.transactionId;
}

function createWriteResult(transactionId: string, status: string, executedOps: number) {
  return {
    transactionId,
    status,
    executedOps,
    verification: status === 'committed'
      ? {
          passed: true,
          verifiedAt: '2026-07-28T00:00:00.000Z',
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

function readStructured(result: { structuredContent?: unknown }) {
  return result.structuredContent as {
    page: { nextCursor: string | null };
  };
}
