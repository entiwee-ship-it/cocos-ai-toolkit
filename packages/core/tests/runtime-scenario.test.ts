import { describe, expect, it } from 'vitest';
import { ScenarioReportSchema, type ScenarioStep } from '@cocos-ai/protocol';
import { runRuntimeScenario, type ScenarioRuntime } from '../src/runtime-scenario.js';

/** 构造记录调用的假运行时。 */
function createFakeRuntime(overrides: Partial<ScenarioRuntime> = {}) {
  const calls: Array<{ op: string; args: unknown }> = [];
  const runtime: ScenarioRuntime = {
    async launch(input) {
      calls.push({ op: 'launch', args: input });
      return { sessionId: 'sess-1' };
    },
    async waitNode(sessionId, path) {
      calls.push({ op: 'waitNode', args: { sessionId, path } });
      return { found: true };
    },
    async readProperty(sessionId, path, componentType, property) {
      calls.push({ op: 'readProperty', args: { sessionId, path, componentType, property } });
      return { found: true, value: true };
    },
    async dispatchInput(sessionId, input) {
      calls.push({ op: 'dispatchInput', args: { sessionId, input } });
      return { dispatched: true };
    },
    async instantiatePrefab(sessionId, input) {
      calls.push({ op: 'instantiatePrefab', args: { sessionId, input } });
      return { done: true, nodePath: `${input.parentPath}/Dialog` };
    },
    async stop(sessionId) {
      calls.push({ op: 'stop', args: { sessionId } });
      return { closed: true };
    },
    async readConsole() {
      calls.push({ op: 'readConsole', args: {} });
      return { entries: [{ level: 'log', text: '登录成功' }], nextSeq: 1 };
    },
    async capture(sessionId, options) {
      calls.push({ op: 'capture', args: { sessionId, options } });
      return { path: 'captures/sess-1/1.png' };
    },
    async imageDiff(sessionId, baselinePath, threshold) {
      calls.push({ op: 'imageDiff', args: { sessionId, baselinePath, threshold } });
      return { diffRatio: 0.001, diffPngPath: 'captures/sess-1/diff.png' };
    },
    ...overrides
  };
  return { runtime, calls };
}

const NOW = () => new Date('2026-07-22T06:40:00.000Z');

describe('runRuntimeScenario（自动场景验证编排）', () => {
  it('全步骤序列按序执行并通过报告校验', async () => {
    const { runtime, calls } = createFakeRuntime();
    const steps: ScenarioStep[] = [
      { kind: 'launch', resolution: { width: 720, height: 1280 } },
      { kind: 'wait-node', path: 'Canvas/btn', timeoutMs: 1000 },
      { kind: 'assert-property', path: 'Canvas/btn', property: 'cc.Button.interactable', expected: true },
      { kind: 'dispatch-input', inputType: 'tap', x: 100, y: 200 },
      { kind: 'instantiate-prefab', assetUuid: 'asset-1', parentPath: 'Canvas/LayerUI', x: 0, y: -10 },
      { kind: 'assert-console', pattern: '登录成功', level: 'log', timeoutMs: 500 },
      { kind: 'capture', overlay: { nodeBounds: ['Canvas/btn'] } },
      { kind: 'assert-image-diff', baselinePath: 'captures/baseline.png', threshold: 0.01 },
      { kind: 'stop' }
    ];
    const report = await runRuntimeScenario(steps, runtime, { projectId: 'proj1', now: NOW });
    expect(() => ScenarioReportSchema.parse(report)).not.toThrow();
    expect(report.passed).toBe(true);
    expect(report.steps.map((step) => step.kind)).toEqual([
      'launch', 'wait-node', 'assert-property', 'dispatch-input', 'instantiate-prefab', 'assert-console', 'capture', 'assert-image-diff', 'stop'
    ]);
    expect(calls.map((call) => call.op)).toEqual([
      'launch', 'waitNode', 'readProperty', 'dispatchInput', 'instantiatePrefab', 'readConsole', 'capture', 'imageDiff', 'stop'
    ]);
    // assert-property 的 property 拆为组件类型 + 属性路径
    expect(calls[2].args).toMatchObject({ componentType: 'cc.Button', property: 'interactable' });
    expect(report.steps[7]).toMatchObject({ passed: true, evidence: 'captures/sess-1/diff.png' });
  });

  it('已有会话时 launch 复用而非新建', async () => {
    const { runtime, calls } = createFakeRuntime();
    const report = await runRuntimeScenario(
      [{ kind: 'launch' }],
      runtime,
      { sessionId: 'existing-1', now: NOW }
    );
    expect(report.passed).toBe(true);
    expect(report.steps[0]).toMatchObject({ kind: 'launch', passed: true, actual: 'existing-1' });
    expect(calls.filter((call) => call.op === 'launch')).toHaveLength(0);
  });

  it('无会话且无 projectId 时 launch 步骤失败', async () => {
    const { runtime } = createFakeRuntime();
    const report = await runRuntimeScenario([{ kind: 'launch' }], runtime, { now: NOW });
    expect(report.passed).toBe(false);
    expect(report.steps[0]).toMatchObject({ kind: 'launch', passed: false });
  });

  it('断言失败默认中止，后续步骤不再执行', async () => {
    const { runtime, calls } = createFakeRuntime({
      readProperty: async () => ({ found: true, value: false })
    });
    const report = await runRuntimeScenario([
      { kind: 'assert-property', path: 'Canvas/btn', property: 'cc.Button.interactable', expected: true },
      { kind: 'dispatch-input', inputType: 'tap', x: 1, y: 1 }
    ], runtime, { sessionId: 's1', now: NOW });
    expect(report.passed).toBe(false);
    expect(report.steps).toHaveLength(1);
    expect(report.steps[0]).toMatchObject({ passed: false, expected: true, actual: false });
    expect(calls.filter((call) => call.op === 'dispatchInput')).toHaveLength(0);
  });

  it('onFail=continue 时失败后继续后续步骤', async () => {
    const { runtime, calls } = createFakeRuntime({
      readProperty: async () => ({ found: true, value: false })
    });
    const report = await runRuntimeScenario([
      { kind: 'assert-property', path: 'Canvas/btn', property: 'cc.Button.interactable', expected: true, onFail: 'continue' },
      { kind: 'dispatch-input', inputType: 'tap', x: 1, y: 1 }
    ], runtime, { sessionId: 's1', now: NOW });
    expect(report.passed).toBe(false);
    expect(report.steps).toHaveLength(2);
    expect(calls.filter((call) => call.op === 'dispatchInput')).toHaveLength(1);
  });

  it('instantiate-prefab 以 done=false 判定失败并保留实际原因', async () => {
    const { runtime } = createFakeRuntime({
      instantiatePrefab: async () => ({ done: false, reason: 'parent-not-found' })
    });
    const report = await runRuntimeScenario([
      { kind: 'instantiate-prefab', assetUuid: 'asset-1', parentPath: 'Canvas/Missing' }
    ], runtime, { sessionId: 's1', now: NOW });
    expect(report.passed).toBe(false);
    expect(report.steps[0]).toMatchObject({
      kind: 'instantiate-prefab',
      passed: false,
      actual: { done: false, reason: 'parent-not-found' }
    });
    expect(report.steps[0].error).toContain('INSTANTIATE_PREFAB_FAILED:parent-not-found');
  });

  it('默认 abort 后跳过普通步骤但仍执行 stop(always=true)，且清理不覆盖原失败', async () => {
    const { runtime, calls } = createFakeRuntime({
      readProperty: async () => ({ found: true, value: false })
    });
    const report = await runRuntimeScenario([
      { kind: 'assert-property', path: 'Canvas/btn', property: 'cc.Button.interactable', expected: true },
      { kind: 'dispatch-input', inputType: 'tap', x: 1, y: 1 },
      { kind: 'stop', always: true }
    ], runtime, { sessionId: 's1', now: NOW });
    expect(report.passed).toBe(false);
    expect(report.steps.map((step) => step.kind)).toEqual(['assert-property', 'stop']);
    expect(calls.filter((call) => call.op === 'dispatchInput')).toHaveLength(0);
    expect(calls.filter((call) => call.op === 'stop')).toHaveLength(1);
    expect(report.steps[1]).toMatchObject({ passed: true, actual: { closed: true } });
  });

  it('既有会话的 Console baseline 读取失败时仍执行所有 stop(always=true)，并保留原始错误', async () => {
    const { runtime, calls } = createFakeRuntime({
      readConsole: async () => {
        throw new Error('console baseline failed');
      }
    });
    await expect(runRuntimeScenario([
      { kind: 'dispatch-input', inputType: 'tap', x: 1, y: 1 },
      { kind: 'stop', always: true },
      { kind: 'stop', always: true }
    ], runtime, { sessionId: 's1', now: NOW })).rejects.toThrow('console baseline failed');
    expect(calls.filter((call) => call.op === 'stop')).toHaveLength(2);
    expect(calls.filter((call) => call.op === 'dispatchInput')).toHaveLength(0);
  });

  it('Console baseline 与 always-stop 都失败时组合错误但不丢失 baseline 原因', async () => {
    const { runtime, calls } = createFakeRuntime({
      readConsole: async () => {
        throw new Error('console baseline failed');
      },
      stop: async (sessionId) => {
        calls.push({ op: 'stop', args: { sessionId } });
        throw new Error('close failed');
      }
    });
    await expect(runRuntimeScenario([
      { kind: 'stop', always: true }
    ], runtime, { sessionId: 's1', now: NOW })).rejects.toThrow(/console baseline failed;SCENARIO_ALWAYS_STOP_FAILED:.*close failed/);
    expect(calls.filter((call) => call.op === 'stop')).toHaveLength(1);
  });

  it('stop 成功后清空内部 sessionId', async () => {
    const { runtime } = createFakeRuntime();
    const report = await runRuntimeScenario([
      { kind: 'stop' },
      { kind: 'wait-node', path: 'Canvas/btn' }
    ], runtime, { sessionId: 's1', now: NOW });
    expect(report.passed).toBe(false);
    expect(report.steps[0]).toMatchObject({ kind: 'stop', passed: true });
    expect(report.steps[1]).toMatchObject({ kind: 'wait-node', passed: false, error: 'SCENARIO_SESSION_REQUIRED' });
  });

  it('stop 返回 closed=false 时失败且保留内部 sessionId', async () => {
    const { runtime, calls } = createFakeRuntime({
      stop: async (sessionId) => {
        calls.push({ op: 'stop', args: { sessionId } });
        return { closed: false };
      }
    });
    const report = await runRuntimeScenario([
      { kind: 'stop', onFail: 'continue' },
      { kind: 'wait-node', path: 'Canvas/btn' }
    ], runtime, { sessionId: 's1', now: NOW });

    expect(report.passed).toBe(false);
    expect(report.steps[0]).toMatchObject({
      kind: 'stop',
      passed: false,
      error: 'PREVIEW_CLOSE_NOT_CONFIRMED'
    });
    expect(report.steps[1]).toMatchObject({ kind: 'wait-node', passed: true });
    expect(calls.find((call) => call.op === 'waitNode')?.args).toMatchObject({ sessionId: 's1' });
  });

  it('assert-console 有界轮询直至匹配，超时失败', async () => {
    let reads = 0;
    const { runtime } = createFakeRuntime({
      readConsole: async () => {
        reads += 1;
        return reads >= 3
          ? { entries: [{ level: 'log', text: '连接成功 room-1' }], nextSeq: reads }
          : { entries: [], nextSeq: reads };
      }
    });
    const hit = await runRuntimeScenario([
      { kind: 'assert-console', pattern: '连接成功 room-\\d+', timeoutMs: 2_000 }
    ], runtime, { sessionId: 's1', now: NOW, consolePollMs: 1 });
    expect(hit.passed).toBe(true);
    expect(reads).toBeGreaterThanOrEqual(3);

    const miss = await runRuntimeScenario([
      { kind: 'assert-console', pattern: '永不出现', timeoutMs: 10 }
    ], runtime, { sessionId: 's1', now: NOW, consolePollMs: 1 });
    expect(miss.passed).toBe(false);
    expect(miss.steps[0].error).toContain('超时');
  });

  it('assert-image-diff 按阈值判定', async () => {
    const { runtime } = createFakeRuntime({
      imageDiff: async () => ({ diffRatio: 0.02, diffPngPath: 'captures/diff.png' })
    });
    const below = await runRuntimeScenario([
      { kind: 'assert-image-diff', baselinePath: 'b.png', threshold: 0.05 }
    ], runtime, { sessionId: 's1', now: NOW });
    expect(below.passed).toBe(true);

    const above = await runRuntimeScenario([
      { kind: 'assert-image-diff', baselinePath: 'b.png', threshold: 0.01 }
    ], runtime, { sessionId: 's1', now: NOW });
    expect(above.passed).toBe(false);
    expect(above.steps[0]).toMatchObject({ passed: false, expected: 0.01, actual: 0.02 });
  });

  it('wait-node 超时返回失败', async () => {
    const { runtime } = createFakeRuntime({
      waitNode: async () => ({ found: false })
    });
    const report = await runRuntimeScenario([
      { kind: 'wait-node', path: 'Canvas/missing', timeoutMs: 10 }
    ], runtime, { sessionId: 's1', now: NOW });
    expect(report.passed).toBe(false);
    expect(report.steps[0]).toMatchObject({ kind: 'wait-node', passed: false });
  });
});
