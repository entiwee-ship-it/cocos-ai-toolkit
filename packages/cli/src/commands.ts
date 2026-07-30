import {
  ScenarioStepSchema,
  type ScenarioStep
} from '@cocos-ai/protocol';
import { z } from 'zod';

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
  | { command: 'save-report'; projectId: string; editorInstanceId?: string; sample: string }
  | { command: 'preview-launch'; projectId: string; editorInstanceId?: string; resolution?: { width: number; height: number }; channel?: string }
  | { command: 'preview-stop'; sessionId: string }
  | { command: 'preview-sessions'; projectId?: string }
  | { command: 'runtime-console'; sessionId: string; sinceSeq?: number; level?: string }
  | {
      command: 'runtime-hierarchy';
      sessionId: string;
      maxDepth?: number;
      maxNodes?: number;
      path?: string;
      includeInactive?: boolean;
    }
  | { command: 'runtime-component'; sessionId: string; path: string; componentType: string }
  | { command: 'runtime-invoke'; sessionId: string; path: string; componentType: string; method: string; args?: unknown[] }
  | { command: 'runtime-watch'; sessionId: string; path: string; componentType: string; property: string; timeoutMs?: number; intervalMs?: number; maxChanges?: number }
  | { command: 'runtime-input'; sessionId: string; inputType: 'tap' | 'click' | 'key'; x?: number; y?: number; key?: string }
  | { command: 'runtime-instantiate'; sessionId: string; assetUuid: string; parentPath: string; x?: number; y?: number }
  | {
      command: 'runtime-capture';
      sessionId: string;
      resolution?: { width: number; height: number };
      resolutions?: Array<{ width: number; height: number }>;
      crop?: { x: number; y: number; width: number; height: number };
      overlayNodeBounds?: string[] | true;
      overlayAnchors?: string[] | true;
    }
  | { command: 'runtime-scenario'; sessionId?: string; projectId?: string; editorInstanceId?: string; steps: ScenarioStep[] };

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
  'save-report': [...PROJECT_SELECTOR_FLAGS, 'sample'],
  'preview-launch': [...PROJECT_SELECTOR_FLAGS, 'resolution', 'channel'],
  'preview-stop': ['session-id'],
  'preview-sessions': ['project-id'],
  'runtime-console': ['session-id', 'since-seq', 'level'],
  'runtime-hierarchy': ['session-id', 'max-depth', 'max-nodes', 'path', 'include-inactive'],
  'runtime-component': ['session-id', 'path', 'component-type'],
  'runtime-invoke': ['session-id', 'path', 'component-type', 'method', 'args'],
  'runtime-watch': ['session-id', 'path', 'component-type', 'property', 'timeout-ms', 'interval-ms', 'max-changes'],
  'runtime-input': ['session-id', 'input-type', 'x', 'y', 'key'],
  'runtime-instantiate': ['session-id', 'asset-uuid', 'parent-path', 'x', 'y'],
  'runtime-capture': ['session-id', 'resolution', 'resolutions', 'crop', 'overlay-nodes', 'overlay-anchors'],
  'runtime-scenario': ['session-id', 'project-id', 'editor-instance-id', 'steps']
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
    const includeInactive = readOptionalBoolean(flags, 'include-inactive', 'INVALID_INCLUDE_INACTIVE');
    return {
      command,
      sessionId: requireFlag(flags, 'session-id', 'SESSION_ID_REQUIRED'),
      ...(flags.has('max-depth') ? { maxDepth: readBoundedPositiveInteger(flags.get('max-depth') ?? '', 20, 'INVALID_MAX_DEPTH') } : {}),
      ...(flags.has('max-nodes') ? { maxNodes: readBoundedPositiveInteger(flags.get('max-nodes') ?? '', 10_000, 'INVALID_MAX_NODES') } : {}),
      ...(flags.has('path') ? { path: requireFlag(flags, 'path', 'NODE_PATH_REQUIRED') } : {}),
      ...(includeInactive !== undefined ? { includeInactive } : {})
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
  if (command === 'runtime-instantiate') {
    return {
      command,
      sessionId: requireFlag(flags, 'session-id', 'SESSION_ID_REQUIRED'),
      assetUuid: requireFlag(flags, 'asset-uuid', 'ASSET_UUID_REQUIRED'),
      parentPath: requireFlag(flags, 'parent-path', 'PARENT_PATH_REQUIRED'),
      ...(flags.has('x') ? { x: readSignedCoordinate(flags.get('x') ?? '') } : {}),
      ...(flags.has('y') ? { y: readSignedCoordinate(flags.get('y') ?? '') } : {})
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
  if (command === 'runtime-scenario') {
    const sessionId = flags.get('session-id');
    const projectId = flags.get('project-id');
    if (!sessionId && !projectId) {
      throw new Error('SCENARIO_TARGET_REQUIRED');
    }
    return {
      command,
      ...(sessionId ? { sessionId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(flags.has('editor-instance-id') ? { editorInstanceId: flags.get('editor-instance-id') } : {}),
      steps: readScenarioSteps(requireFlag(flags, 'steps', 'SCENARIO_STEPS_REQUIRED'))
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
      return { command, ...selector };
    case 'asset-index':
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
    default:
      throw new Error('UNKNOWN_COMMAND');
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

/** 解析节点坐标（允许负数，锚点居中语义下负坐标合法）。 */
function readSignedCoordinate(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
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

/** 解析并按协议校验场景步骤 JSON 数组。 */
function readScenarioSteps(value: string): ScenarioStep[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('INVALID_SCENARIO_STEPS_JSON');
  }
  try {
    return z.array(ScenarioStepSchema).min(1).parse(parsed);
  } catch {
    throw new Error('INVALID_SCENARIO_STEPS');
  }
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
