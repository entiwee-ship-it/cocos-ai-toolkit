import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  ProjectScanAssetIndexArtifactSchema,
  ProjectScanReportManifestSchema,
  type DocumentSnapshot
} from '@cocos-ai/protocol';
import {
  PROJECT_SCAN_READONLY_METHODS,
  ProjectScanner,
  type ReadonlyProbeClient
} from '../src/project-scanner.js';
import type {
  ScanCheckpoint,
  ScanCheckpointDocument
} from '../src/scan-checkpoint.js';
import {
  JsonScanReportWriter,
  type ScanReportWriter
} from '../src/report-writer.js';

interface RequestedCall {
  method: string;
  payload: unknown;
}

class FakeReportWriter implements ScanReportWriter {
  readonly checkpoints: ScanCheckpoint[] = [];
  readonly snapshots = new Map<string, DocumentSnapshot>();
  readonly reports: unknown[] = [];
  readonly events: Array<'checkpoint' | 'report'> = [];

  async writeDocument(snapshot: DocumentSnapshot) {
    const assetUuid = snapshot.document.assetUuid;
    if (!assetUuid) throw new Error('TEST_DOCUMENT_UUID_MISSING');
    const reference = {
      assetUuid,
      revision: snapshot.revision,
      snapshotPath: `memory/${assetUuid}.json`,
      snapshotHash: `${assetUuid}-hash`,
      summary: {
        path: snapshot.document.path,
        documentType: snapshot.document.documentType,
        nodes: snapshot.nodes.length,
        components: snapshot.componentSchemas.length,
        prefabInstances: snapshot.prefabInstances.length,
        unresolved: snapshot.unresolved.length,
        diagnostics: snapshot.diagnostics.length
      },
      coverage: snapshot.coverage
    };
    this.snapshots.set(reference.snapshotPath, structuredClone(snapshot));
    return reference;
  }

  async readDocument(reference: ScanCheckpointDocument) {
    const snapshot = this.snapshots.get(reference.snapshotPath);
    if (!snapshot) throw new Error('TEST_SNAPSHOT_NOT_FOUND');
    return structuredClone(snapshot);
  }

  async writeCheckpoint(checkpoint: ScanCheckpoint): Promise<string | null> {
    this.checkpoints.push(structuredClone(checkpoint));
    this.events.push('checkpoint');
    return null;
  }

  async writeReport(
    report: unknown,
    _documents: ScanCheckpointDocument[]
  ): Promise<string | null> {
    this.reports.push(structuredClone(report));
    this.events.push('report');
    return null;
  }
}

class FakeEditorClient implements ReadonlyProbeClient {
  readonly calls: RequestedCall[] = [];
  readonly openedAssets: string[] = [];

  constructor(
    private readonly snapshotFailureAssetUuid: string | null = null,
    private readonly editors = [createEditorSession()]
  ) {}

  async request(method: string, payload: unknown): Promise<unknown> {
    this.calls.push({ method, payload });
    if (method === 'server.editors') return this.editors;
    if (method === 'probe.assetIndex') return createAssetIndex();
    if (method === 'probe.openAsset') {
      const assetUuid = readAssetUuid(payload);
      this.openedAssets.push(assetUuid);
      return { opened: true, uuid: assetUuid };
    }
    if (method === 'probe.editorState') {
      return {
        ready: { scene: true, assetDatabase: true },
        unresolved: []
      };
    }
    if (method === 'probe.documentSnapshot') {
      const assetUuid = readDocumentAssetUuid(payload);
      if (assetUuid === this.snapshotFailureAssetUuid) {
        throw new Error('DOCUMENT_COMPONENT_QUERY_FAILED');
      }
      return createDocumentSnapshot(assetUuid);
    }
    throw new Error(`UNEXPECTED_METHOD:${method}`);
  }
}

describe('ProjectScanner', () => {
  it('严格顺序扫描 Scene/Prefab，并把单资源失败写入 checkpoint 和缺口报告', async () => {
    const client = new FakeEditorClient('prefab-b');
    const writer = new FakeReportWriter();
    const scanner = new ProjectScanner(client, writer);

    const result = await scanner.scan({
      projectId: 'project-1',
      pageSize: 100,
      readyTimeoutMs: 20,
      readyPollIntervalMs: 0
    });

    expect(result.status).toBe('completed-with-gaps');
    expect(client.openedAssets).toEqual(['scene-a', 'prefab-b']);
    expect(result.checkpoint.completedAssetUuids).toEqual(['scene-a', 'prefab-b']);
    expect(result.checkpoint.failures).toContainEqual(expect.objectContaining({
      assetUuid: 'prefab-b',
      code: 'DOCUMENT_COMPONENT_QUERY_FAILED'
    }));
    expect(result.unresolved).toContainEqual(expect.objectContaining({
      path: 'documents.prefab-b',
      reason: 'DOCUMENT_COMPONENT_QUERY_FAILED'
    }));
    expect(result.coverage).toMatchObject({
      assets: { total: 3, decoded: 3 },
      scripts: { total: 1, decoded: 1 },
      documents: { total: 2, decoded: 1 },
      nodes: { total: 1, decoded: 1 }
    });
    expect(writer.checkpoints).toHaveLength(3);
    expect(writer.reports).toHaveLength(1);
    expect(writer.checkpoints.at(-1)).toEqual(result.checkpoint);
    expect(writer.events.slice(-2)).toEqual(['checkpoint', 'report']);
    expect(new Set(client.calls.map((call) => call.method))).toEqual(new Set(
      PROJECT_SCAN_READONLY_METHODS
    ));
  });

  it('合并同一文档的分页快照并重写下一页 unresolved 索引', async () => {
    let page = 0;
    const client: ReadonlyProbeClient = {
      request: async (method, payload) => {
        if (method === 'server.editors') return [createEditorSession()];
        if (method === 'probe.assetIndex') {
          const index = createAssetIndex();
          return {
            ...index,
            assets: index.assets.slice(0, 1),
            scripts: [],
            documents: index.documents.slice(0, 1)
          };
        }
        if (method === 'probe.openAsset') return { opened: true };
        if (method === 'probe.editorState') {
          return { ready: { scene: true, assetDatabase: true } };
        }
        if (method === 'probe.documentSnapshot') {
          const cursor = readParams(payload).cursor;
          page += 1;
          return cursor
            ? createDocumentSnapshot('scene-a', {
                offset: 1,
                nodeUuid: 'scene-node-2',
                nextCursor: null,
                unresolved: [{
                  path: 'componentSchemas.0.scriptPath',
                  reason: 'SCRIPT_PATH_NOT_FOUND'
                }]
              })
            : createDocumentSnapshot('scene-a', {
                offset: 0,
                nodeUuid: 'scene-node-1',
                nextCursor: 'next-page',
                componentUuid: 'component-1'
              });
        }
        throw new Error(`UNEXPECTED_METHOD:${method}`);
      }
    };
    const scanner = new ProjectScanner(client, new FakeReportWriter());

    const result = await scanner.scan({ projectId: 'project-1', pageSize: 1 });

    expect(page).toBe(2);
    expect(result.documentSummaries).toEqual([expect.objectContaining({
      assetUuid: 'scene-a',
      nodes: 2,
      components: 1,
      unresolved: 1
    })]);
    expect(result.checkpoint.documents[0]).not.toHaveProperty('nodes');
  });

  it('资产清单或版本变化时拒绝使用旧 checkpoint', async () => {
    const firstClient = new FakeEditorClient();
    const firstResult = await new ProjectScanner(
      firstClient,
      new FakeReportWriter()
    ).scan({ projectId: 'project-1' });
    const staleCheckpoint = {
      ...firstResult.checkpoint,
      assetManifestHash: 'stale-manifest'
    };
    const resumedClient = new FakeEditorClient();

    await expect(new ProjectScanner(
      resumedClient,
      new FakeReportWriter()
    ).scan({
      projectId: 'project-1',
      checkpoint: staleCheckpoint
    })).rejects.toThrow('SCAN_CHECKPOINT_STALE');
    expect(resumedClient.openedAssets).toEqual([]);
  });

  it('扫描参数变化时拒绝使用旧 checkpoint', async () => {
    const firstResult = await new ProjectScanner(
      new FakeEditorClient(),
      new FakeReportWriter()
    ).scan({ projectId: 'project-1' });

    await expect(new ProjectScanner(
      new FakeEditorClient(),
      new FakeReportWriter()
    ).scan({
      projectId: 'project-1',
      pageSize: 50,
      checkpoint: firstResult.checkpoint
    })).rejects.toThrow('SCAN_CHECKPOINT_STALE:parameters');
  });

  it.each([
    ['Creator 版本', (checkpoint: ScanCheckpoint) => ({
      ...checkpoint,
      creatorVersion: '3.8.9'
    })],
    ['Bridge 版本', (checkpoint: ScanCheckpoint) => ({
      ...checkpoint,
      bridgeVersion: '0.2.0'
    })],
    ['协议版本', (checkpoint: ScanCheckpoint) => ({
      ...checkpoint,
      protocolVersion: '0.3.0'
    })],
    ['资产 UUID 清单', (checkpoint: ScanCheckpoint) => ({
      ...checkpoint,
      assetUuids: [...checkpoint.assetUuids, 'new-prefab']
    })]
  ])('%s 变化时拒绝使用旧 checkpoint', async (_label, mutateCheckpoint) => {
    const firstResult = await new ProjectScanner(
      new FakeEditorClient(),
      new FakeReportWriter()
    ).scan({ projectId: 'project-1' });

    await expect(new ProjectScanner(
      new FakeEditorClient(),
      new FakeReportWriter()
    ).scan({
      projectId: 'project-1',
      checkpoint: mutateCheckpoint(firstResult.checkpoint)
    })).rejects.toThrow('SCAN_CHECKPOINT_STALE');
  });

  it('有效 checkpoint 续扫时跳过已完成资产', async () => {
    const writer = new FakeReportWriter();
    const initialResult = await new ProjectScanner(
      new FakeEditorClient(),
      writer
    ).scan({ projectId: 'project-1' });
    const checkpoint: ScanCheckpoint = {
      ...initialResult.checkpoint,
      completedAssetUuids: ['scene-a'],
      documents: initialResult.checkpoint.documents.filter((document) =>
        document.assetUuid === 'scene-a'
      )
    };
    const resumedClient = new FakeEditorClient();

    const result = await new ProjectScanner(
      resumedClient,
      writer
    ).scan({ projectId: 'project-1', checkpoint });

    expect(resumedClient.openedAssets).toEqual(['prefab-b']);
    expect(result.checkpoint.completedAssetUuids).toEqual(['scene-a', 'prefab-b']);
    expect(result.scanId).toBe(initialResult.scanId);
    expect(result.documentSummaries).toHaveLength(2);
  });

  it('同一项目存在多个编辑器且未指定实例时立即拒绝扫描', async () => {
    const client = new FakeEditorClient(null, [
      createEditorSession('editor-1'),
      createEditorSession('editor-2')
    ]);

    await expect(new ProjectScanner(client, new FakeReportWriter()).scan({
      projectId: 'project-1'
    })).rejects.toThrow('MULTIPLE_EDITOR_INSTANCES');
    expect(client.openedAssets).toEqual([]);
  });

  it('JSON writer 连续写入时原子覆盖旧 checkpoint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocos-ai-core-'));
    const reportPath = join(directory, 'report.json');
    const checkpointPath = join(directory, 'checkpoint.json');
    try {
      const result = await new ProjectScanner(
        new FakeEditorClient(),
        new FakeReportWriter()
      ).scan({ projectId: 'project-1' });
      const writer = new JsonScanReportWriter(reportPath, checkpointPath);
      const firstCheckpoint = {
        ...result.checkpoint,
        completedAssetUuids: ['scene-a']
      };

      await writer.writeCheckpoint(firstCheckpoint);
      await writer.writeCheckpoint(result.checkpoint);

      const written = JSON.parse(await readFile(checkpointPath, 'utf8')) as ScanCheckpoint;
      expect(written.completedAssetUuids).toEqual(['scene-a', 'prefab-b']);
      expect(await readdir(directory)).toEqual(['checkpoint.json']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('JSON writer 压缩文档分片并生成不内联大对象的有界 manifest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocos-ai-core-'));
    const reportPath = join(directory, 'report.json');
    const checkpointPath = join(directory, 'checkpoint.json');
    try {
      const writer = new JsonScanReportWriter(reportPath, checkpointPath, directory);
      const result = await new ProjectScanner(
        new FakeEditorClient(),
        writer
      ).scan({ projectId: 'project-1' });

      const reportText = await readFile(reportPath, 'utf8');
      const report = ProjectScanReportManifestSchema.parse(
        JSON.parse(reportText)
      );
      expect(report.scanId).toBe(result.scanId);
      expect(report.summary).toMatchObject({
        assets: 3,
        scripts: 1,
        documents: 2,
        completedDocuments: 2,
        failedDocuments: 0
      });
      expect(report.artifacts.documentSnapshots).toEqual({
        count: 2,
        gzipCount: 2,
        jsonCount: 0
      });
      const checkpointBytes = await readFile(checkpointPath);
      expect(report.artifacts.checkpoint).toEqual({
        path: 'checkpoint.json',
        sha256: createHash('sha256').update(checkpointBytes).digest('hex'),
        bytes: checkpointBytes.byteLength,
        encoding: 'json'
      });
      expect(report).not.toHaveProperty('documents');
      expect(reportText).not.toContain('scene-a-node');
      expect((await stat(reportPath)).size).toBeLessThan(10_000);

      const assetIndexPath = join(directory, report.artifacts.assetIndex.path);
      const assetIndexBytes = await readFile(assetIndexPath);
      expect(report.artifacts.assetIndex).toEqual({
        path: 'report.assets.json.gz',
        sha256: createHash('sha256').update(assetIndexBytes).digest('hex'),
        bytes: assetIndexBytes.byteLength,
        encoding: 'json-gzip'
      });
      const assetIndex = ProjectScanAssetIndexArtifactSchema.parse(JSON.parse(
        gunzipSync(assetIndexBytes).toString('utf8')
      ));
      expect(assetIndex).toMatchObject({
        formatVersion: 1,
        scanId: result.scanId
      });
      expect(assetIndex.assets).toHaveLength(3);
      expect(assetIndex.scripts).toHaveLength(1);

      const snapshotFiles = await readdir(join(directory, 'checkpoint.json.documents'));
      expect(snapshotFiles).toHaveLength(2);
      expect(snapshotFiles.every((file) => file.endsWith('.json.gz'))).toBe(true);
      for (const document of result.checkpoint.documents) {
        const snapshotBytes = await readFile(join(directory, document.snapshotPath));
        expect(document.snapshotHash).toBe(
          createHash('sha256').update(snapshotBytes).digest('hex')
        );
      }
      await expect(writer.readDocument(result.checkpoint.documents[0])).resolves.toMatchObject({
        document: { assetUuid: 'scene-a' }
      });
      expect(result.checkpoint.documents.every((document) =>
        !('nodes' in document)
      )).toBe(true);
      expect((await readdir(directory)).sort()).toEqual([
        'checkpoint.json',
        'checkpoint.json.documents',
        'report.assets.json.gz',
        'report.json'
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('JSON writer 继续读取旧 checkpoint 的未压缩文档分片', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocos-ai-core-'));
    const reportPath = join(directory, 'report.json');
    const checkpointPath = join(directory, 'checkpoint.json');
    const snapshotDirectory = `${checkpointPath}.documents`;
    try {
      await mkdir(snapshotDirectory);
      const snapshot = createDocumentSnapshot('scene-a');
      const serialized = `${JSON.stringify(snapshot)}\n`;
      const snapshotPath = join(snapshotDirectory, 'legacy.json');
      await writeFile(snapshotPath, serialized, 'utf8');
      const writer = new JsonScanReportWriter(reportPath, checkpointPath, directory);

      await expect(writer.readDocument({
        assetUuid: 'scene-a',
        revision: snapshot.revision,
        snapshotPath: 'checkpoint.json.documents/legacy.json',
        snapshotHash: createHash('sha256').update(serialized).digest('hex'),
        summary: {
          path: snapshot.document.path,
          documentType: snapshot.document.documentType,
          nodes: snapshot.nodes.length,
          components: snapshot.componentSchemas.length,
          prefabInstances: snapshot.prefabInstances.length,
          unresolved: snapshot.unresolved.length,
          diagnostics: snapshot.diagnostics.length
        },
        coverage: snapshot.coverage
      })).resolves.toMatchObject({
        document: { assetUuid: 'scene-a' },
        revision: snapshot.revision
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

/**
 * 创建 Server 编辑器会话夹具。
 *
 * @param editorInstanceId 编辑器实例标识。
 * @returns 可被扫描器选择的 Creator 3.8.8 会话。
 */
function createEditorSession(editorInstanceId = 'editor-1') {
  return {
    editorInstanceId,
    projectId: 'project-1',
    projectPath: 'E:/project',
    creatorVersion: '3.8.8',
    bridgeVersion: '0.1.0',
    capabilities: [
      'probe.editorState',
      'probe.assetIndex',
      'probe.openAsset',
      'probe.documentSnapshot'
    ]
  };
}

/**
 * 创建包含 Scene、Prefab 和脚本的资产索引夹具。
 *
 * @returns 可供项目扫描器消费的完整资产索引。
 */
function createAssetIndex() {
  const scene = createAssetRecord('scene-a', 'db://assets/scene-a.scene', 'cc.SceneAsset');
  const prefab = createAssetRecord('prefab-b', 'db://assets/prefab-b.prefab', 'cc.Prefab');
  const script = createAssetRecord('script-c', 'db://assets/script-c.ts', 'cc.Script');
  return {
    assets: [scene, prefab, script],
    scripts: [{
      assetUuid: 'script-c',
      scriptPath: 'db://assets/script-c.ts',
      filePath: 'E:/project/assets/script-c.ts',
      classNames: [],
      available: true,
      raw: {}
    }],
    documents: [
      {
        assetUuid: 'scene-a',
        path: 'db://assets/scene-a.scene',
        filePath: 'E:/project/assets/scene-a.scene',
        documentType: 'scene',
        available: true,
        raw: {}
      },
      {
        assetUuid: 'prefab-b',
        path: 'db://assets/prefab-b.prefab',
        filePath: 'E:/project/assets/prefab-b.prefab',
        documentType: 'prefab',
        available: true,
        raw: {}
      }
    ],
    unresolved: []
  };
}

/**
 * 创建协议要求的资产记录。
 *
 * @param assetUuid 资产 UUID。
 * @param url Creator db URL。
 * @param type Creator 资产类型。
 * @returns 完整资产记录。
 */
function createAssetRecord(assetUuid: string, url: string, type: string) {
  return {
    assetUuid,
    url,
    filePath: `E:/project/assets/${assetUuid}`,
    type,
    importer: null,
    name: assetUuid,
    displayName: assetUuid,
    source: null,
    path: url,
    isSubAsset: false,
    isBundle: false,
    imported: true,
    invalid: false,
    isDirectory: false,
    visible: true,
    readonly: false,
    available: true,
    raw: {}
  };
}

/**
 * 创建单页文档快照夹具。
 *
 * @param assetUuid 文档资产 UUID。
 * @param options 分页、节点、组件和缺口覆盖项。
 * @returns 符合只读协议的文档快照。
 */
function createDocumentSnapshot(
  assetUuid: string,
  options: {
    offset?: number;
    nodeUuid?: string;
    componentUuid?: string;
    nextCursor?: string | null;
    unresolved?: Array<{ path: string; reason: string }>;
  } = {}
) {
  const offset = options.offset ?? 0;
  const nodeUuid = options.nodeUuid ?? `${assetUuid}-node`;
  const componentSchemas = options.componentUuid
    ? [{
        className: 'cc.Transform',
        qualifiedName: 'cc.Transform',
        typeId: 'cc.Transform',
        scriptUuid: null,
        scriptPath: null,
        inheritance: ['cc.Component', 'cc.Object'],
        executionOrder: null,
        properties: [],
        rawClassAttributes: {},
        unresolved: [],
        componentUuid: options.componentUuid,
        componentFileId: `${options.componentUuid}-file`,
        nodeUuid,
        nodePath: `/${nodeUuid}`,
        componentIndex: 0
      }]
    : [];
  return {
    document: {
      assetUuid,
      path: assetUuid === 'scene-a'
        ? 'db://assets/scene-a.scene'
        : 'db://assets/prefab-b.prefab',
      filePath: assetUuid === 'scene-a'
        ? 'E:/project/assets/scene-a.scene'
        : 'E:/project/assets/prefab-b.prefab',
      documentType: assetUuid === 'scene-a' ? 'scene' : 'prefab',
      available: true,
      raw: {}
    },
    revision: `${assetUuid}-revision`,
    mode: 'full',
    page: {
      offset,
      pageSize: 1,
      totalNodes: options.nextCursor ? 2 : offset + 1,
      nextCursor: options.nextCursor ?? null
    },
    nodes: [{
      kind: 'node',
      identity: {
        sessionId: null,
        objectUuid: nodeUuid,
        assetUuid: null,
        fileId: `${nodeUuid}-file`,
        typeId: 'cc.Node',
        scriptUuid: null
      },
      name: nodeUuid,
      path: `/${nodeUuid}`,
      parentObjectUuid: null,
      childObjectUuids: [],
      siblingIndex: offset,
      active: true,
      layer: 0,
      localTransform: null
    }],
    componentSchemas,
    prefabInstances: [],
    coverage: {
      nodes: { total: options.nextCursor ? 2 : offset + 1, decoded: options.nextCursor ? 2 : offset + 1 },
      components: { total: componentSchemas.length, decoded: componentSchemas.length },
      properties: { total: 0, decoded: 0 },
      references: { total: 0, resolved: 0 },
      prefabInstances: { total: 0, resolved: 0 },
      overrides: { total: 0, decoded: 0 }
    },
    unresolved: options.unresolved ?? [],
    diagnostics: []
  };
}

/**
 * 从 Server 转发载荷读取普通参数对象。
 *
 * @param payload 扫描器发送的 Server 请求载荷。
 * @returns params 普通对象。
 */
function readParams(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const params = (payload as { params?: unknown }).params;
  return params && typeof params === 'object' && !Array.isArray(params)
    ? params as Record<string, unknown>
    : {};
}

function readAssetUuid(payload: unknown): string {
  const uuid = readParams(payload).uuid;
  if (typeof uuid !== 'string') throw new Error('TEST_ASSET_UUID_MISSING');
  return uuid;
}

function readDocumentAssetUuid(payload: unknown): string {
  const document = readParams(payload).document;
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('TEST_DOCUMENT_MISSING');
  }
  const assetUuid = (document as { assetUuid?: unknown }).assetUuid;
  if (typeof assetUuid !== 'string') throw new Error('TEST_DOCUMENT_UUID_MISSING');
  return assetUuid;
}
