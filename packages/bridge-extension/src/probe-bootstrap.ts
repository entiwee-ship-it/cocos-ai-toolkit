import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';

export type ProbeBootstrapResult = 'already-running' | 'started' | 'unsupported-url';

export interface ProbeServerBootstrapConfig {
  url: string;
  bridgeDistDirectory: string;
  nodePath?: string;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface ProbeServerBootstrapDependencies {
  isReachable(url: string): Promise<boolean>;
  startProbe(input: {
    nodePath: string;
    toolkitRoot: string;
    probeEntry: string;
    reportRoot: string;
    host: string;
    port: number;
  }): Promise<void>;
  sleep(delayMs: number): Promise<void>;
  now(): number;
}

export function createProbeServerBootstrap(
  config: ProbeServerBootstrapConfig,
  dependencies: ProbeServerBootstrapDependencies = nodeDependencies
): { ensureRunning(): Promise<ProbeBootstrapResult> } {
  let inFlight: Promise<ProbeBootstrapResult> | null = null;
  return {
    ensureRunning() {
      inFlight ??= ensureProbeServerRunning(config, dependencies).finally(() => {
        inFlight = null;
      });
      return inFlight;
    }
  };
}

export function resolveProbeRuntimePaths(bridgeDistDirectory: string): {
  toolkitRoot: string;
  probeEntry: string;
  reportRoot: string;
} {
  const toolkitRoot = resolve(bridgeDistDirectory, '..', '..', '..');
  return {
    toolkitRoot,
    probeEntry: join(toolkitRoot, 'packages', 'probe-server', 'dist', 'run.js'),
    reportRoot: join(toolkitRoot, 'reports')
  };
}

async function ensureProbeServerRunning(
  config: ProbeServerBootstrapConfig,
  dependencies: ProbeServerBootstrapDependencies
): Promise<ProbeBootstrapResult> {
  const target = readLoopbackTarget(config.url);
  if (!target) return 'unsupported-url';
  if (await dependencies.isReachable(config.url)) return 'already-running';

  const paths = resolveProbeRuntimePaths(config.bridgeDistDirectory);
  await dependencies.startProbe({
    nodePath: config.nodePath ?? process.env.COCOS_AI_NODE_PATH ?? 'node',
    ...paths,
    ...target
  });

  const timeoutMs = config.startupTimeoutMs ?? 10_000;
  const pollIntervalMs = config.pollIntervalMs ?? 250;
  const deadline = dependencies.now() + timeoutMs;
  while (true) {
    if (await dependencies.isReachable(config.url)) return 'started';
    if (dependencies.now() >= deadline) throw new Error('PROBE_AUTO_START_TIMEOUT');
    await dependencies.sleep(pollIntervalMs);
  }
}

function readLoopbackTarget(url: string): { host: string; port: number } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)) return null;
  const port = Number(parsed.port || 32188);
  return Number.isInteger(port) && port > 0 && port <= 65535
    ? { host: '127.0.0.1', port }
    : null;
}

export async function isProbeServerReachable(url: string, token = process.env.COCOS_AI_SESSION_TOKEN): Promise<boolean> {
  if (!readLoopbackTarget(url)) return false;
  return new Promise<boolean>((resolveReachable) => {
    const socket = new WebSocket(url, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
    let finished = false;
    const finish = (reachable: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.terminate();
      resolveReachable(reachable);
    };
    const timer = setTimeout(() => finish(false), 1_000);
    socket.once('open', () => {
      socket.send(JSON.stringify({ method: 'client.hello', payload: { clientName: 'cocos-ai-bridge-bootstrap' } }));
    });
    socket.once('message', (raw) => {
      try {
        const response = JSON.parse(raw.toString()) as { correlationId?: unknown; ok?: unknown };
        finish(response.correlationId === 'client.hello' && response.ok === true);
      } catch {
        finish(false);
      }
    });
    socket.once('error', () => finish(false));
  });
}

const nodeDependencies: ProbeServerBootstrapDependencies = {
  isReachable: isProbeServerReachable,
  startProbe: async (input) => {
    if (!existsSync(input.probeEntry)) {
      throw new Error(`PROBE_ENTRY_NOT_FOUND:${input.probeEntry}`);
    }
    mkdirSync(input.reportRoot, { recursive: true });
    const stdout = openSync(join(input.reportRoot, 'probe-server.out.log'), 'a');
    const stderr = openSync(join(input.reportRoot, 'probe-server.err.log'), 'a');
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(input.nodePath, [input.probeEntry], {
        cwd: input.toolkitRoot,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', stdout, stderr],
        env: {
          ...process.env,
          COCOS_AI_PROBE_HOST: input.host,
          COCOS_AI_PROBE_PORT: String(input.port),
          COCOS_AI_CAPTURE_ROOT: join(input.reportRoot, 'runtime-captures')
        }
      });
    } finally {
      closeSync(stdout);
      closeSync(stderr);
    }
    await new Promise<void>((resolveSpawn, reject) => {
      child.once('spawn', resolveSpawn);
      child.once('error', reject);
    });
    child.unref();
  },
  sleep: (delayMs) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, delayMs)),
  now: () => Date.now()
};
