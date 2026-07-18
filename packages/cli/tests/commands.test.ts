import type { AddressInfo } from 'node:net';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
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
      const report = JSON.parse(await readFile(join(root, 'nested', 'run.json'), 'utf8'));
      expect(report).toMatchObject({
        formatVersion: 2,
        status: 'completed',
        summary: {
          documents: 0,
          completedDocuments: 0
        },
        artifacts: {
          documentSnapshots: {
            count: 0,
            gzipCount: 0,
            jsonCount: 0
          }
        }
      });
      expect(report).not.toHaveProperty('documents');
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

  it('Prefab 图命令复用项目扫描器且只返回引用图', async () => {
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

  it('Prefab 图命令使用临时文件化扫描产物并在成功后清理', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'cocos-ai-cli-prefab-graph-'));
    try {
      const runtime = cliModule as typeof cliModule & {
        executePrefabGraph?: (
          command: CliCommand,
          client: FakeClient,
          temporaryDirectoryRoot?: string
        ) => Promise<unknown>;
      };
      expect(runtime.executePrefabGraph).toBeTypeOf('function');
      if (!runtime.executePrefabGraph) throw new Error('EXECUTE_PREFAB_GRAPH_NOT_EXPORTED');

      let inspectedArtifacts = false;
      const client = createPrefabGraphProjectClient(async (assetUuid) => {
        if (assetUuid !== 'prefab-b') return;
        const roots = await readdir(parent, { withFileTypes: true });
        expect(roots).toHaveLength(1);
        expect(roots[0]?.isDirectory()).toBe(true);
        const scanRoot = join(parent, roots[0]!.name);
        const artifacts = await readdir(scanRoot, { withFileTypes: true });
        const checkpoint = artifacts.find((entry) => entry.name.endsWith('.checkpoint.json'));
        const documents = artifacts.find((entry) => entry.name.endsWith('.checkpoint.json.documents'));
        expect(checkpoint?.isFile()).toBe(true);
        expect(documents?.isDirectory()).toBe(true);
        expect(JSON.parse(await readFile(join(scanRoot, checkpoint!.name), 'utf8'))).toMatchObject({
          completedAssetUuids: ['scene-a']
        });
        expect(await readdir(join(scanRoot, documents!.name))).toHaveLength(1);
        inspectedArtifacts = true;
      });

      const result = await runtime.executePrefabGraph(
        parseCommand(['prefab-graph', '--project-id', 'project-1']),
        client,
        parent
      );

      expect(result).toMatchObject({ blocked: false });
      expect(inspectedArtifacts).toBe(true);
      expect(await readdir(parent)).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('Prefab 图命令失败后仍清理临时扫描目录', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'cocos-ai-cli-prefab-graph-'));
    try {
      const runtime = cliModule as typeof cliModule & {
        executePrefabGraph?: (
          command: CliCommand,
          client: FakeClient,
          temporaryDirectoryRoot?: string
        ) => Promise<unknown>;
      };
      expect(runtime.executePrefabGraph).toBeTypeOf('function');
      if (!runtime.executePrefabGraph) throw new Error('EXECUTE_PREFAB_GRAPH_NOT_EXPORTED');

      let observedTemporaryDirectory = false;
      const client: FakeClient = {
        async request(method) {
          if (method === 'server.editors') {
            observedTemporaryDirectory = (await readdir(parent)).length === 1;
            throw new Error('SERVER_CONNECTION_CLOSED');
          }
          throw new Error(`UNEXPECTED_METHOD:${method}`);
        }
      };

      await expect(runtime.executePrefabGraph(
        parseCommand(['prefab-graph', '--project-id', 'project-1']),
        client,
        parent
      )).rejects.toThrow('SERVER_CONNECTION_CLOSED');
      expect(observedTemporaryDirectory).toBe(true);
      expect(await readdir(parent)).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
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

  it('runCli 使用环境变量配置请求超时', async () => {
    const originalTimeout = process.env.COCOS_AI_PROBE_TIMEOUT_MS;
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    let delayedResponse: ReturnType<typeof setTimeout> | null = null;
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
            payload: { role: 'client' }
          }));
          return;
        }
        delayedResponse = setTimeout(() => {
          if (socket.readyState !== 1) return;
          socket.send(JSON.stringify({
            type: 'response',
            correlationId: message.requestId,
            ok: true,
            payload: []
          }));
        }, 100);
      });
    });

    try {
      process.env.COCOS_AI_PROBE_TIMEOUT_MS = '20';
      const stdout = createCaptureStream();
      const stderr = createCaptureStream();
      const exitCode = await cliModule.runCli(['editors'], {
        serverUrl: `ws://127.0.0.1:${port}`,
        stdout: stdout.stream,
        stderr: stderr.stream
      });

      expect(exitCode).toBe(1);
      expect(JSON.parse(stderr.read())).toMatchObject({
        code: 'SERVER_REQUEST_TIMEOUT',
        message: 'Probe Server 请求超时，结果未知'
      });
      expect(stdout.read()).toBe('');
    } finally {
      if (originalTimeout === undefined) {
        delete process.env.COCOS_AI_PROBE_TIMEOUT_MS;
      } else {
        process.env.COCOS_AI_PROBE_TIMEOUT_MS = originalTimeout;
      }
      if (delayedResponse) clearTimeout(delayedResponse);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(['', '0', '-1', '1.5', 'NaN', 'Infinity'])(
    '非法请求超时环境变量 %j 回退默认值',
    (value) => {
      const runtime = cliModule as typeof cliModule & {
        readRequestTimeoutMs?: (rawValue: string | undefined) => number;
      };
      expect(runtime.readRequestTimeoutMs).toBeTypeOf('function');
      if (!runtime.readRequestTimeoutMs) throw new Error('READ_REQUEST_TIMEOUT_NOT_EXPORTED');
      expect(runtime.readRequestTimeoutMs(value)).toBe(10_000);
    }
  );
});

describe('write commands', () => {
  it('解析 write-prepare 并按协议校验请求', () => {
    const command = parseCommand([
      'write-prepare',
      '--project-id', 'project-1',
      '--request', writeRequestJson()
    ]);

    expect(command.command).toBe('write-prepare');
    expect(toRequest(command)).toEqual(['probe.writePrepare', {
      selector: { projectId: 'project-1' },
      params: {
        transactionId: 'tx-1',
        idempotencyKey: 'key-1',
        scope: 'current-document',
        revision: { document: 'sha256:doc', hierarchy: null, assetDatabase: null, scriptCompilation: null },
        operations: [{ type: 'node.rename', nodeUuid: 'n1', name: 'NewName' }],
        save: true,
        undoGroup: 'rename-node'
      }
    }]);
  });

  it('拒绝缺少幂等键和非法 JSON 的写事务请求', () => {
    expect(() => parseCommand([
      'write-prepare',
      '--project-id', 'project-1',
      '--request', JSON.stringify({ transactionId: 'tx-1', scope: 'current-document' })
    ])).toThrow('INVALID_WRITE_REQUEST');
    expect(() => parseCommand([
      'write-prepare',
      '--project-id', 'project-1',
      '--request', '{not-json'
    ])).toThrow('INVALID_WRITE_REQUEST_JSON');
    expect(() => parseCommand([
      'write-prepare',
      '--project-id', 'project-1'
    ])).toThrow('WRITE_REQUEST_REQUIRED');
  });

  it('拒绝阶段三作用域的写事务请求', () => {
    expect(() => parseCommand([
      'write-prepare',
      '--project-id', 'project-1',
      '--request', JSON.stringify({
        transactionId: 'tx-1',
        idempotencyKey: 'key-1',
        scope: 'source-prefab',
        revision: { document: null, hierarchy: null, assetDatabase: null, scriptCompilation: null },
        operations: [{ type: 'node.rename', nodeUuid: 'n1', name: 'NewName' }],
        save: true,
        undoGroup: 'rename-node'
      })
    ])).toThrow('INVALID_WRITE_REQUEST');
  });

  it('解析事务状态、列表、确认和回滚命令', () => {
    expect(toRequest(parseCommand([
      'write-confirm', '--project-id', 'project-1', '--transaction-id', 'tx-1'
    ]))).toEqual(['probe.writeConfirm', {
      selector: { projectId: 'project-1' },
      params: { transactionId: 'tx-1' }
    }]);
    expect(toRequest(parseCommand([
      'transaction-status', '--project-id', 'project-1', '--transaction-id', 'tx-1'
    ]))).toEqual(['probe.transactionStatus', {
      selector: { projectId: 'project-1' },
      params: { transactionId: 'tx-1' }
    }]);
    expect(toRequest(parseCommand([
      'transaction-list', '--project-id', 'project-1'
    ]))).toEqual(['probe.transactionList', {
      selector: { projectId: 'project-1' },
      params: {}
    }]);
    expect(toRequest(parseCommand([
      'transaction-rollback', '--project-id', 'project-1', '--transaction-id', 'tx-1'
    ]))).toEqual(['probe.transactionRollback', {
      selector: { projectId: 'project-1' },
      params: { transactionId: 'tx-1' }
    }]);
  });

  it('写命令响应按协议校验，缺重读验证的 committed 被拒绝', async () => {
    const client: FakeClient = {
      async request() {
        return {
          transactionId: 'tx-1',
          status: 'committed',
          executedOps: 1,
          verification: null,
          failure: null,
          rollbackEvidence: null
        };
      }
    };

    await expect(cliModule.executeCommand(
      parseCommand(['write-confirm', '--project-id', 'project-1', '--transaction-id', 'tx-1']),
      client
    )).rejects.toThrow('INVALID_WRITE_RESULT');
  });

  it('写命令把审计条目落盘到授权报告根', async () => {
    const journalRoot = await mkdtemp(join(tmpdir(), 'cocos-ai-cli-journal-'));
    try {
      const client: FakeClient = {
        async request() {
          return writeResultPayload();
        }
      };
      const runtime = cliModule as typeof cliModule & {
        executeCommand: (
          command: CliCommand,
          client: FakeClient,
          prepared?: unknown,
          options?: { journalRoot?: string }
        ) => Promise<unknown>;
      };

      const result = await runtime.executeCommand(
        parseCommand(['write-prepare', '--project-id', 'project-1', '--request', writeRequestJson()]),
        client,
        undefined,
        { journalRoot }
      );

      expect(result).toMatchObject({ transactionId: 'tx-1', status: 'committed' });
      const journal = JSON.parse(
        (await readFile(join(journalRoot, 'write-journal', 'tx-1.jsonl'), 'utf8')).trim().split('\n')[0]
      );
      expect(journal).toMatchObject({
        transactionId: 'tx-1',
        idempotencyKey: 'key-1',
        event: 'write-prepare',
        source: 'cli'
      });
      expect(journal.request).toMatchObject({ transactionId: 'tx-1', undoGroup: 'rename-node' });
    } finally {
      await rm(journalRoot, { recursive: true, force: true });
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

/**
 * 创建两个文档的 Prefab 图扫描 Client，并允许在打开第二个文档前检查首个快照产物。
 *
 * @param onOpenAsset 每次打开文档资产时执行的测试观察逻辑。
 * @returns 可完成完整项目扫描的只读 Client。
 */
function createPrefabGraphProjectClient(
  onOpenAsset: (assetUuid: string) => Promise<void>
): FakeClient {
  let activeAssetUuid = '';
  return {
    async request(method, payload) {
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
      if (method === 'probe.assetIndex') return createPrefabGraphAssetIndex();
      if (method === 'probe.openAsset') {
        activeAssetUuid = readFakeAssetUuid(payload);
        await onOpenAsset(activeAssetUuid);
        return { opened: true, uuid: activeAssetUuid };
      }
      if (method === 'probe.editorState') {
        return { ready: { scene: true, assetDatabase: true }, unresolved: [] };
      }
      if (method === 'probe.documentSnapshot') {
        return createPrefabGraphDocumentSnapshot(activeAssetUuid);
      }
      throw new Error(`UNEXPECTED_METHOD:${method}`);
    }
  };
}

/**
 * 创建包含一个 Scene 和一个 Prefab 的最小资产索引。
 *
 * @returns 可由项目扫描器完整消费的资产索引。
 */
function createPrefabGraphAssetIndex() {
  const documents = [
    createPrefabGraphDocumentRecord('scene-a', 'scene'),
    createPrefabGraphDocumentRecord('prefab-b', 'prefab')
  ];
  return {
    assets: documents.map((document) => ({
      assetUuid: document.assetUuid,
      url: document.path,
      filePath: document.filePath,
      type: document.documentType === 'scene' ? 'cc.SceneAsset' : 'cc.Prefab',
      importer: null,
      name: document.assetUuid,
      displayName: document.assetUuid,
      source: null,
      path: document.path,
      isSubAsset: false,
      isBundle: false,
      imported: true,
      invalid: false,
      isDirectory: false,
      visible: true,
      readonly: false,
      available: true,
      raw: {}
    })),
    scripts: [],
    documents,
    unresolved: []
  };
}

/**
 * 创建文档资产记录。
 *
 * @param assetUuid 文档资产 UUID。
 * @param documentType 文档类型。
 * @returns Scene 或 Prefab 文档记录。
 */
function createPrefabGraphDocumentRecord(
  assetUuid: string,
  documentType: 'scene' | 'prefab'
) {
  const extension = documentType === 'scene' ? 'scene' : 'prefab';
  return {
    assetUuid,
    path: `db://assets/${assetUuid}.${extension}`,
    filePath: `E:/project/assets/${assetUuid}.${extension}`,
    documentType,
    available: true,
    raw: {}
  };
}

/**
 * 创建单页完整文档快照。
 *
 * @param assetUuid 当前已打开文档的资产 UUID。
 * @returns 可写入文件化快照仓库的完整文档快照。
 */
function createPrefabGraphDocumentSnapshot(assetUuid: string) {
  const documentType = assetUuid === 'scene-a' ? 'scene' : 'prefab';
  const document = createPrefabGraphDocumentRecord(assetUuid, documentType);
  const nodeUuid = `${assetUuid}-node`;
  return {
    document,
    revision: `${assetUuid}-revision`,
    mode: 'full',
    page: { offset: 0, pageSize: 100, totalNodes: 1, nextCursor: null },
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
      siblingIndex: 0,
      active: true,
      layer: 0,
      localTransform: null
    }],
    componentSchemas: [],
    prefabInstances: [],
    coverage: {
      nodes: { total: 1, decoded: 1 },
      components: { total: 0, decoded: 0 },
      properties: { total: 0, decoded: 0 },
      references: { total: 0, resolved: 0 },
      prefabInstances: { total: 0, resolved: 0 },
      overrides: { total: 0, decoded: 0 }
    },
    unresolved: [],
    diagnostics: []
  };
}

/**
 * 从假的 openAsset 请求中读取资产 UUID。
 *
 * @param payload Server 请求载荷。
 * @returns 待打开文档的资产 UUID。
 */
function readFakeAssetUuid(payload: unknown): string {
  return (payload as { params: { uuid: string } }).params.uuid;
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

function writeRequestJson(): string {
  return JSON.stringify({
    transactionId: 'tx-1',
    idempotencyKey: 'key-1',
    scope: 'current-document',
    revision: { document: 'sha256:doc', hierarchy: null, assetDatabase: null, scriptCompilation: null },
    operations: [{ type: 'node.rename', nodeUuid: 'n1', name: 'NewName' }],
    save: true,
    undoGroup: 'rename-node'
  });
}

function writeResultPayload() {
  return {
    transactionId: 'tx-1',
    status: 'committed',
    executedOps: 1,
    verification: {
      passed: true,
      verifiedAt: '2026-07-17T00:00:01.000Z',
      items: [{ operationIndex: 0, description: '节点重命名', expected: 'NewName', actual: 'NewName', passed: true }]
    },
    failure: null,
    rollbackEvidence: null
  };
}
