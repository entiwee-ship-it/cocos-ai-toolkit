import { mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import {
  ResolutionSchema,
  RuntimeComponentSnapshotSchema,
  RuntimeSampleWindowInputSchema,
  RuntimeSampleWindowSnapshotSchema,
  ScenarioStepSchema
} from '@cocos-ai/protocol';
import {
  assembleRuntimeNodeSnapshot,
  buildRuntimeScript,
  diffPng,
  runRuntimeScenario,
  RuntimeDriver,
  watchRuntimeProperty,
  type ScenarioRuntime
} from '@cocos-ai/core';
import { z } from 'zod';
import { launchPlaywrightBrowser } from './playwright-launcher.js';

const DEFAULT_CAPTURE_FILES_PER_SESSION = 100;
const DEFAULT_CAPTURE_MAX_SESSIONS = 50;
const DEFAULT_CAPTURE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;

const SelectorSchema = z.object({
  projectId: z.string().min(1),
  editorInstanceId: z.string().min(1).optional()
});
const SessionSchema = z.object({ sessionId: z.string().min(1) });
const PreviewLaunchSchema = z.object({
  selector: SelectorSchema,
  params: z.object({
    resolution: ResolutionSchema.optional(),
    channel: z.string().min(1).optional()
  }).optional()
});
const PreviewSessionsSchema = z.object({ projectId: z.string().min(1).optional() });
const RuntimeConsoleSchema = SessionSchema.extend({
  sinceSeq: z.number().int().nonnegative().optional(),
  level: z.enum(['log', 'info', 'warn', 'error', 'debug']).optional()
});
const RuntimeHierarchySchema = SessionSchema.extend({
  maxDepth: z.number().int().positive().max(20).optional(),
  maxNodes: z.number().int().positive().max(10_000).optional(),
  path: z.string().min(1).optional(),
  includeInactive: z.boolean().optional()
});
const RuntimeComponentSchema = SessionSchema.extend({
  path: z.string().min(1),
  componentType: z.string().min(1)
});
const RuntimeInvokeSchema = RuntimeComponentSchema.extend({
  method: z.string().min(1),
  args: z.array(z.unknown()).optional()
});
const RuntimeSampleWindowSchema = RuntimeSampleWindowInputSchema.extend({
  sessionId: z.string().min(1)
});
const RuntimeWatchSchema = RuntimeComponentSchema.extend({
  property: z.string().min(1),
  timeoutMs: z.number().int().positive().max(55_000).optional(),
  intervalMs: z.number().int().positive().max(10_000).optional(),
  maxChanges: z.number().int().positive().max(100).optional()
});
const RuntimeInputSchema = SessionSchema.extend({
  inputType: z.enum(['tap', 'click', 'key']),
  x: z.number().optional(),
  y: z.number().optional(),
  key: z.string().min(1).optional()
});
const RuntimeInstantiateSchema = SessionSchema.extend({
  assetUuid: z.string().min(1),
  parentPath: z.string().min(1),
  x: z.number().optional(),
  y: z.number().optional()
});
const OverlaySchema = z.object({
  nodeBounds: z.union([z.boolean(), z.array(z.string().min(1))]).optional(),
  anchors: z.union([z.boolean(), z.array(z.string().min(1))]).optional()
}).optional();
const RuntimeCaptureSchema = SessionSchema.extend({
  resolution: ResolutionSchema.optional(),
  resolutions: z.array(ResolutionSchema).min(1).max(8).optional(),
  crop: z.object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive()
  }).optional(),
  overlay: OverlaySchema
}).refine((value) => !(value.resolution && value.resolutions), {
  message: 'resolution 与 resolutions 只能二选一'
});
const RuntimeScenarioSchema = z.object({
  selector: SelectorSchema.optional(),
  sessionId: z.string().min(1).optional(),
  steps: z.array(ScenarioStepSchema).min(1)
});

export const RUNTIME_METHODS = new Set([
  'server.previewLaunch',
  'server.previewStop',
  'server.previewSessions',
  'server.previewSession',
  'server.runtimeConsole',
  'server.runtimeHierarchy',
  'server.runtimeComponent',
  'server.runtimeInvoke',
  'server.runtimeSampleWindow',
  'server.runtimeWatch',
  'server.runtimeDispatchInput',
  'server.runtimeInstantiate',
  'server.runtimeCapture',
  'server.runtimeRunScenario'
]);

export interface RuntimeControllerOptions {
  requestCreator(
    selector: { projectId: string; editorInstanceId?: string },
    method: string,
    payload: unknown
  ): Promise<unknown>;
  captureRoot: string;
  captureFilesPerSession?: number;
  captureMaxSessions?: number;
  captureMaxAgeMs?: number;
  driver?: RuntimeDriver;
}

/** Preview 和运行态会话跟随当前 MCP/CLI 进程，不再依赖独立服务。 */
export class RuntimeController {
  private readonly driver: RuntimeDriver;
  private captureIndex = 0;

  constructor(private readonly options: RuntimeControllerOptions) {
    this.driver = options.driver ?? new RuntimeDriver({ launcher: launchPlaywrightBrowser });
  }

  async request(method: string, payload: unknown): Promise<unknown> {
    switch (method) {
      case 'server.previewLaunch': {
        const input = PreviewLaunchSchema.parse(payload);
        return this.launchPreview(input.selector, input.params);
      }
      case 'server.previewStop':
        return this.driver.close(SessionSchema.parse(payload).sessionId);
      case 'server.previewSessions':
        return this.driver.list(PreviewSessionsSchema.parse(payload).projectId);
      case 'server.previewSession':
        return this.driver.get(SessionSchema.parse(payload).sessionId);
      case 'server.runtimeConsole': {
        const input = RuntimeConsoleSchema.parse(payload);
        return this.driver.readConsole(input.sessionId, {
          ...(input.sinceSeq !== undefined ? { sinceSeq: input.sinceSeq } : {}),
          ...(input.level ? { level: input.level } : {})
        });
      }
      case 'server.runtimeHierarchy': {
        const input = RuntimeHierarchySchema.parse(payload);
        const raw = await this.driver.evaluate(
          input.sessionId,
          buildRuntimeScript('readRuntimeHierarchy', {
            ...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
            ...(input.maxNodes !== undefined ? { maxNodes: input.maxNodes } : {}),
            ...(input.path ? { path: input.path } : {}),
            ...(input.includeInactive !== undefined ? { includeInactive: input.includeInactive } : {})
          })
        );
        if (raw && typeof raw === 'object' && (raw as { found?: unknown }).found === false) {
          throw new Error(`RUNTIME_HIERARCHY_UNAVAILABLE:${JSON.stringify(raw)}`);
        }
        return assembleRuntimeNodeSnapshot(raw, input.sessionId);
      }
      case 'server.runtimeComponent': {
        const input = RuntimeComponentSchema.parse(payload);
        const raw = await this.driver.evaluate<Record<string, unknown>>(
          input.sessionId,
          buildRuntimeScript('readRuntimeComponent', {
            path: input.path,
            componentType: input.componentType
          })
        );
        if (!raw || raw.found !== true) {
          throw new Error(`RUNTIME_COMPONENT_UNAVAILABLE:${JSON.stringify(raw ?? null)}`);
        }
        return {
          ...RuntimeComponentSnapshotSchema.parse({
            source: 'preview-runtime',
            previewSessionId: input.sessionId,
            nodeUuid: typeof raw.nodeUuid === 'string' && raw.nodeUuid ? raw.nodeUuid : 'unknown',
            componentType: input.componentType,
            properties: raw.properties ?? {},
            capturedAt: new Date().toISOString()
          }),
          ...(Array.isArray(raw.skipped) ? { skipped: raw.skipped } : {})
        };
      }
      case 'server.runtimeInvoke': {
        const input = RuntimeInvokeSchema.parse(payload);
        return this.driver.evaluate(
          input.sessionId,
          buildRuntimeScript('invokeRuntimeComponentMethod', {
            path: input.path,
            componentType: input.componentType,
            method: input.method,
            args: input.args ?? []
          })
        );
      }
      case 'server.runtimeSampleWindow': {
        const input = RuntimeSampleWindowSchema.parse(payload);
        const raw = await this.driver.evaluate<Record<string, unknown>>(
          input.sessionId,
          buildRuntimeScript('sampleRuntimeWindow', {
            path: input.path,
            componentType: input.componentType,
            properties: input.properties,
            mode: input.mode,
            durationMs: input.durationMs,
            ...(input.trigger ? { trigger: input.trigger } : {})
          })
        );
        if (!raw || raw.found !== true) {
          throw new Error(`RUNTIME_SAMPLE_WINDOW_UNAVAILABLE:${JSON.stringify(raw ?? null)}`);
        }
        return RuntimeSampleWindowSnapshotSchema.parse({
          source: 'preview-runtime',
          previewSessionId: input.sessionId,
          capturedAt: new Date().toISOString(),
          path: input.path,
          nodeUuid: raw.nodeUuid,
          componentType: raw.componentType ?? input.componentType,
          mode: input.mode,
          durationMs: input.durationMs,
          samples: raw.samples,
          ...(raw.trigger !== undefined ? { trigger: raw.trigger } : {}),
          ...(raw.truncated === true ? { truncated: true } : {}),
          ...(raw.timedOut === true ? { timedOut: true } : {})
        });
      }
      case 'server.runtimeWatch': {
        const input = RuntimeWatchSchema.parse(payload);
        return watchRuntimeProperty(async () => {
          const result = await this.driver.evaluate<Record<string, unknown>>(
            input.sessionId,
            buildRuntimeScript('readRuntimeProperty', {
              path: input.path,
              componentType: input.componentType,
              property: input.property
            })
          );
          if (!result || result.found !== true) {
            throw new Error(`RUNTIME_PROPERTY_UNAVAILABLE:${JSON.stringify(result ?? null)}`);
          }
          return result.value;
        }, {
          ...(input.intervalMs !== undefined ? { intervalMs: input.intervalMs } : {}),
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
          ...(input.maxChanges !== undefined ? { maxChanges: input.maxChanges } : {})
        });
      }
      case 'server.runtimeDispatchInput': {
        const input = RuntimeInputSchema.parse(payload);
        return this.driver.dispatchInput(input.sessionId, {
          inputType: input.inputType,
          ...(input.x !== undefined ? { x: input.x } : {}),
          ...(input.y !== undefined ? { y: input.y } : {}),
          ...(input.key !== undefined ? { key: input.key } : {})
        });
      }
      case 'server.runtimeInstantiate': {
        const input = RuntimeInstantiateSchema.parse(payload);
        return this.driver.evaluate(
          input.sessionId,
          buildRuntimeScript('instantiateRuntimePrefab', {
            assetUuid: input.assetUuid,
            parentPath: input.parentPath,
            ...(input.x !== undefined ? { x: input.x } : {}),
            ...(input.y !== undefined ? { y: input.y } : {})
          })
        );
      }
      case 'server.runtimeCapture':
        return this.capture(RuntimeCaptureSchema.parse(payload));
      case 'server.runtimeRunScenario': {
        const input = RuntimeScenarioSchema.parse(payload);
        return runRuntimeScenario(input.steps, this.assembleScenarioRuntime(input.selector), {
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input.selector ? { projectId: input.selector.projectId } : {})
        });
      }
      default:
        throw new Error('METHOD_NOT_ALLOWED');
    }
  }

  dispose(): Promise<void> {
    return this.driver.dispose();
  }

  private async launchPreview(
    selector: { projectId: string; editorInstanceId?: string },
    params?: { resolution?: { width: number; height: number }; channel?: string }
  ) {
    const opened = await this.options.requestCreator(selector, 'probe.previewOpen', {}) as { url?: unknown };
    if (!opened || typeof opened.url !== 'string' || !opened.url) {
      throw new Error('PREVIEW_URL_UNAVAILABLE');
    }
    return this.driver.launch({
      projectId: selector.projectId,
      ...(selector.editorInstanceId ? { editorInstanceId: selector.editorInstanceId } : {}),
      url: opened.url,
      ...(params?.resolution ? { resolution: params.resolution } : {}),
      ...(params?.channel ? { channel: params.channel } : {})
    });
  }

  private assembleScenarioRuntime(
    selector?: { projectId: string; editorInstanceId?: string }
  ): ScenarioRuntime {
    return {
      launch: async (input) => {
        if (!selector) throw new Error('SCENARIO_SELECTOR_REQUIRED');
        const session = await this.launchPreview(selector, {
          ...(input.resolution ? { resolution: input.resolution } : {})
        });
        return { sessionId: session.sessionId };
      },
      waitNode: async (sessionId, path, timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        while (true) {
          const result = await this.driver.evaluate<{ entries?: Array<{ found?: boolean }> }>(
            sessionId,
            buildRuntimeScript('readRuntimeNodeBounds', { paths: [path] })
          );
          if (result.entries?.[0]?.found) return { found: true };
          if (Date.now() >= deadline) return { found: false };
          await new Promise<void>((resolveWait) => setTimeout(resolveWait, 250));
        }
      },
      readProperty: async (sessionId, path, componentType, property) => {
        const result = await this.driver.evaluate<Record<string, unknown>>(
          sessionId,
          buildRuntimeScript('readRuntimeProperty', { path, componentType, property })
        );
        if (result.found !== true) {
          return {
            found: false,
            reason: typeof result.reason === 'string' ? result.reason : 'unknown'
          };
        }
        return { found: true, value: result.value };
      },
      dispatchInput: (sessionId, input) => this.driver.dispatchInput(sessionId, input as never),
      instantiatePrefab: (sessionId, input) => this.driver.evaluate(
        sessionId,
        buildRuntimeScript('instantiateRuntimePrefab', input)
      ),
      stop: (sessionId) => this.driver.close(sessionId),
      readConsole: (sessionId, sinceSeq) => Promise.resolve(
        this.driver.readConsole(sessionId, { sinceSeq })
      ),
      capture: async (sessionId, input) => {
        const overlay = input.overlay
          ? await this.resolveOverlay(sessionId, input.overlay)
          : undefined;
        const image = await this.driver.capture(sessionId, {
          ...(input.resolution ? { resolution: input.resolution } : {}),
          ...(input.crop ? { crop: input.crop } : {}),
          ...(overlay ? { overlay } : {})
        });
        return { path: await this.saveCapture(sessionId, image.buffer, this.nextCaptureIndex()) };
      },
      imageDiff: async (sessionId, baselinePath) => {
        const root = resolve(this.options.captureRoot);
        const baseline = resolve(root, baselinePath);
        if (!baseline.startsWith(`${root}${sep}`)) throw new Error('BASELINE_PATH_OUT_OF_ROOT');
        const current = await this.driver.capture(sessionId, {});
        const diff = diffPng(await readFile(baseline), current.buffer);
        return {
          diffRatio: diff.diffRatio,
          diffPngPath: await this.saveCapture(sessionId, diff.diffPng, this.nextCaptureIndex())
        };
      }
    };
  }

  private async capture(input: z.infer<typeof RuntimeCaptureSchema>) {
    const overlay = await this.resolveOverlay(input.sessionId, input.overlay);
    const resolutions = input.resolutions ?? (input.resolution ? [input.resolution] : [undefined]);
    const files: Array<Record<string, unknown>> = [];
    for (const resolution of resolutions) {
      const image = await this.driver.capture(input.sessionId, {
        ...(resolution ? { resolution } : {}),
        ...(input.crop ? { crop: input.crop } : {}),
        ...(overlay ? { overlay } : {})
      });
      files.push({
        path: await this.saveCapture(input.sessionId, image.buffer, this.nextCaptureIndex()),
        width: image.width,
        height: image.height,
        ...(resolution ? { requestedResolution: resolution } : {}),
        actualResolution: image.actualResolution,
        cropped: Boolean(input.crop),
        overlays: {
          nodeBounds: Boolean(overlay?.nodeBounds.length),
          anchors: Boolean(overlay?.anchors.length)
        }
      });
    }
    return { files, capturedAt: new Date().toISOString() };
  }

  private async resolveOverlay(
    sessionId: string,
    overlay?: { nodeBounds?: boolean | string[]; anchors?: boolean | string[] }
  ): Promise<{ nodeBounds: string[]; anchors: string[] } | undefined> {
    if (!overlay || (!overlay.nodeBounds && !overlay.anchors)) return undefined;
    const allPaths = async (value: boolean | string[] | undefined): Promise<string[]> => {
      if (Array.isArray(value)) return value;
      if (value !== true) return [];
      const hierarchy = await this.driver.evaluate<Record<string, unknown>>(
        sessionId,
        buildRuntimeScript('readRuntimeHierarchy', {
          maxDepth: 8,
          maxNodes: 50,
          includeInactive: true
        })
      );
      const paths: string[] = [];
      const walk = (node: Record<string, unknown>, parentPath: string): void => {
        if (paths.length >= 50) return;
        const name = typeof node.name === 'string' ? node.name : '';
        const path = parentPath ? `${parentPath}/${name}` : name;
        if (path) paths.push(path);
        for (const child of Array.isArray(node.children) ? node.children : []) {
          if (child && typeof child === 'object' && !Array.isArray(child)) {
            walk(child as Record<string, unknown>, path);
          }
        }
      };
      walk(hierarchy, '');
      return paths;
    };
    return {
      nodeBounds: await allPaths(overlay.nodeBounds),
      anchors: await allPaths(overlay.anchors)
    };
  }

  private nextCaptureIndex(): number {
    this.captureIndex += 1;
    return this.captureIndex;
  }

  private async saveCapture(sessionId: string, buffer: Buffer, index: number): Promise<string> {
    const root = this.options.captureRoot;
    const safeSession = sessionId.replace(/[^a-zA-Z0-9-]/g, '_');
    const directory = join(root, safeSession);
    await mkdir(directory, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '');
    const filePath = join(directory, `${timestamp}-${index}.png`);
    await writeFile(filePath, buffer);
    const retention = positiveInteger(this.options.captureFilesPerSession, DEFAULT_CAPTURE_FILES_PER_SESSION);
    const files = (await readdir(directory)).filter((name) => name.endsWith('.png')).sort();
    await Promise.all(
      files.slice(0, Math.max(0, files.length - retention))
        .map((name) => unlink(join(directory, name)).catch(() => undefined))
    );
    await this.pruneCaptureSessions(root, safeSession).catch((error) => {
      process.stderr.write(`${JSON.stringify({
        event: 'cocos-ai.capture-retention-failed',
        message: error instanceof Error ? error.message : String(error)
      })}\n`);
    });
    return filePath;
  }

  private async pruneCaptureSessions(root: string, currentSession: string): Promise<void> {
    const maxSessions = positiveInteger(this.options.captureMaxSessions, DEFAULT_CAPTURE_MAX_SESSIONS);
    const maxAgeMs = positiveInteger(this.options.captureMaxAgeMs, DEFAULT_CAPTURE_MAX_AGE_MS);
    const entries = await readdir(root, { withFileTypes: true });
    const sessions = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map(async (entry) => {
        const path = join(root, entry.name);
        return { name: entry.name, path, mtimeMs: (await stat(path)).mtimeMs };
      }));
    const expired = sessions.filter((session) => (
      session.name !== currentSession && Date.now() - session.mtimeMs > maxAgeMs
    ));
    await Promise.all(expired.map((session) => rm(session.path, { recursive: true, force: true })));
    const expiredNames = new Set(expired.map((session) => session.name));
    const remaining = sessions
      .filter((session) => session.name !== currentSession && !expiredNames.has(session.name))
      .sort((left, right) => left.mtimeMs - right.mtimeMs);
    const overflow = Math.max(0, remaining.length + 1 - maxSessions);
    await Promise.all(remaining.slice(0, overflow).map((session) => (
      rm(session.path, { recursive: true, force: true })
    )));
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}
