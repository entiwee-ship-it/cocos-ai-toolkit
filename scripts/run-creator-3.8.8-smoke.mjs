import { execFileSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

class SmokeSkip extends Error {}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = readArgs(process.argv.slice(2));
const projectPath = resolveRequiredPath(args.projectPath, 'PROJECT_PATH_REQUIRED');
const worktreeRoot = resolve(args.worktreeRoot ?? 'E:/xile-workspace/worktrees');
const reportRoot = resolve(args.reportRoot ?? join(repoRoot, 'reports', 'creator-smoke'));
const targetPrefabUuid = args.targetPrefabUuid ?? null;
const instantiatePrefabUuid = args.instantiatePrefabUuid ?? null;
const instanceName = args.instanceName ?? 'CocosAiPrefabSmoke';
const unpackMode = args.unpackMode ?? null;
const writeApplicability = args.writeApplicability === 'true';
if (Boolean(targetPrefabUuid) !== Boolean(instantiatePrefabUuid)) {
  throw new Error('PREFAB_SMOKE_UUID_PAIR_REQUIRED');
}
if (args.writeApplicability !== undefined && args.writeApplicability !== 'true' && args.writeApplicability !== 'false') {
  throw new Error(`WRITE_APPLICABILITY_INVALID:${args.writeApplicability}`);
}
if (unpackMode !== null && unpackMode !== 'current' && unpackMode !== 'complete') {
  throw new Error(`PREFAB_UNPACK_MODE_INVALID:${unpackMode}`);
}
if (unpackMode && (!targetPrefabUuid || !instantiatePrefabUuid)) {
  throw new Error('PREFAB_UNPACK_REQUIRES_INSTANTIATE_FIXTURE');
}
if (writeApplicability && (!targetPrefabUuid || !instantiatePrefabUuid)) {
  throw new Error('WRITE_APPLICABILITY_REQUIRES_INSTANTIATE_FIXTURE');
}
const mcpEntry = join(repoRoot, 'packages', 'mcp-server', 'dist', 'run.js');
const toolkitVersion = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')).version;
const result = {
  status: 'failed',
  toolkitVersion,
  projectPath,
  transport: 'named-pipe',
  creatorVersion: null,
  editorInstanceId: null,
  steps: []
};

let client;
try {
  assertInside(projectPath, worktreeRoot, 'PROJECT_MUST_BE_ISOLATED_WORKTREE');
  assertOutside(reportRoot, projectPath, 'REPORT_ROOT_INSIDE_PROJECT');
  await stat(mcpEntry);
  const gitStatusBefore = readGitStatus(projectPath);
  result.steps.push('git-before');

  const transport = new StdioClientTransport({
    command: process.execPath,
      args: [mcpEntry],
    env: {
      ...process.env,
      ...(process.env.COCOS_AI_ENDPOINT_ROOT
        ? { COCOS_AI_ENDPOINT_ROOT: process.env.COCOS_AI_ENDPOINT_ROOT }
        : {})
    },
    stderr: 'pipe'
  });
  client = new Client({ name: 'cocos-ai-creator-smoke', version: toolkitVersion });
  await client.connect(transport);

  const editorList = await waitForProjectEditor(client, projectPath, 2_000);
  result.steps.push('editors');
  const editors = Array.isArray(editorList.editors) ? editorList.editors : [];
  const matches = editors.filter((editor) => samePath(editor.projectPath, projectPath));
  if (matches.length !== 1) throw new Error('CREATOR_EDITOR_AMBIGUOUS');
  const editor = matches[0];
  result.creatorVersion = editor.creatorVersion ?? null;
  result.editorInstanceId = editor.editorInstanceId ?? null;
  if (editor.creatorVersion !== '3.8.8') {
    throw new Error(`UNSUPPORTED_CREATOR_VERSION:${editor.creatorVersion ?? 'unknown'}`);
  }

  const hierarchyResult = await callTool(client, {
    name: 'cocos_hierarchy',
    arguments: {
      projectId: editor.projectId,
      editorInstanceId: editor.editorInstanceId,
      depth: 50
    }
  });
  result.steps.push('hierarchy');
  const root = unwrapHierarchy(hierarchyResult.hierarchy);
  const target = findNodeWithComponent(root, 'cc.UITransform');
  if (!target) throw new Error('UI_TRANSFORM_NODE_NOT_FOUND');

  const writeResult = await callTool(client, {
    name: 'cocos_component_add',
    arguments: {
      projectId: editor.projectId,
      editorInstanceId: editor.editorInstanceId,
      nodeUuid: target.nodeUuid,
      componentType: 'cc.UITransform'
    }
  });
  result.steps.push('direct-write-noop');
  if (writeResult.outcome?.kind !== 'success' || writeResult.outcome?.verification?.passed !== true) {
    throw new Error(`DIRECT_WRITE_SMOKE_FAILED:${JSON.stringify(writeResult.outcome ?? null)}`);
  }

  if (targetPrefabUuid && instantiatePrefabUuid) {
    result.prefabInstantiate = await runPrefabInstantiateSmoke(client, editor, {
      targetPrefabUuid,
      instantiatePrefabUuid,
      instanceName,
      unpackMode,
      writeApplicability
    });
  }

  const gitStatusAfter = readGitStatus(projectPath);
  result.steps.push('git-after');
  if (gitStatusBefore !== gitStatusAfter) {
    throw new Error('PROJECT_GIT_STATUS_CHANGED');
  }
  result.status = 'passed';
  result.message = 'CREATOR_SMOKE_PASSED';
  process.exitCode = 0;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const unavailable = error instanceof SmokeSkip
    || /CREATOR_IPC_UNAVAILABLE|CREATOR_CLIENT_NOT_READY|MCP_SERVER_START_FAILED|Connection closed/.test(message);
  result.status = unavailable ? 'skipped' : 'failed';
  result.message = message;
  process.exitCode = unavailable ? 2 : 1;
} finally {
  await client?.close().catch(() => undefined);
}
await writeResult();

async function callTool(targetClient, request) {
  const response = await targetClient.callTool(request);
  if (response.isError) throw new Error(`MCP_TOOL_FAILED:${request.name}:${JSON.stringify(response.content)}`);
  return response.structuredContent ?? {};
}

/** 等待 Creator 扩展发布 Named Pipe 端点，并返回包含目标工程的编辑器列表。 */
async function waitForProjectEditor(targetClient, targetProjectPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const editorList = await callTool(targetClient, { name: 'cocos_editor_list', arguments: {} });
    const editors = Array.isArray(editorList.editors) ? editorList.editors : [];
    if (editors.some((editor) => samePath(editor.projectPath, targetProjectPath))) return editorList;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new SmokeSkip('CREATOR_EDITOR_NOT_FOUND');
}

async function runPrefabInstantiateSmoke(targetClient, editor, options) {
  let parentPath = null;
  let instancePath = null;
  try {
    await callTool(targetClient, {
      name: 'cocos_prefab_open',
      arguments: {
        projectId: editor.projectId,
        editorInstanceId: editor.editorInstanceId,
        uuid: options.targetPrefabUuid
      }
    });
    const before = unwrapHierarchy((await callTool(targetClient, {
      name: 'cocos_hierarchy',
      arguments: {
        projectId: editor.projectId,
        editorInstanceId: editor.editorInstanceId,
        depth: 50
      }
    })).hierarchy);
    const targetRoot = findPrefabRoot(before, options.targetPrefabUuid);
    parentPath = readNodePath(targetRoot);
    if (!parentPath) throw new Error('PREFAB_SMOKE_TARGET_ROOT_NOT_FOUND');
    instancePath = `${parentPath}/${options.instanceName}`;
    if (findNodeByPath(before, instancePath)) throw new Error(`PREFAB_SMOKE_NODE_ALREADY_EXISTS:${instancePath}`);

    const instantiated = await callTool(targetClient, {
      name: 'cocos_prefab_instantiate',
      arguments: {
        projectId: editor.projectId,
        editorInstanceId: editor.editorInstanceId,
        prefabUuid: options.instantiatePrefabUuid,
        parentPath,
        name: options.instanceName
      }
    });
    result.steps.push('prefab-instantiate');
    if (
      instantiated.prefabAssetUuid !== options.instantiatePrefabUuid
      || typeof instantiated.nodeUuid !== 'string'
      || typeof instantiated.instanceFileId !== 'string'
      || typeof instantiated.stablePath !== 'string'
      || instantiated.verification?.passed !== true
    ) {
      throw new Error(`PREFAB_INSTANTIATE_SMOKE_FAILED:${JSON.stringify(instantiated)}`);
    }

    await callTool(targetClient, {
      name: 'cocos_prefab_open',
      arguments: {
        projectId: editor.projectId,
        editorInstanceId: editor.editorInstanceId,
        uuid: options.targetPrefabUuid
      }
    });
    result.steps.push('prefab-instantiate-reopen');
    const reopened = unwrapHierarchy((await callTool(targetClient, {
      name: 'cocos_hierarchy',
      arguments: {
        projectId: editor.projectId,
        editorInstanceId: editor.editorInstanceId,
        depth: 50
      }
    })).hierarchy);
    const persisted = findNodeByPath(reopened, instancePath);
    if (!persisted || readPrefabAssetUuid(persisted) !== options.instantiatePrefabUuid) {
      throw new Error(`PREFAB_INSTANTIATE_REOPEN_VERIFY_FAILED:${instancePath}`);
    }
    const writeRouting = options.writeApplicability
      ? await runWriteApplicabilitySmoke(targetClient, editor, persisted, options.instantiatePrefabUuid)
      : null;
    let unpack = null;
    if (options.unpackMode) {
      const unpacked = await callTool(targetClient, {
        name: 'cocos_prefab_unpack',
        arguments: {
          projectId: editor.projectId,
          editorInstanceId: editor.editorInstanceId,
          path: instancePath,
          mode: options.unpackMode,
          expectedPrefabAssetUuid: options.instantiatePrefabUuid
        }
      });
      result.steps.push(`prefab-unpack-${options.unpackMode}`);
      const actual = unpacked.verification?.items?.[0]?.actual ?? {};
      const modePassed = options.unpackMode === 'complete'
        ? actual.allAssociationsRemoved === true
        : actual.nestedAssociationsPreserved === true;
      if (
        unpacked.mode !== options.unpackMode
        || unpacked.verification?.passed !== true
        || actual.subtreePreserved !== true
        || actual.componentsPreserved !== true
        || !modePassed
      ) {
        throw new Error(`PREFAB_UNPACK_SMOKE_FAILED:${JSON.stringify(unpacked)}`);
      }
      await callTool(targetClient, {
        name: 'cocos_prefab_open',
        arguments: {
          projectId: editor.projectId,
          editorInstanceId: editor.editorInstanceId,
          uuid: options.targetPrefabUuid
        }
      });
      const unpackedHierarchy = unwrapHierarchy((await callTool(targetClient, {
        name: 'cocos_hierarchy',
        arguments: {
          projectId: editor.projectId,
          editorInstanceId: editor.editorInstanceId,
          depth: 50
        }
      })).hierarchy);
      const unpackedNode = findNodeByPath(unpackedHierarchy, instancePath);
      if (!unpackedNode || readPrefabAssetUuid(unpackedNode) === options.instantiatePrefabUuid) {
        throw new Error(`PREFAB_UNPACK_REOPEN_VERIFY_FAILED:${instancePath}`);
      }
      unpack = {
        mode: options.unpackMode,
        oldNodeUuid: unpacked.oldNodeUuid,
        nodeUuid: unpacked.nodeUuid,
        stablePath: unpacked.stablePath,
        verification: actual
      };
    }
    return {
      nodeUuid: instantiated.nodeUuid,
      prefabAssetUuid: instantiated.prefabAssetUuid,
      instanceFileId: instantiated.instanceFileId,
      stablePath: instantiated.stablePath,
      reopenedNodeUuid: readNodeUuid(persisted),
      reopenedPath: readNodePath(persisted),
      ...(writeRouting ? { writeRouting } : {}),
      ...(unpack ? { unpack } : {})
    };
  } finally {
    if (instancePath) {
      await callTool(targetClient, {
        name: 'cocos_prefab_open',
        arguments: {
          projectId: editor.projectId,
          editorInstanceId: editor.editorInstanceId,
          uuid: options.targetPrefabUuid
        }
      });
      const cleanupHierarchy = unwrapHierarchy((await callTool(targetClient, {
        name: 'cocos_hierarchy',
        arguments: {
          projectId: editor.projectId,
          editorInstanceId: editor.editorInstanceId,
          depth: 50
        }
      })).hierarchy);
      const cleanupNode = findNodeByPath(cleanupHierarchy, instancePath);
      const cleanupNodeUuid = readNodeUuid(cleanupNode);
      if (cleanupNodeUuid) {
        await callTool(targetClient, {
          name: 'cocos_node_delete',
          arguments: {
            projectId: editor.projectId,
            editorInstanceId: editor.editorInstanceId,
            nodeUuid: cleanupNodeUuid
          }
        });
        result.steps.push('prefab-instantiate-cleanup');
      }
    }
  }
}

async function runWriteApplicabilitySmoke(targetClient, editor, instanceRoot, sourcePrefabUuid) {
  const instanceRootUuid = readNodeUuid(instanceRoot);
  const contentNode = Array.isArray(instanceRoot?.children) ? instanceRoot.children[0] : null;
  const contentNodeUuid = readNodeUuid(contentNode);
  if (!instanceRootUuid || !contentNodeUuid) throw new Error('WRITE_APPLICABILITY_FIXTURE_INVALID');

  const [rootRead, contentRead] = await Promise.all([
    callTool(targetClient, {
      name: 'cocos_node_read',
      arguments: {
        projectId: editor.projectId,
        editorInstanceId: editor.editorInstanceId,
        nodeUuid: instanceRootUuid
      }
    }),
    callTool(targetClient, {
      name: 'cocos_node_read',
      arguments: {
        projectId: editor.projectId,
        editorInstanceId: editor.editorInstanceId,
        nodeUuid: contentNodeUuid
      }
    })
  ]);
  const rootCapabilities = rootRead.writeCapabilities;
  const contentCapabilities = contentRead.writeCapabilities;
  if (
    rootCapabilities?.canRename !== true
    || rootCapabilities?.canSetTransform !== true
    || rootCapabilities?.canCreateChild !== false
    || rootCapabilities?.canSetComponentProperty !== false
  ) {
    throw new Error(`WRITE_APPLICABILITY_ROOT_CAPABILITIES_INVALID:${JSON.stringify(rootCapabilities ?? null)}`);
  }
  if (
    contentCapabilities?.canSetTransform !== false
    || contentCapabilities?.canSetComponentProperty !== false
    || contentCapabilities?.ownerPrefabUuid !== sourcePrefabUuid
    || contentCapabilities?.nextAction?.tool !== 'cocos_prefab_open'
  ) {
    throw new Error(`WRITE_APPLICABILITY_CONTENT_CAPABILITIES_INVALID:${JSON.stringify(contentCapabilities ?? null)}`);
  }

  const contentNodeData = contentRead.node?.data ?? contentRead.node;
  const position = contentNodeData?.transform?.position;
  if (!position || ['x', 'y', 'z'].some((key) => typeof position[key] !== 'number')) {
    throw new Error('WRITE_APPLICABILITY_CONTENT_POSITION_INVALID');
  }
  const rejected = await targetClient.callTool({
    name: 'cocos_node_set_transform',
    arguments: {
      projectId: editor.projectId,
      editorInstanceId: editor.editorInstanceId,
      nodeUuid: contentNodeUuid,
      localTransform: { position }
    }
  });
  if (!rejected.isError || !JSON.stringify(rejected.content).includes('NODE_NOT_EDITABLE_IN_CURRENT_DOCUMENT')) {
    throw new Error(`WRITE_APPLICABILITY_REJECTION_MISSING:${JSON.stringify(rejected)}`);
  }
  result.steps.push('write-applicability-rejected');

  const editorState = await callTool(targetClient, {
    name: 'cocos_editor_state',
    arguments: {
      projectId: editor.projectId,
      editorInstanceId: editor.editorInstanceId
    }
  });
  if (editorState.state?.document?.dirty !== false) {
    throw new Error(`WRITE_APPLICABILITY_DIRTY_AFTER_REJECTION:${JSON.stringify(editorState.state ?? null)}`);
  }
  result.steps.push('write-applicability-clean');
  return {
    instanceRootUuid,
    contentNodeUuid,
    ownerPrefabUuid: contentCapabilities.ownerPrefabUuid,
    errorCode: 'NODE_NOT_EDITABLE_IN_CURRENT_DOCUMENT',
    dirtyAfterRejection: false
  };
}

async function writeResult() {
  result.finishedAt = new Date().toISOString();
  await mkdir(reportRoot, { recursive: true });
  const filePath = join(reportRoot, `${result.finishedAt.replace(/[^0-9]/g, '')}.json`);
  await writeFile(filePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ ...result, reportPath: filePath })}\n`);
}

function readArgs(argv) {
  const output = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('INVALID_ARGUMENTS');
    output[key.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = value;
  }
  return output;
}

function resolveRequiredPath(value, code) {
  if (!value) throw new Error(code);
  return resolve(value);
}

function readGitStatus(path) {
  const runGit = (arguments_) => execFileSync('git', ['-C', path, ...arguments_], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return JSON.stringify({
    status: runGit(['status', '--porcelain=v2', '--branch']),
    unstaged: runGit(['diff', '--binary', '--no-ext-diff']),
    staged: runGit(['diff', '--cached', '--binary', '--no-ext-diff'])
  });
}

function samePath(left, right) {
  if (typeof left !== 'string') return false;
  return resolve(left).replaceAll('\\', '/').toLowerCase() === resolve(right).replaceAll('\\', '/').toLowerCase();
}

function assertInside(path, root, code) {
  const scoped = relative(root, path);
  if (!scoped || scoped.startsWith('..') || isAbsolute(scoped)) throw new Error(code);
}

function assertOutside(path, root, code) {
  const scoped = relative(root, path);
  if (!scoped.startsWith('..') && !isAbsolute(scoped)) throw new Error(code);
}

function unwrapHierarchy(value) {
  if (!value || typeof value !== 'object') throw new Error('HIERARCHY_INVALID');
  return value.data && typeof value.data === 'object' ? value.data : value;
}

function findPrefabRoot(node, prefabAssetUuid) {
  if (!node || typeof node !== 'object') return null;
  if (readPrefabAssetUuid(node) === prefabAssetUuid) return node;
  for (const child of Array.isArray(node.children) ? node.children : []) {
    const found = findPrefabRoot(child, prefabAssetUuid);
    if (found) return found;
  }
  return null;
}

function findNodeByPath(node, path) {
  if (!node || typeof node !== 'object') return null;
  if (readNodePath(node) === path) return node;
  for (const child of Array.isArray(node.children) ? node.children : []) {
    const found = findNodeByPath(child, path);
    if (found) return found;
  }
  return null;
}

function readNodeUuid(node) {
  const value = node?.identity?.objectUuid ?? node?.uuid;
  return typeof value === 'string' && value ? value : null;
}

function readNodePath(node) {
  return typeof node?.path === 'string' && node.path && node.path !== '/' ? node.path : null;
}

function readPrefabAssetUuid(node) {
  const value = node?.prefab?.assetUuid;
  return typeof value === 'string' && value ? value : null;
}

function findNodeWithComponent(node, componentType) {
  if (!node || typeof node !== 'object') return null;
  const components = Array.isArray(node.components) ? node.components : [];
  const matches = components.some((component) => {
    const className = component?.class?.className ?? component?.className ?? component?.type;
    return String(className).replace(/^cc\./, '') === componentType.replace(/^cc\./, '');
  });
  const nodeUuid = node.identity?.objectUuid ?? node.uuid;
  if (matches && typeof nodeUuid === 'string' && nodeUuid) return { nodeUuid };
  for (const child of Array.isArray(node.children) ? node.children : []) {
    const found = findNodeWithComponent(child, componentType);
    if (found) return found;
  }
  return null;
}
