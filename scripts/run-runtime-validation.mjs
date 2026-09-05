import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = readArgs(process.argv.slice(2));
if (!options.projectPath) throw new Error('PROJECT_PATH_REQUIRED');
const projectPath = resolve(options.projectPath);
const reportRoot = isAbsolute(options.reportRoot ?? '')
  ? resolve(options.reportRoot)
  : resolve(repoRoot, options.reportRoot ?? 'reports');
const runId = `${new Date().toISOString().replace(/[^0-9]/g, '')}-${randomUUID().slice(0, 8)}`;
const summaryPath = join(reportRoot, `runtime-validation-${runId}.json`);
const steps = [];
let client;
let sessionId;
let exitCode = 1;

await mkdir(reportRoot, { recursive: true });
const before = {
  toolkit: gitStatus(repoRoot),
  project: gitStatus(projectPath)
};
if (dirtyLines(before.project).length > 0) {
  throw new Error(`PROJECT_WORKTREE_NOT_CLEAN:${dirtyLines(before.project).join('|')}`);
}

try {
  if (!options.skipStatic) {
    runNpm(['test']);
    steps.push({ name: 'npm test', passed: true });
    runNpm(['run', 'typecheck']);
    steps.push({ name: 'npm run typecheck', passed: true });
    runNpm(['run', 'build']);
    steps.push({ name: 'npm run build', passed: true });
  }

  const entry = join(repoRoot, 'packages', 'mcp-server', 'dist', 'run.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: process.env,
    stderr: 'pipe'
  });
  client = new Client({ name: 'cocos-ai-runtime-validation', version: '1.0.0' });
  await client.connect(transport);

  const listed = await callTool('cocos_editor_list', {});
  const editors = Array.isArray(listed.editors) ? listed.editors : [];
  const matches = editors.filter((editor) => samePath(editor.projectPath, projectPath));
  if (matches.length !== 1) throw new Error(`CREATOR_EDITOR_AMBIGUOUS:${matches.length}`);
  const editor = matches[0];
  if (editor.creatorVersion !== '3.8.8') {
    throw new Error(`UNSUPPORTED_CREATOR_VERSION:${editor.creatorVersion ?? 'unknown'}`);
  }
  steps.push({ name: 'Creator Named Pipe discovery', passed: true, editorInstanceId: editor.editorInstanceId });

  const launch = await callTool('cocos_preview_launch', {
    projectId: editor.projectId,
    editorInstanceId: editor.editorInstanceId
  });
  sessionId = launch.sessionId;
  if (!sessionId || launch.state !== 'ready') throw new Error('PREVIEW_NOT_READY');
  steps.push({ name: 'preview launch', passed: true, sessionId });

  const hierarchy = await callTool('cocos_runtime_get_hierarchy', {
    sessionId,
    maxDepth: 8,
    maxNodes: 1_000
  });
  if (hierarchy.source !== 'preview-runtime' || !hierarchy.root?.name) {
    throw new Error('RUNTIME_HIERARCHY_INVALID');
  }
  steps.push({ name: 'runtime hierarchy', passed: true, root: hierarchy.root.name });

  const consoleResult = await callTool('cocos_runtime_get_console', { sessionId });
  if (!Array.isArray(consoleResult.entries) || !Number.isInteger(consoleResult.nextSeq)) {
    throw new Error('RUNTIME_CONSOLE_INVALID');
  }
  steps.push({ name: 'runtime console', passed: true, entries: consoleResult.entries.length });

  const capture = await callTool('cocos_runtime_capture', { sessionId });
  const capturePath = capture.files?.[0]?.path;
  if (typeof capturePath !== 'string') throw new Error('RUNTIME_CAPTURE_PATH_MISSING');
  await assertPng(capturePath);
  steps.push({ name: 'runtime capture', passed: true, path: capturePath });

  const scenario = await callTool('cocos_runtime_run_scenario', {
    projectId: editor.projectId,
    editorInstanceId: editor.editorInstanceId,
    steps: [
      { kind: 'launch' },
      { kind: 'capture' },
      { kind: 'stop', always: true }
    ]
  });
  if (scenario.passed !== true) throw new Error(`RUNTIME_SCENARIO_FAILED:${JSON.stringify(scenario)}`);
  steps.push({ name: 'runtime scenario', passed: true });

  const stopped = await callTool('cocos_preview_stop', { sessionId });
  if (stopped.closed !== true) throw new Error('PREVIEW_STOP_NOT_CONFIRMED');
  sessionId = undefined;
  steps.push({ name: 'preview stop', passed: true });

  const after = {
    toolkit: gitStatus(repoRoot),
    project: gitStatus(projectPath)
  };
  if (before.toolkit !== after.toolkit || before.project !== after.project) {
    throw new Error('GIT_STATUS_CHANGED_DURING_VALIDATION');
  }
  steps.push({ name: 'git status unchanged', passed: true });
  exitCode = 0;
  await writeSummary('passed');
} catch (error) {
  steps.push({ name: 'failure', passed: false, error: readReason(error) });
  await writeSummary('failed');
  process.stderr.write(`${readReason(error)}\n`);
} finally {
  if (sessionId && client) {
    await callTool('cocos_preview_stop', { sessionId }).catch(() => undefined);
  }
  await client?.close().catch(() => undefined);
}

process.stdout.write(`${JSON.stringify({ ok: exitCode === 0, report: summaryPath })}\n`);
process.exitCode = exitCode;

async function callTool(name, args) {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) {
    throw new Error(response.structuredContent?.error?.code ?? `MCP_TOOL_FAILED:${name}`);
  }
  return response.structuredContent ?? {};
}

async function assertPng(path) {
  const bytes = await readFile(path);
  if (bytes.length < 24 || bytes.subarray(1, 4).toString('ascii') !== 'PNG') {
    throw new Error(`INVALID_PNG:${path}`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 100 || height < 100) throw new Error(`PNG_TOO_SMALL:${width}x${height}`);
}

async function writeSummary(status) {
  await writeFile(summaryPath, `${JSON.stringify({
    runId,
    status,
    projectPath,
    transport: 'named-pipe',
    steps,
    completedAt: new Date().toISOString()
  }, null, 2)}\n`, 'utf8');
}

function runNpm(args) {
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd: repoRoot,
    stdio: 'inherit'
  });
}

function gitStatus(path) {
  return execFileSync('git', ['-C', path, 'status', '--porcelain=v2', '--branch'], {
    encoding: 'utf8'
  });
}

function dirtyLines(status) {
  return status.split(/\r?\n/).filter((line) => line && !line.startsWith('#'));
}

function samePath(left, right) {
  return typeof left === 'string' && resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function readReason(error) {
  return error instanceof Error ? error.message : String(error);
}

function readArgs(argv) {
  const output = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--skip-static') {
      output.skipStatic = true;
      continue;
    }
    if (!value.startsWith('--') || index + 1 >= argv.length) throw new Error(`INVALID_ARGUMENT:${value}`);
    output[toCamel(value.slice(2))] = argv[index + 1];
    index += 1;
  }
  return output;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}
