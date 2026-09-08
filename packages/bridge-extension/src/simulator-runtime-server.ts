import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const RUNTIME_AGENT_FILE = join(__dirname, '..', 'static', 'runtime-agent.js');
const RUNTIME_ACTIVE_MS = 2_000;
const EVALUATE_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

interface RequestLike {
  method?: string;
  path?: string;
  url?: string;
  body?: unknown;
  socket?: { remoteAddress?: string | null };
  on?(event: string, listener: (...args: any[]) => void): unknown;
  readableEnded?: boolean;
}

interface ResponseLike {
  statusCode?: number;
  status?(code: number): ResponseLike;
  json?(value: unknown): unknown;
  sendFile?(path: string): unknown;
  end?(value?: string): unknown;
  on?(event: string, listener: () => void): unknown;
  setHeader?(name: string, value: string): unknown;
}

interface RuntimeCommand {
  id: string;
  runtimeId: string;
  expression: string;
}

interface PendingEvaluation {
  runtimeId: string;
  response: ResponseLike;
  timer: NodeJS.Timeout;
}

let activeRuntimeId: string | null = null;
let lastSeenAt = 0;
const commands: RuntimeCommand[] = [];
const pending = new Map<string, PendingEvaluation>();

const staticAgentRoute = {
  url: '/plugins/cocos-ai/*',
  handle(request: RequestLike, response: ResponseLike, next: () => void): void {
    if (requestPath(request) !== '/plugins/cocos-ai/runtime-agent.js') return next();
    response.sendFile?.(RUNTIME_AGENT_FILE);
  }
};

const runtimeRoute = {
  url: '/cocos-ai/runtime/*',
  async handle(request: RequestLike, response: ResponseLike, next: () => void): Promise<void> {
      if (!isLoopback(request.socket?.remoteAddress)) {
        sendJson(response, 403, { error: 'LOOPBACK_REQUIRED' });
        return;
      }
      const path = requestPath(request);
      if (request.method === 'GET' && path === '/cocos-ai/runtime/status') {
        sendJson(response, 200, runtimeStatus());
        return;
      }
      if (request.method === 'GET' && path === '/cocos-ai/runtime/command') {
        const runtimeId = requestQuery(request).get('runtimeId');
        if (!runtimeId) {
          sendJson(response, 400, { error: 'RUNTIME_ID_REQUIRED' });
          return;
        }
        if (!markRuntimeActive(runtimeId)) {
          sendEmpty(response, 204);
          return;
        }
        const index = commands.findIndex((command) => command.runtimeId === runtimeId);
        if (index < 0) {
          sendEmpty(response, 204);
          return;
        }
        sendJson(response, 200, commands.splice(index, 1)[0]);
        return;
      }
      if (request.method === 'POST' && path === '/cocos-ai/runtime/evaluate') {
        const body = await readJsonBody(request);
        const runtimeId = typeof body.runtimeId === 'string' ? body.runtimeId : '';
        const expression = typeof body.expression === 'string' ? body.expression : '';
        const status = runtimeStatus();
        if (!runtimeId || !expression) {
          sendJson(response, 400, { error: 'RUNTIME_EVALUATE_INPUT_INVALID' });
          return;
        }
        if (!status.connected || activeRuntimeId !== runtimeId) {
          sendJson(response, 409, { error: 'CREATOR_SIMULATOR_RUNTIME_NOT_CONNECTED' });
          return;
        }
        const id = randomUUID();
        const timer = setTimeout(() => {
          pending.delete(id);
          sendJson(response, 504, { error: 'CREATOR_SIMULATOR_RUNTIME_TIMEOUT' });
        }, EVALUATE_TIMEOUT_MS);
        pending.set(id, { runtimeId, response, timer });
        commands.push({ id, runtimeId, expression });
        response.on?.('close', () => clearPending(id));
        return;
      }
      if (request.method === 'POST' && path === '/cocos-ai/runtime/result') {
        const body = await readJsonBody(request);
        const id = typeof body.id === 'string' ? body.id : '';
        const runtimeId = typeof body.runtimeId === 'string' ? body.runtimeId : '';
        const evaluation = pending.get(id);
        if (!evaluation || evaluation.runtimeId !== runtimeId) {
          sendJson(response, 404, { error: 'RUNTIME_COMMAND_NOT_FOUND' });
          return;
        }
        pending.delete(id);
        clearTimeout(evaluation.timer);
        sendJson(evaluation.response, body.ok === true ? 200 : 500, body.ok === true
          ? { ok: true, value: body.value }
          : { ok: false, error: typeof body.error === 'string' ? body.error : 'RUNTIME_EVALUATION_FAILED' });
        sendEmpty(response, 204);
        return;
      }
    next();
  }
};

/** Creator 3.8.x Server Contribution 按 HTTP 动词读取同名路由数组。 */
export const get = [staticAgentRoute, runtimeRoute];
export const post = [runtimeRoute];

/** 测试复位；运行时不会调用。 */
export function resetSimulatorRuntimeServer(): void {
  activeRuntimeId = null;
  lastSeenAt = 0;
  commands.length = 0;
  for (const id of [...pending.keys()]) clearPending(id);
}

function markRuntimeActive(runtimeId: string): boolean {
  if (activeRuntimeId && activeRuntimeId !== runtimeId && Date.now() - lastSeenAt <= RUNTIME_ACTIVE_MS) {
    return false;
  }
  if (activeRuntimeId && activeRuntimeId !== runtimeId) {
    for (const [id, evaluation] of pending) {
      if (evaluation.runtimeId !== runtimeId) {
        clearTimeout(evaluation.timer);
        sendJson(evaluation.response, 409, { error: 'CREATOR_SIMULATOR_RUNTIME_REPLACED' });
        pending.delete(id);
      }
    }
    commands.splice(0, commands.length, ...commands.filter((command) => command.runtimeId === runtimeId));
  }
  activeRuntimeId = runtimeId;
  lastSeenAt = Date.now();
  return true;
}

function runtimeStatus(): { connected: boolean; runtimeId: string | null; lastSeenAt: string | null } {
  const connected = Boolean(activeRuntimeId && Date.now() - lastSeenAt <= RUNTIME_ACTIVE_MS);
  return {
    connected,
    runtimeId: connected ? activeRuntimeId : null,
    lastSeenAt: lastSeenAt ? new Date(lastSeenAt).toISOString() : null
  };
}

function clearPending(id: string): void {
  const evaluation = pending.get(id);
  if (!evaluation) return;
  clearTimeout(evaluation.timer);
  pending.delete(id);
  const index = commands.findIndex((command) => command.id === id);
  if (index >= 0) commands.splice(index, 1);
}

function requestPath(request: RequestLike): string {
  if (typeof request.path === 'string' && request.path) return request.path;
  try {
    return new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    return '/';
  }
}

function requestQuery(request: RequestLike): URLSearchParams {
  try {
    return new URL(request.url ?? '/', 'http://127.0.0.1').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function isLoopback(address: string | null | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

async function readJsonBody(request: RequestLike): Promise<Record<string, unknown>> {
  if (request.body && typeof request.body === 'object' && !Array.isArray(request.body)) {
    return request.body as Record<string, unknown>;
  }
  if (!request.on || request.readableEnded) return {};
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on!('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('RUNTIME_HTTP_BODY_TOO_LARGE'));
        return;
      }
      chunks.push(buffer);
    });
    request.on!('end', () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(value && typeof value === 'object' && !Array.isArray(value) ? value : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on!('error', reject);
  });
}

function sendJson(response: ResponseLike, status: number, value: unknown): void {
  const target = response.status?.(status) ?? response;
  target.statusCode = status;
  if (target.json) {
    target.json(value);
    return;
  }
  target.setHeader?.('content-type', 'application/json; charset=utf-8');
  target.end?.(JSON.stringify(value));
}

function sendEmpty(response: ResponseLike, status: number): void {
  const target = response.status?.(status) ?? response;
  target.statusCode = status;
  target.end?.();
}
