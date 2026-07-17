import {
  WriteTransactionRequestSchema,
  type WriteTransactionRequest
} from '@cocos-ai/protocol';

export type CliCommand =
  | { command: 'editors' }
  | { command: 'state'; projectId: string; editorInstanceId?: string }
  | { command: 'assets'; projectId: string; editorInstanceId?: string; pattern: string; uuid?: string }
  | { command: 'open-asset'; projectId: string; editorInstanceId?: string; uuid: string }
  | { command: 'hierarchy'; projectId: string; editorInstanceId?: string; depth: number }
  | { command: 'node'; projectId: string; editorInstanceId?: string; uuid: string }
  | { command: 'component'; projectId: string; editorInstanceId?: string; uuid: string }
  | { command: 'prefab'; projectId: string; editorInstanceId?: string; nodeUuid: string }
  | { command: 'asset-index'; projectId: string; editorInstanceId?: string }
  | { command: 'component-schema'; projectId: string; editorInstanceId?: string; uuid: string }
  | { command: 'document-snapshot'; projectId: string; editorInstanceId?: string; mode: 'summary' | 'full'; pageSize: number; cursor?: string }
  | { command: 'prefab-graph'; projectId: string; editorInstanceId?: string }
  | {
      command: 'scan-project';
      projectId: string;
      editorInstanceId?: string;
      reportRoot: string;
      report: string;
      resume?: string;
      pageSize?: number;
      includeRaw?: boolean;
      concurrency?: number;
    }
  | { command: 'save-report'; projectId: string; editorInstanceId?: string; sample: string }
  | { command: 'probe-undo-save-prepare'; projectId: string; editorInstanceId?: string; projectPath: string; documentUuid: string; probeName: string }
  | { command: 'probe-undo-save-confirm'; projectId: string; editorInstanceId?: string; transactionId: string; expectedRevision: string }
  | { command: 'probe-undo-save-status'; projectId: string; editorInstanceId?: string; transactionId: string }
  | { command: 'write-prepare'; projectId: string; editorInstanceId?: string; request: WriteTransactionRequest }
  | { command: 'write-confirm'; projectId: string; editorInstanceId?: string; transactionId: string }
  | { command: 'transaction-status'; projectId: string; editorInstanceId?: string; transactionId: string }
  | { command: 'transaction-list'; projectId: string; editorInstanceId?: string }
  | { command: 'transaction-rollback'; projectId: string; editorInstanceId?: string; transactionId: string };

interface ParsedArguments {
  command: string;
  flags: Map<string, string>;
}

const PROJECT_SELECTOR_FLAGS = ['project-id', 'editor-instance-id'] as const;

// 每个命令只允许消费显式登记的参数，避免 AI 拼写错误后继续执行错误动作。
const COMMAND_FLAGS: Record<string, readonly string[]> = {
  editors: [],
  state: PROJECT_SELECTOR_FLAGS,
  assets: [...PROJECT_SELECTOR_FLAGS, 'pattern', 'uuid'],
  'open-asset': [...PROJECT_SELECTOR_FLAGS, 'uuid'],
  hierarchy: [...PROJECT_SELECTOR_FLAGS, 'depth'],
  node: [...PROJECT_SELECTOR_FLAGS, 'uuid'],
  component: [...PROJECT_SELECTOR_FLAGS, 'uuid'],
  prefab: [...PROJECT_SELECTOR_FLAGS, 'node-uuid'],
  'asset-index': PROJECT_SELECTOR_FLAGS,
  'component-schema': [...PROJECT_SELECTOR_FLAGS, 'uuid'],
  'document-snapshot': [...PROJECT_SELECTOR_FLAGS, 'mode', 'page-size', 'cursor'],
  'prefab-graph': PROJECT_SELECTOR_FLAGS,
  'scan-project': [
    ...PROJECT_SELECTOR_FLAGS,
    'report-root',
    'report',
    'resume',
    'page-size',
    'include-raw',
    'concurrency'
  ],
  'save-report': [...PROJECT_SELECTOR_FLAGS, 'sample'],
  'probe-undo-save-prepare': [
    ...PROJECT_SELECTOR_FLAGS,
    'project-path',
    'document-uuid',
    'probe-name'
  ],
  'probe-undo-save-confirm': [
    ...PROJECT_SELECTOR_FLAGS,
    'transaction-id',
    'expected-revision'
  ],
  'probe-undo-save-status': [...PROJECT_SELECTOR_FLAGS, 'transaction-id'],
  'write-prepare': [...PROJECT_SELECTOR_FLAGS, 'request'],
  'write-confirm': [...PROJECT_SELECTOR_FLAGS, 'transaction-id'],
  'transaction-status': [...PROJECT_SELECTOR_FLAGS, 'transaction-id'],
  'transaction-list': PROJECT_SELECTOR_FLAGS,
  'transaction-rollback': [...PROJECT_SELECTOR_FLAGS, 'transaction-id']
};

/**
 * 将 CLI 参数解析为稳定的探针命令对象。
 *
 * @param argv 不包含 node 和入口脚本路径的参数数组。
 * @returns 已校验的 CLI 命令。
 */
export function parseCommand(argv: string[]): CliCommand {
  const { command, flags } = parseArguments(argv);
  assertKnownFlags(command, flags);
  if (command === 'editors') {
    return { command };
  }

  const projectId = requireFlag(flags, 'project-id', 'PROJECT_ID_REQUIRED');
  const editorInstanceId = flags.get('editor-instance-id');
  const selector = editorInstanceId ? { projectId, editorInstanceId } : { projectId };

  switch (command) {
    case 'state':
      return { command, ...selector };
    case 'asset-index':
    case 'prefab-graph':
      return { command, ...selector };
    case 'assets':
      return {
        command,
        ...selector,
        pattern: requireFlag(flags, 'pattern', 'PATTERN_REQUIRED'),
        ...(flags.has('uuid') ? { uuid: flags.get('uuid') } : {})
      };
    case 'hierarchy': {
      const depth = Number(flags.get('depth') ?? '4');
      if (!Number.isInteger(depth) || depth < 1 || depth > 20) {
        throw new Error('INVALID_DEPTH');
      }
      return { command, ...selector, depth };
    }
    case 'node':
    case 'component':
    case 'component-schema':
    case 'open-asset':
      return {
        command,
        ...selector,
        uuid: requireFlag(flags, 'uuid', 'UUID_REQUIRED')
      };
    case 'document-snapshot': {
      const mode = requireFlag(flags, 'mode', 'SNAPSHOT_MODE_REQUIRED');
      if (mode !== 'summary' && mode !== 'full') {
        throw new Error('INVALID_SNAPSHOT_MODE');
      }
      const pageSize = Number(requireFlag(flags, 'page-size', 'PAGE_SIZE_REQUIRED'));
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) {
        throw new Error('INVALID_PAGE_SIZE');
      }
      return {
        command,
        ...selector,
        mode,
        pageSize,
        ...(flags.has('cursor') ? { cursor: flags.get('cursor') } : {})
      };
    }
    case 'scan-project': {
      const report = requireRelativeJsonPath(
        requireFlag(flags, 'report', 'REPORT_REQUIRED'),
        'INVALID_REPORT_PATH'
      );
      const resume = flags.has('resume')
        ? requireRelativeJsonPath(flags.get('resume') ?? '', 'INVALID_RESUME_PATH')
        : undefined;
      const pageSize = readOptionalInteger(flags, 'page-size', 1, 500, 'INVALID_SCAN_PAGE_SIZE');
      const concurrency = readOptionalInteger(
        flags,
        'concurrency',
        1,
        4,
        'INVALID_SCAN_CONCURRENCY'
      );
      const includeRaw = readOptionalBoolean(flags, 'include-raw', 'INVALID_INCLUDE_RAW');
      return {
        command,
        ...selector,
        reportRoot: requireFlag(flags, 'report-root', 'REPORT_ROOT_REQUIRED'),
        report,
        ...(resume ? { resume } : {}),
        ...(pageSize !== undefined ? { pageSize } : {}),
        ...(includeRaw !== undefined ? { includeRaw } : {}),
        ...(concurrency !== undefined ? { concurrency } : {})
      };
    }
    case 'prefab':
      return {
        command,
        ...selector,
        nodeUuid: requireFlag(flags, 'node-uuid', 'NODE_UUID_REQUIRED')
      };
    case 'save-report':
      return {
        command,
        ...selector,
        sample: requireFlag(flags, 'sample', 'SAMPLE_REQUIRED')
      };
    case 'probe-undo-save-prepare':
      return {
        command,
        ...selector,
        projectPath: requireFlag(flags, 'project-path', 'PROJECT_PATH_REQUIRED'),
        documentUuid: requireFlag(flags, 'document-uuid', 'DOCUMENT_UUID_REQUIRED'),
        probeName: requireFlag(flags, 'probe-name', 'PROBE_NAME_REQUIRED')
      };
    case 'probe-undo-save-confirm':
      return {
        command,
        ...selector,
        transactionId: requireFlag(flags, 'transaction-id', 'TRANSACTION_ID_REQUIRED'),
        expectedRevision: requireFlag(flags, 'expected-revision', 'EXPECTED_REVISION_REQUIRED')
      };
    case 'probe-undo-save-status':
      return {
        command,
        ...selector,
        transactionId: requireFlag(flags, 'transaction-id', 'TRANSACTION_ID_REQUIRED')
      };
    case 'write-prepare':
      return {
        command,
        ...selector,
        request: readWriteTransactionRequest(requireFlag(flags, 'request', 'WRITE_REQUEST_REQUIRED'))
      };
    case 'write-confirm':
    case 'transaction-status':
    case 'transaction-rollback':
      return {
        command,
        ...selector,
        transactionId: requireFlag(flags, 'transaction-id', 'TRANSACTION_ID_REQUIRED')
      };
    case 'transaction-list':
      return { command, ...selector };
    default:
      throw new Error('UNKNOWN_COMMAND');
  }
}

/**
 * 解析并按协议 Schema 校验写事务请求 JSON。
 *
 * @param value CLI --request 传入的 JSON 字符串。
 * @returns 通过协议校验的写事务请求。
 */
function readWriteTransactionRequest(value: string): WriteTransactionRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('INVALID_WRITE_REQUEST_JSON');
  }
  try {
    return WriteTransactionRequestSchema.parse(parsed);
  } catch {
    throw new Error('INVALID_WRITE_REQUEST');
  }
}

function parseArguments(argv: string[]): ParsedArguments {
  const [command, ...rest] = argv;
  if (!command) {
    throw new Error('COMMAND_REQUIRED');
  }

  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error('INVALID_ARGUMENTS');
    }
    flags.set(flag.slice(2), value);
  }

  return { command, flags };
}

/**
 * 按命令白名单拒绝未消费参数，避免拼写错误被静默忽略。
 *
 * @param command 当前 CLI 命令名。
 * @param flags 已解析的参数名和值。
 */
function assertKnownFlags(command: string, flags: Map<string, string>): void {
  const allowedFlags = COMMAND_FLAGS[command];
  if (!allowedFlags) throw new Error('UNKNOWN_COMMAND');
  const allowed = new Set(allowedFlags);
  for (const flag of flags.keys()) {
    if (!allowed.has(flag)) throw new Error(`UNKNOWN_ARGUMENT:${flag}`);
  }
}

function requireFlag(flags: Map<string, string>, name: string, errorCode: string): string {
  const value = flags.get(name);
  if (!value) {
    throw new Error(errorCode);
  }
  return value;
}

function requireRelativeJsonPath(value: string, errorCode: string): string {
  const segments = value.split(/[\\/]+/);
  const fileName = segments[segments.length - 1]?.toLowerCase();
  if (
    !value
    || value.includes('\0')
    || value.includes(':')
    || value.startsWith('/')
    || value.startsWith('\\')
    || segments.includes('..')
    || !fileName?.endsWith('.json')
    || fileName === '.json'
  ) {
    throw new Error(errorCode);
  }
  return value;
}

function readOptionalInteger(
  flags: Map<string, string>,
  name: string,
  minimum: number,
  maximum: number,
  errorCode: string
): number | undefined {
  if (!flags.has(name)) return undefined;
  const value = Number(flags.get(name));
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(errorCode);
  }
  return value;
}

function readOptionalBoolean(
  flags: Map<string, string>,
  name: string,
  errorCode: string
): boolean | undefined {
  if (!flags.has(name)) return undefined;
  const value = flags.get(name);
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(errorCode);
}
