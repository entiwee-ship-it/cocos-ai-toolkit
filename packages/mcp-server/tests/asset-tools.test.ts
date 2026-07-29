import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadonlyProbeClient } from '@cocos-ai/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createCocosMcpServer } from '../src/server.js';

interface AssetState {
  assetUuid: string;
  url: string;
  type: string;
}

class RecordingProbeClient implements ReadonlyProbeClient {
  readonly requests: Array<{ method: string; payload: unknown }> = [];

  constructor(private readonly respond: (method: string, payload: unknown) => unknown) {}

  async request(method: string, payload: unknown): Promise<unknown> {
    this.requests.push({ method, payload });
    return this.respond(method, payload);
  }
}

const harnesses: Array<{ server: McpServer; client: Client }> = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(async ({ server, client }) => {
    await client.close();
    await server.close();
  }));
});

describe('通用 AssetDB MCP 工具', () => {
  it('组件脚本创建、移动、Meta 写入和删除均走事务且 UUID 不漂移', async () => {
    const probe = createAssetLifecycleProbe();
    const { client } = await createHarness(probe);

    const created = await client.callTool({
      name: 'cocos_asset_create',
      arguments: {
        projectId: 'project-a',
        assetUrl: 'db://assets/ui/Dialog.ts',
        assetKind: 'component-script',
        content: 'export class Dialog {}',
        mode: 'apply'
      }
    });
    expect(created.isError, JSON.stringify(created.content)).not.toBe(true);
    expect(created.structuredContent).toMatchObject({ asset: { assetUuid: 'script-dialog' } });

    const moved = await client.callTool({
      name: 'cocos_asset_move',
      arguments: {
        projectId: 'project-a', uuid: 'script-dialog',
        targetUrl: 'db://assets/view/Dialog.ts', mode: 'apply'
      }
    });
    expect(moved.isError, JSON.stringify(moved.content)).not.toBe(true);
    expect(moved.structuredContent).toMatchObject({ asset: { assetUuid: 'script-dialog', url: 'db://assets/view/Dialog.ts' } });

    const meta = await client.callTool({
      name: 'cocos_asset_write_meta',
      arguments: {
        projectId: 'project-a', uuid: 'script-dialog',
        meta: { userData: { priority: 1 } }, mode: 'apply'
      }
    });
    expect(meta.isError, JSON.stringify(meta.content)).not.toBe(true);
    expect(meta.structuredContent).toMatchObject({ meta: { userData: { priority: 1 } } });

    const deleted = await client.callTool({
      name: 'cocos_asset_delete',
      arguments: {
        projectId: 'project-a', uuid: 'script-dialog', mode: 'apply',
        confirmAssetUrl: 'db://assets/view/Dialog.ts'
      }
    });
    expect(deleted.isError, JSON.stringify(deleted.content)).not.toBe(true);
    expect(deleted.structuredContent).toMatchObject({ result: { status: 'committed' } });

    const prepareOperations = probe.requests
      .filter((request) => request.method === 'probe.writePrepare')
      .map((request) => (request.payload as { params: { operations: unknown[] } }).params.operations[0]);
    expect(prepareOperations).toMatchObject([
      { type: 'asset.create', assetKind: 'component-script' },
      { type: 'asset.move', expectedAssetUuid: 'script-dialog' },
      { type: 'asset.write_meta', expectedAssetUuid: 'script-dialog' },
      { type: 'asset.delete', expectedAssetUuid: 'script-dialog' }
    ]);
    const prepareSaveFlags = probe.requests
      .filter((request) => request.method === 'probe.writePrepare')
      .map((request) => (request.payload as { params: { save: boolean } }).params.save);
    expect(prepareSaveFlags).toEqual([false, false, false, false]);
  });

  it('Prefab 创建缺少现有节点时拒绝空模板路径', async () => {
    const { client } = await createHarness(createAssetLifecycleProbe());
    const result = await client.callTool({
      name: 'cocos_asset_create',
      arguments: {
        projectId: 'project-a', assetUrl: 'db://assets/ui/Empty.prefab',
        assetKind: 'prefab', mode: 'apply'
      }
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('ASSET_CREATE_SOURCE_NODE_REQUIRED');
  });

  it('当前文档为空时资产事务使用空 revision，不阻塞 AssetDB 写入', async () => {
    const probe = createAssetLifecycleProbe({ revisionUnavailable: true });
    const { client } = await createHarness(probe);

    const result = await client.callTool({
      name: 'cocos_asset_create',
      arguments: {
        projectId: 'project-a', assetUrl: 'db://assets/validation',
        assetKind: 'folder', mode: 'apply'
      }
    });

    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(probe.requests.find((request) => request.method === 'probe.writePrepare')?.payload)
      .toMatchObject({
        params: {
          revision: {
            document: null,
            hierarchy: null,
            assetDatabase: null,
            scriptCompilation: null,
            prefabGraph: null
          }
        }
      });
  });

  it('安全文本更新通过精确 UUID、唯一旧文本和可选 SHA 前置进入事务', async () => {
    const probe = createAssetLifecycleProbe();
    const { client } = await createHarness(probe);
    await client.callTool({
      name: 'cocos_asset_create',
      arguments: {
        projectId: 'project-a', assetUrl: 'db://assets/script/GameUIConfig.ts',
        assetKind: 'component-script', content: 'export enum UIID { Lobby }', mode: 'apply'
      }
    });

    const result = await client.callTool({
      name: 'cocos_asset_update_text',
      arguments: {
        projectId: 'project-a', uuid: 'script-dialog',
        expectedCurrentSha256: 'a'.repeat(64),
        oldText: 'Lobby', newText: 'Lobby, CocosAiValidation', mode: 'apply'
      }
    });

    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    const operation = probe.requests
      .filter((request) => request.method === 'probe.writePrepare')
      .map((request) => (request.payload as { params: { operations: unknown[] } }).params.operations[0])
      .at(-1);
    expect(operation).toEqual({
      type: 'asset.update_text',
      assetUrl: 'db://assets/script/GameUIConfig.ts',
      expectedAssetUuid: 'script-dialog',
      expectedCurrentSha256: 'a'.repeat(64),
      oldText: 'Lobby',
      newText: 'Lobby, CocosAiValidation'
    });
  });
});

function createAssetLifecycleProbe(
  options: { revisionUnavailable?: boolean } = {}
): RecordingProbeClient {
  let asset: AssetState | null = null;
  let meta: Record<string, unknown> = {};
  const pending = new Map<string, Record<string, unknown>>();
  return new RecordingProbeClient((method, payload) => {
    if (method === 'server.editors') return [createEditor()];
    if (method === 'probe.assetIndex') return createAssetIndex(asset ? [asset] : []);
    if (method === 'probe.assets') {
      if (!asset) throw new Error('ASSET_NOT_FOUND');
      const info = createAssetInfo(asset);
      return { assets: [info], details: info, meta, dependencies: [], users: [], unresolved: [] };
    }
    if (method === 'probe.writeRevision') {
      if (options.revisionUnavailable) {
        throw new Error('ASSET_FILE_PATH_UNAVAILABLE: details={}');
      }
      return {
        documentId: 'scene-a',
        revision: {
          document: 'sha256:scene', hierarchy: 'sha256:hierarchy',
          assetDatabase: asset ? `sha256:${asset.url}` : 'sha256:empty',
          scriptCompilation: null, prefabGraph: null
        }
      };
    }
    if (method === 'probe.writePrepare') {
      const params = (payload as { params: { transactionId: string; operations: Record<string, unknown>[] } }).params;
      pending.set(params.transactionId, params.operations[0]);
      return createWriteResult(params.transactionId, 'validated', 0);
    }
    if (method === 'probe.writeConfirm') {
      const transactionId = (payload as { params: { transactionId: string } }).params.transactionId;
      const operation = pending.get(transactionId)!;
      if (operation.type === 'asset.create') {
        asset = { assetUuid: 'script-dialog', url: String(operation.assetUrl), type: 'cc.Script' };
      } else if (operation.type === 'asset.move' && asset) {
        asset = { ...asset, url: String(operation.targetUrl) };
      } else if (operation.type === 'asset.write_meta') {
        meta = operation.meta as Record<string, unknown>;
      } else if (operation.type === 'asset.delete') {
        asset = null;
      }
      return createWriteResult(transactionId, 'committed', 1);
    }
    throw new Error(`UNEXPECTED_REQUEST:${method}`);
  });
}

async function createHarness(probeClient: ReadonlyProbeClient) {
  const server = createCocosMcpServer({ probeClient, reportRoot: 'reports' }, { enableWrites: true });
  const client = new Client({ name: 'asset-tools-test', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  harnesses.push({ server, client });
  return { server, client };
}

function createEditor() {
  return {
    editorInstanceId: 'editor-a', projectId: 'project-a', projectPath: 'E:/project-a',
    creatorVersion: '3.8.8', bridgeVersion: '0.1.0',
    capabilities: ['probe.assetIndex', 'probe.assets', 'probe.writeRevision', 'probe.writePrepare', 'probe.writeConfirm']
  };
}

function createAssetIndex(assets: AssetState[]) {
  return {
    assets: assets.map((asset) => createAssetRecord(asset)),
    scripts: [], documents: [], unresolved: []
  };
}

function createAssetRecord(asset: AssetState) {
  const name = asset.url.split('/').at(-1)?.replace(/\.[^.]+$/, '') ?? asset.assetUuid;
  return {
    assetUuid: asset.assetUuid, url: asset.url, filePath: `E:/project-a/${asset.url.slice('db://'.length)}`,
    type: asset.type, importer: 'typescript', name, displayName: name, source: asset.url, path: asset.url,
    isSubAsset: false, isBundle: false, imported: true, invalid: false, isDirectory: false,
    visible: true, readonly: false, available: true, raw: { uuid: asset.assetUuid, url: asset.url }
  };
}

function createAssetInfo(asset: AssetState) {
  const record = createAssetRecord(asset);
  return {
    uuid: record.assetUuid, url: record.url, file: record.filePath, type: record.type,
    importer: record.importer, isSubAsset: false, isBundle: false, name: record.name,
    source: record.source, path: record.path, displayName: record.displayName,
    imported: true, invalid: false, isDirectory: false, visible: true, readonly: false,
    unknownFieldCount: 0, raw: record.raw
  };
}

function createWriteResult(transactionId: string, status: string, executedOps: number) {
  return {
    transactionId, status, executedOps,
    verification: status === 'committed' ? {
      passed: true, verifiedAt: '2026-07-28T00:00:00.000Z',
      items: [{ operationIndex: 0, description: 'asset', expected: true, actual: true, passed: true }]
    } : null,
    failure: null, rollbackEvidence: null
  };
}
