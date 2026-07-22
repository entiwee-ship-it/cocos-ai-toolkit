import {
  DesignTargetDocumentSchema,
  RevisionPreconditionSchema,
  WriteTransactionRequestSchema,
  type DesignTargetDocument,
  type RevisionPrecondition,
  type WriteTransactionRequest
} from '@cocos-ai/protocol';

export type CliCommand =
  | { command: 'editors' }
  | { command: 'state'; projectId: string; editorInstanceId?: string }
  | { command: 'write-revision'; projectId: string; editorInstanceId?: string }
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
  | { command: 'design-inspect'; projectId: string; editorInstanceId?: string; rootUuid?: string }
  | { command: 'design-plan'; projectId: string; editorInstanceId?: string; target: DesignTargetDocument }
  | { command: 'design-preview'; projectId: string; editorInstanceId?: string; target: DesignTargetDocument }
  | { command: 'design-verify'; projectId: string; editorInstanceId?: string; target: DesignTargetDocument }
  | {
      command: 'design-export';
      projectId: string;
      editorInstanceId?: string;
      rootUuid?: string;
      scope: DesignTargetDocument['document']['scope'];
      assetUuid?: string;
    }
  | {
      command: 'design-apply';
      projectId: string;
      editorInstanceId?: string;
      target: DesignTargetDocument;
      executionId?: string;
      revision?: RevisionPrecondition;
    }
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
  | { command: 'write-prepare'; projectId: string; editorInstanceId?: string; request: WriteTransactionRequest }
  | { command: 'write-confirm'; projectId: string; editorInstanceId?: string; transactionId: string }
  | { command: 'transaction-status'; projectId: string; editorInstanceId?: string; transactionId: string }
  | { command: 'transaction-list'; projectId: string; editorInstanceId?: string }
  | { command: 'transaction-rollback'; projectId: string; editorInstanceId?: string; transactionId: string }
  | { command: 'preview-launch'; projectId: string; editorInstanceId?: string; resolution?: { width: number; height: number }; channel?: string }
  | { command: 'preview-stop'; sessionId: string }
  | { command: 'preview-sessions'; projectId?: string }
  | { command: 'runtime-console'; sessionId: string; sinceSeq?: number; level?: string }
  | { command: 'runtime-hierarchy'; sessionId: string; maxDepth?: number; maxNodes?: number }
  | { command: 'runtime-component'; sessionId: string; path: string; componentType: string }
  | { command: 'runtime-invoke'; sessionId: string; path: string; componentType: string; method: string; args?: unknown[] }
  | { command: 'runtime-watch'; sessionId: string; path: string; componentType: string; property: string; timeoutMs?: number; intervalMs?: number; maxChanges?: number }
  | { command: 'runtime-input'; sessionId: string; inputType: 'tap' | 'click' | 'key'; x?: number; y?: number; key?: string }
  | {
      command: 'runtime-capture';
      sessionId: string;
      resolution?: { width: number; height: number };
      resolutions?: Array<{ width: number; height: number }>;
      crop?: { x: number; y: number; width: number; height: number };
      overlayNodeBounds?: string[] | true;
      overlayAnchors?: string[] | true;
    };

interface ParsedArguments {
  command: string;
  flags: Map<string, string>;
}

const PROJECT_SELECTOR_FLAGS = ['project-id', 'editor-instance-id'] as const;

// 每个命令只允许消费显式登记的参数，避免 AI 拼写错误后继续执行错误动作。
const COMMAND_FLAGS: Record<string, readonly string[]> = {
  editors: [],
  state: PROJECT_SELECTOR_FLAGS,
  'write-revision': PROJECT_SELECTOR_FLAGS,
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
  'design-inspect': [...PROJECT_SELECTOR_FLAGS, 'root-uuid'],
  'design-plan': [...PROJECT_SELECTOR_FLAGS, 'target'],
  'design-preview': [...PROJECT_SELECTOR_FLAGS, 'target'],
  'design-verify': [...PROJECT_SELECTOR_FLAGS, 'target'],
  'design-export': [...PROJECT_SELECTOR_FLAGS, 'root-uuid', 'scope', 'asset-uuid'],
  'design-apply': [...PROJECT_SELECTOR_FLAGS, 'target', 'execution-id', 'revision'],
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
  'write-prepare': [...PROJECT_SELECTOR_FLAGS, 'request'],
  'write-confirm': [...PROJECT_SELECTOR_FLAGS, 'transaction-id'],
  'transaction-status': [...PROJECT_SELECTOR_FLAGS, 'transaction-id'],
  'transaction-list': PROJECT_SELECTOR_FLAGS,
  'transaction-rollback': [...PROJECT_SELECTOR_FLAGS, 'transaction-id'],
  'preview-launch': [...PROJECT_SELECTOR_FLAGS, 'resolution', 'channel'],
  'preview-stop': ['session-id'],
  'preview-sessions': ['project-id'],
  'runtime-console': ['session-id', 'since-seq', 'level'],
  'runtime-hierarchy': ['session-id', 'max-depth', 'max-nodes'],
  'runtime-component': ['session-id', 'path', 'component-type'],
  'runtime-invoke': ['session-id', 'path', 'component-type', 'method', 'args'],
  'runtime-watch': ['session-id', 'path', 'component-type', 'property', 'timeout-ms', 'interval-ms', 'max-changes'],
  'runtime-input': ['session-id', 'input-type', 'x', 'y', 'key'],
  'runtime-capture': ['session-id', 'resolution', 'resolutions', 'crop', 'overlay-nodes', 'overlay-anchors']
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
  // 会话维度命令：Preview 页面会话由 Probe Server 管理，不需要项目选择器。
  if (command === 'preview-stop') {
    return { command, sessionId: requireFlag(flags, 'session-id', 'SESSION_ID_REQUIRED') };
  }
  if (command === 'runtime-console') {
    const level = flags.get('level');
    if (level && !['log', 'info', 'warn', 'error', 'debug'].includes(level)) {
      throw new Error('INVALID_CONSOLE_LEVEL');
    }
    return {
      command,
      sessionId: requireFlag(flags, 'session-id', 'SESSION_ID_REQUIRED'),
      ...(flags.has('since-seq') ? { sinceSeq: readNonNegativeInteger(flags.get('since-seq') ?? '', 'INVALID_SINCE_SEQ') } : {}),
      ...(level ? { level } : {})
    };
  }
  if (command === 'preview-sessions') {
    return {
      command,
      ...(flags.has('project-id') ? { projectId: flags.get('project-id') } : {})
    };
  }
  if (command === 'runtime-hierarchy') {
    return {
      command,
      sessionId: requireFlag(flags, 'session-id', 'SESSION_ID_REQUIRED'),
      ...(flags.has('max-depth') ? { maxDepth: readBoundedPositiveInteger(flags.get('max-depth') ?? '', 20, 'INVALID_MAX_DEPTH') } : {}),
      ...(flags.has('max-nodes') ? { maxNodes: readBoundedPositiveInteger(flags.get('max-nodes') ?? '', 10_000, 'INVALID_MAX_NODES') } : {})
    };
  }
  if (command === 'runtime-component') {
    return {
      command,
      sessionId: requireFlag(flags, 'session-id', 'SESSION_ID_REQUIRED'),
      path: requireFlag(flags, 'path', 'NODE_PATH_REQUIRED'),
      componentType: requireFlag(flags, 'component-type', 'COMPONENT_TYPE_REQUIRED')
    };
  }
  if (command === 'runtime-invoke') {
    return {
      command,
      sessionId: requireFlag(flags, 'session-id', 'SESSION_ID_REQUIRED'),
      path: requireFlag(flags, 'path', 'NODE_PATH_REQUIRED'),
      componentType: requireFlag(flags, 'component-type', 'COMPONENT_TYPE_REQUIRED'),
      method: requireFlag(flags, 'method', 'METHOD_REQUIRED'),
      ...(flags.has('args') ? { args: readInvokeArgs(flags.get('args') ?? '') } : {})
    };
  }
  if (command === 'runtime-watch') {
    return {
      command,
      sessionId: requireFlag(flags, 'session-id', 'SESSION_ID_REQUIRED'),
      path: requireFlag(flags, 'path', 'NODE_PATH_REQUIRED'),
      componentType: requireFlag(flags, 'component-type', 'COMPONENT_TYPE_REQUIRED'),
      property: requireFlag(flags, 'property', 'PROPERTY_REQUIRED'),
      ...(flags.has('timeout-ms') ? { timeoutMs: readBoundedPositiveInteger(flags.get('timeout-ms') ?? '', 55_000, 'INVALID_TIMEOUT_MS') } : {}),
      ...(flags.has('interval-ms') ? { intervalMs: readBoundedPositiveInteger(flags.get('interval-ms') ?? '', 10_000, 'INVALID_INTERVAL_MS') } : {}),
      ...(flags.has('max-changes') ? { maxChanges: readBoundedPositiveInteger(flags.get('max-changes') ?? '', 100, 'INVALID_MAX_CHANGES') } : {})
    };
  }
  if (command === 'runtime-input') {
    const inputType = requireFlag(flags, 'input-type', 'INPUT_TYPE_REQUIRED');
    if (inputType !== 'tap' && inputType !== 'click' && inputType !== 'key') {
      throw new Error('INVALID_INPUT_TYPE');
    }
    return {
      command,
      sessionId: requireFlag(flags, 'session-id', 'SESSION_ID_REQUIRED'),
      inputType,
      ...(flags.has('x') ? { x: readCoordinate(flags.get('x') ?? '') } : {}),
      ...(flags.has('y') ? { y: readCoordinate(flags.get('y') ?? '') } : {}),
      ...(flags.has('key') ? { key: flags.get('key') } : {})
    };
  }
  if (command === 'runtime-capture') {
    const resolution = flags.has('resolution') ? readResolution(flags.get('resolution') ?? '') : undefined;
    const resolutions = flags.has('resolutions') ? readResolutionList(flags.get('resolutions') ?? '') : undefined;
    if (resolution && resolutions) {
      throw new Error('CAPTURE_RESOLUTION_CONFLICT');
    }
    return {
      command,
      sessionId: requireFlag(flags, 'session-id', 'SESSION_ID_REQUIRED'),
      ...(resolution ? { resolution } : {}),
      ...(resolutions ? { resolutions } : {}),
      ...(flags.has('crop') ? { crop: readCropRect(flags.get('crop') ?? '') } : {}),
      ...(flags.has('overlay-nodes') ? { overlayNodeBounds: readOverlayValue(flags.get('overlay-nodes') ?? '') } : {}),
      ...(flags.has('overlay-anchors') ? { overlayAnchors: readOverlayValue(flags.get('overlay-anchors') ?? '') } : {})
    };
  }

  const projectId = requireFlag(flags, 'project-id', 'PROJECT_ID_REQUIRED');
  const editorInstanceId = flags.get('editor-instance-id');
  const selector = editorInstanceId ? { projectId, editorInstanceId } : { projectId };

  switch (command) {
    case 'preview-launch': {
      const channel = flags.get('channel');
      if (channel && channel !== 'chrome' && channel !== 'msedge') {
        throw new Error('INVALID_BROWSER_CHANNEL');
      }
      return {
        command,
        ...selector,
        ...(flags.has('resolution') ? { resolution: readResolution(flags.get('resolution') ?? '') } : {}),
        ...(channel ? { channel } : {})
      };
    }
    case 'state':
    case 'write-revision':
      return { command, ...selector };
    case 'asset-index':
    case 'prefab-graph':
      return { command, ...selector };
    case 'design-inspect':
      return {
        command,
        ...selector,
        ...(flags.has('root-uuid') ? { rootUuid: flags.get('root-uuid') } : {})
      };
    case 'design-plan':
    case 'design-preview':
    case 'design-verify':
      return {
        command,
        ...selector,
        target: readDesignTarget(requireFlag(flags, 'target', 'DESIGN_TARGET_REQUIRED'))
      };
    case 'design-export': {
      const scope = flags.get('scope') ?? 'current-document';
      if (scope !== 'current-document' && scope !== 'source-prefab' && scope !== 'apply-to-source') {
        throw new Error('INVALID_DESIGN_SCOPE');
      }
      return {
        command,
        ...selector,
        scope,
        ...(flags.has('root-uuid') ? { rootUuid: flags.get('root-uuid') } : {}),
        ...(flags.has('asset-uuid') ? { assetUuid: flags.get('asset-uuid') } : {})
      };
    }
    case 'design-apply': {
      const target = readDesignTarget(requireFlag(flags, 'target', 'DESIGN_TARGET_REQUIRED'));
      const revision = flags.has('revision')
        ? readDesignRevision(flags.get('revision') ?? '')
        : undefined;
      if (target.document.scope !== 'current-document' && !revision) {
        throw new Error('DESIGN_REVISION_REQUIRED');
      }
      return {
        command,
        ...selector,
        target,
        ...(flags.has('execution-id') ? { executionId: flags.get('execution-id') } : {}),
        ...(revision ? { revision } : {})
      };
    }
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

/** 解析并按阶段四协议校验声明式目标文档 JSON。 */
function readDesignTarget(value: string): DesignTargetDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('INVALID_DESIGN_TARGET_JSON');
  }
  try {
    return DesignTargetDocumentSchema.parse(parsed);
  } catch {
    throw new Error('INVALID_DESIGN_TARGET');
  }
}

/** 解析并校验跨文档声明式写入使用的五维 revision。 */
function readDesignRevision(value: string): RevisionPrecondition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('INVALID_DESIGN_REVISION_JSON');
  }
  try {
    return RevisionPreconditionSchema.parse(parsed);
  } catch {
    throw new Error('INVALID_DESIGN_REVISION');
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

/** 解析 `宽x高` 形式的分辨率参数（如 720x1280）。 */
function readResolution(value: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(value.trim().toLowerCase());
  if (!match) {
    throw new Error('INVALID_RESOLUTION');
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('INVALID_RESOLUTION');
  }
  return { width, height };
}

/** 解析非负整数参数（console 游标等）。 */
function readNonNegativeInteger(value: string, errorCode: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(errorCode);
  }
  return parsed;
}

/** 解析带上限的正整数参数（读取上限类参数）。 */
function readBoundedPositiveInteger(value: string, maximum: number, errorCode: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(errorCode);
  }
  return parsed;
}

/** 解析 invoke 位置参数 JSON 数组。 */
function readInvokeArgs(value: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('INVALID_INVOKE_ARGS_JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('INVALID_INVOKE_ARGS');
  }
  return parsed;
}

/** 解析画布坐标（CSS 像素，允许浮点）。 */
function readCoordinate(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('INVALID_COORDINATE');
  }
  return parsed;
}

/** 解析多分辨率 JSON 数组（如 `[{"width":720,"height":1280}]`）。 */
function readResolutionList(value: string): Array<{ width: number; height: number }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('INVALID_RESOLUTIONS_JSON');
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 8) {
    throw new Error('INVALID_RESOLUTIONS');
  }
  return parsed.map((entry) => {
    const item = entry && typeof entry === 'object' ? entry as { width?: unknown; height?: unknown } : {};
    if (
      typeof item.width !== 'number' || !Number.isInteger(item.width) || item.width < 1
      || typeof item.height !== 'number' || !Number.isInteger(item.height) || item.height < 1
    ) {
      throw new Error('INVALID_RESOLUTIONS');
    }
    return { width: item.width, height: item.height };
  });
}

/** 解析裁剪区域（`x,y,宽,高`）。 */
function readCropRect(value: string): { x: number; y: number; width: number; height: number } {
  const parts = value.split(',').map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    throw new Error('INVALID_CROP');
  }
  const [x, y, width, height] = parts;
  if (x! < 0 || y! < 0 || width! < 1 || height! < 1) {
    throw new Error('INVALID_CROP');
  }
  return { x: x!, y: y!, width: width!, height: height! };
}

/** 解析叠加开关：`true` 全量，或逗号分隔的节点路径列表。 */
function readOverlayValue(value: string): string[] | true {
  if (value.trim() === 'true') return true;
  const paths = value.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
  if (paths.length === 0) {
    throw new Error('INVALID_OVERLAY');
  }
  return paths;
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
