export type CliCommand =
  | { command: 'editors' }
  | { command: 'state'; projectId: string; editorInstanceId?: string }
  | { command: 'assets'; projectId: string; editorInstanceId?: string; pattern: string; uuid?: string }
  | { command: 'open-asset'; projectId: string; editorInstanceId?: string; uuid: string }
  | { command: 'hierarchy'; projectId: string; editorInstanceId?: string; depth: number }
  | { command: 'node'; projectId: string; editorInstanceId?: string; uuid: string }
  | { command: 'component'; projectId: string; editorInstanceId?: string; uuid: string }
  | { command: 'prefab'; projectId: string; editorInstanceId?: string; nodeUuid: string }
  | { command: 'save-report'; projectId: string; editorInstanceId?: string; sample: string };

interface ParsedArguments {
  command: string;
  flags: Map<string, string>;
}

/**
 * 将 CLI 参数解析为稳定的探针命令对象。
 *
 * @param argv 不包含 node 和入口脚本路径的参数数组。
 * @returns 已校验的 CLI 命令。
 */
export function parseCommand(argv: string[]): CliCommand {
  const { command, flags } = parseArguments(argv);
  if (command === 'editors') {
    return { command };
  }

  const projectId = requireFlag(flags, 'project-id', 'PROJECT_ID_REQUIRED');
  const editorInstanceId = flags.get('editor-instance-id');
  const selector = editorInstanceId ? { projectId, editorInstanceId } : { projectId };

  switch (command) {
    case 'state':
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

function requireFlag(flags: Map<string, string>, name: string, errorCode: string): string {
  const value = flags.get(name);
  if (!value) {
    throw new Error(errorCode);
  }
  return value;
}
