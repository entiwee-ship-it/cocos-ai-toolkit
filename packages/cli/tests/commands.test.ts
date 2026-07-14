import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { ProbeClient } from '../src/client.js';
import { parseCommand, type CliCommand } from '../src/commands.js';
import * as cliModule from '../src/index.js';
import {
  createAssetManifestHash,
  createScanCheckpoint
} from '../../core/src/scan-checkpoint.js';
import { PROTOCOL_VERSION } from '../../protocol/src/envelope.js';

const { toRequest } = cliModule;

describe('parseCommand', () => {
  it('解析带明确编辑器实例的层级探针', () => {
    expect(parseCommand([
      'hierarchy',
      '--project-id', 'project-1',
      '--editor-instance-id', 'editor-1',
      '--depth', '3'
    ])).toEqual({
      command: 'hierarchy',
      projectId: 'project-1',
      editorInstanceId: 'editor-1',
      depth: 3
    });
  });

  it.each(['0', '-1', '21'])('拒绝非法层级深度 %s', (depth) => {
    expect(() => parseCommand([
      'hierarchy',
      '--project-id', 'project-1',
      '--depth', depth
    ])).toThrow('INVALID_DEPTH');
  });

  it('拒绝缺少 project-id 的节点查询', () => {
    expect(() => parseCommand(['node', '--uuid', 'node-1'])).toThrow('PROJECT_ID_REQUIRED');
  });

  it('解析带 UUID 的资源详情查询', () => {
    expect(parseCommand([
      'assets', '--project-id', 'project-1', '--pattern', 'db://assets/a.prefab', '--uuid', 'asset-1'
    ])).toEqual({
      command: 'assets',
      projectId: 'project-1',
      pattern: 'db://assets/a.prefab',
      uuid: 'asset-1'
    });
  });

  it('解析两阶段 Undo 保存事务且 prepare 不要求节点 UUID', () => {
    const prepared = parseCommand([
      'probe-undo-save-prepare',
      '--project-id', 'project-1',
      '--project-path', 'E:/xile-workspace/worktrees/xy-client-cocos-ai-probe',
      '--document-uuid', 'asset-1',
      '--probe-name', 'CocosAiProbe_123'
    ]);
    expect(prepared).toMatchObject({
      command: 'probe-undo-save-prepare',
      documentUuid: 'asset-1',
      probeName: 'CocosAiProbe_123'
    });
    expect(toRequest(prepared)).toEqual(['probe.undoSavePrepare', {
      selector: { projectId: 'project-1' },
      params: {
        projectPath: 'E:/xile-workspace/worktrees/xy-client-cocos-ai-probe',
        documentAssetUuid: 'asset-1',
        probeName: 'CocosAiProbe_123'
      }
    }]);
  });

  it('解析 confirm 和 status 事务命令', () => {
    const confirm = parseCommand([
      'probe-undo-save-confirm',
      '--project-id', 'project-1',
      '--transaction-id', 'transaction-1',
      '--expected-revision', 'revision-1'
    ]);
    const status = parseCommand([
      'probe-undo-save-status',
      '--project-id', 'project-1',
      '--transaction-id', 'transaction-1'
    ]);

    expect(toRequest(confirm)).toEqual(['probe.undoSaveConfirm', {
      selector: { projectId: 'project-1' },
      params: { transactionId: 'transaction-1', expectedRevision: 'revision-1' }
    }]);
    expect(toRequest(status)).toEqual(['probe.undoSaveStatus', {
      selector: { projectId: 'project-1' },
      params: { transactionId: 'transaction-1' }
    }]);
  });

  it('解析阶段一原子只读命令', () => {
    const assetIndex = parseCommand(['asset-index', '--project-id', 'project-1']);
    const componentSchema = parseCommand([
      'component-schema', '--project-id', 'project-1', '--uuid', 'component-1'
    ]);
    const documentSnapshot = parseCommand([
      'document-snapshot',
      '--project-id', 'project-1',
      '--editor-instance-id', 'editor-1',
      '--mode', 'full',
      '--page-size', '200',
      '--cursor', 'cursor-1'
    ]);

    expect(assetIndex).toEqual({ command: 'asset-index', projectId: 'project-1' });
    expect(componentSchema).toEqual({
      command: 'component-schema',
      projectId: 'project-1',
      uuid: 'component-1'
    });
    expect(documentSnapshot).toEqual({
      command: 'document-snapshot',
      projectId: 'project-1',
      editorInstanceId: 'editor-1',
      mode: 'full',
      pageSize: 200,
      cursor: 'cursor-1'
    });

    expect(toRequest(assetIndex)).toEqual([
      'probe.assetIndex',
      { selector: { projectId: 'project-1' }, params: {} }
    ]);
    expect(toRequest(componentSchema)).toEqual([
      'probe.component',
      { selector: { projectId: 'project-1' }, params: { uuid: 'component-1' } }
    ]);
    expect(toRequest(documentSnapshot)).toEqual([
      'probe.documentSnapshot',
      {
        selector: { projectId: 'project-1', editorInstanceId: 'editor-1' },
        params: { mode: 'full', pageSize: 200, cursor: 'cursor-1' }
      }
    ]);
  });

  it.each(['0', '501', '1.5', 'many'])('拒绝非法文档分页参数 %s', (pageSize) => {
    expect(() => parseCommand([
      'document-snapshot',
      '--project-id', 'project-1',
      '--mode', 'summary',
      '--page-size', pageSize
    ])).toThrow('INVALID_PAGE_SIZE');
  });

  it('拒绝非法文档快照模式', () => {
    expect(() => parseCommand([
      'document-snapshot',
      '--project-id', 'project-1',
      '--mode', 'partial',
      '--page-size', '100'
    ])).toThrow('INVALID_SNAPSHOT_MODE');
  });

  it.each([
    ['asset-index'],
    ['component-schema', '--uuid', 'component-1'],
    ['document-snapshot', '--mode', 'summary', '--page-size', '100'],
    ['prefab-graph'],
    ['scan-project', '--report-root', 'reports', '--report', 'scan.json']
  ])('阶段一命令缺少 project-id 时拒绝 %j', (...command) => {
    expect(() => parseCommand(command)).toThrow('PROJECT_ID_REQUIRED');
  });

  it('解析 Prefab 图和项目扫描命令', () => {
    expect(parseCommand([
      'prefab-graph', '--project-id', 'project-1', '--editor-instance-id', 'editor-1'
    ])).toEqual({
      command: 'prefab-graph',
      projectId: 'project-1',
      editorInstanceId: 'editor-1'
    });
    expect(parseCommand([
      'scan-project',
      '--project-id', 'project-1',
      '--report-root', 'E:/reports',
      '--report', 'nested/run.json',
      '--resume', 'nested/run.checkpoint.json',
      '--page-size', '50',
      '--include-raw', 'true',
      '--concurrency', '4'
    ])).toEqual({
      command: 'scan-project',
      projectId: 'project-1',
      reportRoot: 'E:/reports',
      report: 'nested/run.json',
      resume: 'nested/run.checkpoint.json',
      pageSize: 50,
      includeRaw: true,
      concurrency: 4
    });
  });

  it.each([
    ['--page-size', '0', 'INVALID_SCAN_PAGE_SIZE'],
    ['--page-size', '501', 'INVALID_SCAN_PAGE_SIZE'],
    ['--include-raw', 'yes', 'INVALID_INCLUDE_RAW'],
    ['--concurrency', '0', 'INVALID_SCAN_CONCURRENCY'],
    ['--concurrency', '5', 'INVALID_SCAN_CONCURRENCY']
  ])('拒绝非法项目扫描参数 %s %s', (flag, value, errorCode) => {
    expect(() => parseCommand([
      'scan-project',
      '--project-id', 'project-1',
      '--report-root', 'E:/reports',
      '--report', 'run.json',
      flag, value
    ])).toThrow(errorCode);
  });

  it('拒绝静默忽略拼写错误的参数', () => {
    expect(() => parseCommand([
      'scan-project',
      '--project-id', 'project-1',
      '--report-root', 'E:/reports',
      '--report', 'run.json',
      '--page-szie', '50'
    ])).toThrow('UNKNOWN_ARGUMENT');
  });

  it('项目扫描要求显式报告根目录和报告文件', () => {
    expect(() => parseCommand([
      'scan-project', '--project-id', 'project-1', '--report', 'run.json'
    ])).toThrow('REPORT_ROOT_REQUIRED');
    expect(() => parseCommand([
      'scan-project', '--project-id', 'project-1', '--report-root', 'E:/reports'
    ])).toThrow('REPORT_REQUIRED');
  });

  it.each([
    '/tmp/run.json',
    'C:/run.json',
    String.raw`C:\run.json`,
    'C:run.json',
    String.raw`\\server\share\run.json`,
    String.raw`\run.json`,
    String.raw`\\?\C:\run.json`,
    '../run.json',
    'nested/../../run.json',
    String.raw`nested\..\..\run.json`,
    'run.txt',
    'run.json:stream.json'
  ])('拒绝越过报告根目录的报告路径 %s', (report) => {
    expect(() => parseCommand([
      'scan-project',
      '--project-id', 'project-1',
      '--report-root', 'E:/reports',
      '--report', report
    ])).toThrow('INVALID_REPORT_PATH');
  });

  it.each([
    '/tmp/run.json',
    String.raw`C:\run.json`,
    '../run.json',
    String.raw`nested\..\run.json`,
    'run.txt'
  ])('拒绝越过报告根目录的 resume 路径 %s', (resume) => {
    expect(() => parseCommand([
      'scan-project',
      '--project-id', 'project-1',
      '--report-root', 'E:/reports',
      '--report', 'run.json',
      '--resume', resume
    ])).toThrow('INVALID_RESUME_PATH');
  });
});

describe('local readonly commands', () => {
  it('执行阶段一原子只读命令并返回共享 Client 响应', async () => {
    const requests: Array<{ method: string; payload: unknown }> = [];
    const client: FakeClient = {
      async request(method, payload) {
        requests.push({ method, payload });
        return { method, payload };
      }
    };
    const commands = [
      parseCommand(['asset-index', '--project-id', 'project-1']),
      parseCommand([
        'component-schema',
        '--project-id', 'project-1',
        '--uuid', 'component-1'
      ]),
      parseCommand([
        'document-snapshot',
        '--project-id', 'project-1',
        '--editor-instance-id', 'editor-1',
        '--mode', 'full',
        '--page-size', '100',
        '--cursor', 'cursor-1'
      ])
    ];

    const results = [];
    for (const command of commands) {
      results.push(await cliModule.executeCommand(command, client));
    }

    expect(results).toEqual(requests);
    expect(requests).toEqual([
      {
        method: 'probe.assetIndex',
        payload: { selector: { projectId: 'project-1' }, params: {} }
      },
      {
        method: 'probe.component',
        payload: {
          selector: { projectId: 'project-1' },
          params: { uuid: 'component-1' }
        }
      },
      {
        method: 'probe.documentSnapshot',
        payload: {
          selector: { projectId: 'project-1', editorInstanceId: 'editor-1' },
          params: { mode: 'full', pageSize: 100, cursor: 'cursor-1' }
        }
      }
    ]);
  });

  it('空项目扫描在授权根目录写入报告和派生 checkpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cocos-ai-cli-'));
    try {
      const command = parseCommand([
        'scan-project',
        '--project-id', 'project-1',
        '--report-root', root,
        '--report', 'nested/run.json'
      ]);
      const runtime = cliModule as typeof cliModule & {
        prepareScanProject?: (command: CliCommand) => Promise<unknown>;
        executeCommand?: (command: CliCommand, client: FakeClient, prepared?: unknown) => Promise<unknown>;
      };
      expect(runtime.prepareScanProject).toBeTypeOf('function');
      expect(runtime.executeCommand).toBeTypeOf('function');
      if (!runtime.prepareScanProject || !runtime.executeCommand) return;

      const prepared = await runtime.prepareScanProject(command);
      const result = await runtime.executeCommand(command, createEmptyProjectClient(), prepared);
      const canonicalRoot = await realpath(root);
      expect(result).toMatchObject({
        status: 'completed',
        reportPath: join(canonicalRoot, 'nested', 'run.json'),
        checkpointPath: join(canonicalRoot, 'nested', 'run.checkpoint.json')
      });
      expect(JSON.parse(await readFile(join(root, 'nested', 'run.json'), 'utf8'))).toMatchObject({
        status: 'completed',
        documents: []
      });
      expect(JSON.parse(await readFile(
        join(root, 'nested', 'run.checkpoint.json'),
        'utf8'
      ))).toMatchObject({
        projectId: 'project-1',
        completedAssetUuids: []
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('Prefab 图命令复用项目扫描器且不写报告', async () => {
    const runtime = cliModule as typeof cliModule & {
      executeCommand?: (command: CliCommand, client: FakeClient) => Promise<unknown>;
    };
    expect(runtime.executeCommand).toBeTypeOf('function');
    if (!runtime.executeCommand) return;

    const result = await runtime.executeCommand(
      parseCommand(['prefab-graph', '--project-id', 'project-1']),
      createEmptyProjectClient()
    );
    expect(result).toMatchObject({ nodes: [], edges: [], blocked: false });
  });

  it('连接编辑器前拒绝畸形 resume checkpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cocos-ai-cli-'));
    try {
      await writeFile(join(root, 'bad.json'), '{}\n', 'utf8');
      const command = parseCommand([
        'scan-project',
        '--project-id', 'project-1',
        '--report-root', root,
        '--report', 'run.json',
        '--resume', 'bad.json'
      ]);
      const runtime = cliModule as typeof cliModule & {
        prepareScanProject?: (command: CliCommand) => Promise<unknown>;
      };
      expect(runtime.prepareScanProject).toBeTypeOf('function');
      if (!runtime.prepareScanProject) return;
      await expect(runtime.prepareScanProject(command)).rejects.toThrow('SCAN_CHECKPOINT_INVALID');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('连接编辑器前拒绝 checkpoint 项目身份冲突', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cocos-ai-cli-'));
    try {
      const checkpoint = createEmptyProjectCheckpoint();
      await writeFile(
        join(root, 'resume.json'),
        `${JSON.stringify(checkpoint)}\n`,
        'utf8'
      );
      const command = parseCommand([
        'scan-project',
        '--project-id', 'project-2',
        '--report-root', root,
        '--report', 'run.json',
        '--resume', 'resume.json'
      ]);
      const runtime = cliModule as typeof cliModule & {
        prepareScanProject?: (command: CliCommand) => Promise<unknown>;
      };
      expect(runtime.prepareScanProject).toBeTypeOf('function');
      if (!runtime.prepareScanProject) return;
      await expect(runtime.prepareScanProject(command)).rejects.toThrow(
        'SCAN_CHECKPOINT_STALE:projectId'
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resume 继承 checkpoint 的实例和扫描参数', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cocos-ai-cli-'));
    try {
      const checkpoint = createEmptyProjectCheckpoint();
      await writeFile(
        join(root, 'resume.json'),
        `${JSON.stringify(checkpoint)}\n`,
        'utf8'
      );
      const command = parseCommand([
        'scan-project',
        '--project-id', 'project-1',
        '--report-root', root,
        '--report', 'resumed.json',
        '--resume', 'resume.json'
      ]);
      const runtime = cliModule as typeof cliModule & {
        prepareScanProject?: (command: CliCommand) => Promise<unknown>;
        executeCommand?: (command: CliCommand, client: FakeClient, prepared?: unknown) => Promise<unknown>;
      };
      expect(runtime.prepareScanProject).toBeTypeOf('function');
      expect(runtime.executeCommand).toBeTypeOf('function');
      if (!runtime.prepareScanProject || !runtime.executeCommand) return;

      const prepared = await runtime.prepareScanProject(command);
      const result = await runtime.executeCommand(command, createEmptyProjectClient(), prepared);
      expect(result).toMatchObject({ scanId: 'scan-resume', status: 'completed' });
      expect(JSON.parse(await readFile(join(root, 'resume.json'), 'utf8'))).toMatchObject({
        scanId: 'scan-resume',
        editorInstanceId: 'editor-1',
        parameters: { pageSize: 50, includeRaw: true, concurrency: 4 }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('连接编辑器前拒绝显式扫描参数与 checkpoint 不一致', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cocos-ai-cli-'));
    try {
      await writeFile(
        join(root, 'resume.json'),
        `${JSON.stringify(createEmptyProjectCheckpoint())}\n`,
        'utf8'
      );
      const command = parseCommand([
        'scan-project',
        '--project-id', 'project-1',
        '--report-root', root,
        '--report', 'run.json',
        '--resume', 'resume.json',
        '--page-size', '51'
      ]);
      const runtime = cliModule as typeof cliModule & {
        prepareScanProject?: (command: CliCommand) => Promise<unknown>;
      };
      expect(runtime.prepareScanProject).toBeTypeOf('function');
      if (!runtime.prepareScanProject) return;
      await expect(runtime.prepareScanProject(command)).rejects.toThrow(
        'SCAN_CHECKPOINT_STALE:parameters'
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('拒绝通过报告根目录内 Junction 写到外部目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cocos-ai-cli-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'cocos-ai-cli-outside-'));
    try {
      await symlink(outside, join(root, 'link'), 'junction');
      const command = parseCommand([
        'scan-project',
        '--project-id', 'project-1',
        '--report-root', root,
        '--report', 'link/run.json'
      ]);
      const runtime = cliModule as typeof cliModule & {
        prepareScanProject?: (command: CliCommand) => Promise<unknown>;
      };
      expect(runtime.prepareScanProject).toBeTypeOf('function');
      if (!runtime.prepareScanProject) return;
      await expect(runtime.prepareScanProject(command)).rejects.toThrow('INVALID_REPORT_PATH');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('连接编辑器前拒绝把既有目录当成 JSON 目标文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cocos-ai-cli-'));
    try {
      await mkdir(join(root, 'occupied.json'));
      const command = parseCommand([
        'scan-project',
        '--project-id', 'project-1',
        '--report-root', root,
        '--report', 'occupied.json'
      ]);
      const runtime = cliModule as typeof cliModule & {
        prepareScanProject?: (command: CliCommand) => Promise<unknown>;
      };
      expect(runtime.prepareScanProject).toBeTypeOf('function');
      if (!runtime.prepareScanProject) return;
      await expect(runtime.prepareScanProject(command)).rejects.toThrow('INVALID_REPORT_PATH');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('Windows 下拒绝大小写别名导致报告和 checkpoint 同文件', async () => {
    if (process.platform !== 'win32') return;
    const root = await mkdtemp(join(tmpdir(), 'cocos-ai-cli-'));
    try {
      await writeFile(
        join(root, 'RUN.JSON'),
        `${JSON.stringify(createEmptyProjectCheckpoint())}\n`,
        'utf8'
      );
      const command = parseCommand([
        'scan-project',
        '--project-id', 'project-1',
        '--report-root', root,
        '--report', 'run.json',
        '--resume', 'RUN.JSON'
      ]);
      const runtime = cliModule as typeof cliModule & {
        prepareScanProject?: (command: CliCommand) => Promise<unknown>;
      };
      expect(runtime.prepareScanProject).toBeTypeOf('function');
      if (!runtime.prepareScanProject) return;
      await expect(runtime.prepareScanProject(command)).rejects.toThrow(
        'REPORT_CHECKPOINT_PATH_CONFLICT'
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runCli 在连接前返回稳定 checkpoint 错误码', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cocos-ai-cli-'));
    try {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'bad.json'), '{}\n', 'utf8');
      const stdout = createCaptureStream();
      const stderr = createCaptureStream();
      const exitCode = await cliModule.runCli([
        'scan-project',
        '--project-id', 'project-1',
        '--report-root', root,
        '--report', 'run.json',
        '--resume', 'bad.json'
      ], {
        serverUrl: 'ws://127.0.0.1:1',
        stdout: stdout.stream,
        stderr: stderr.stream
      });

      expect(exitCode).toBe(1);
      expect(JSON.parse(stderr.read())).toMatchObject({
        code: 'SCAN_CHECKPOINT_INVALID',
        message: '扫描 checkpoint 无效'
      });
      expect(stdout.read()).toBe('');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runCli 把 report-root 文件错误归一为稳定业务码', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'cocos-ai-cli-'));
    try {
      const reportRoot = join(parent, 'not-a-directory');
      await writeFile(reportRoot, 'occupied\n', 'utf8');
      const stderr = createCaptureStream();
      const exitCode = await cliModule.runCli([
        'scan-project',
        '--project-id', 'project-1',
        '--report-root', reportRoot,
        '--report', 'run.json'
      ], {
        serverUrl: 'ws://127.0.0.1:1',
        stdout: createCaptureStream().stream,
        stderr: stderr.stream
      });

      expect(exitCode).toBe(1);
      expect(JSON.parse(stderr.read())).toMatchObject({
        code: 'REPORT_ROOT_INVALID',
        message: 'report-root 必须是可写目录'
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe('ProbeClient', () => {
  it('完成 client.hello 后发送控制请求', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;

    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as {
          method?: string;
          requestId?: string;
        };
        if (message.method === 'client.hello') {
          socket.send(JSON.stringify({
            type: 'response',
            correlationId: 'client.hello',
            ok: true,
            payload: {}
          }));
          return;
        }

        socket.send(JSON.stringify({
          type: 'response',
          correlationId: message.requestId,
          ok: true,
          payload: [{ editorInstanceId: 'editor-1' }]
        }));
      });
    });

    const client = new ProbeClient(`ws://127.0.0.1:${port}`);
    await client.connect();
    const editors = await client.request('server.editors', {});

    expect(editors).toEqual([{ editorInstanceId: 'editor-1' }]);
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

interface FakeClient {
  request(method: string, payload: unknown): Promise<unknown>;
}

function createEmptyProjectClient(): FakeClient {
  return {
    async request(method) {
      if (method === 'server.editors') {
        return [{
          editorInstanceId: 'editor-1',
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
        }];
      }
      if (method === 'probe.assetIndex') {
        return { assets: [], scripts: [], documents: [], unresolved: [] };
      }
      throw new Error(`UNEXPECTED_METHOD:${method}`);
    }
  };
}

function createEmptyProjectCheckpoint() {
  return createScanCheckpoint({
    scanId: 'scan-resume',
    context: {
      projectId: 'project-1',
      editorInstanceId: 'editor-1',
      projectPath: 'E:/project',
      creatorVersion: '3.8.8',
      bridgeVersion: '0.1.0',
      protocolVersion: PROTOCOL_VERSION,
      parameters: { pageSize: 50, includeRaw: true, concurrency: 4 },
      assetManifestHash: createAssetManifestHash([], []),
      assetUuids: []
    },
    updatedAt: '2026-07-14T00:00:00.000Z'
  });
}

function createCaptureStream(): { stream: NodeJS.WritableStream; read(): string } {
  let output = '';
  return {
    stream: {
      write(chunk: string | Uint8Array) {
        output += chunk.toString();
        return true;
      }
    } as NodeJS.WritableStream,
    read: () => output
  };
}
