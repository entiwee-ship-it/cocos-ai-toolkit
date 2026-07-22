import { describe, expect, it } from 'vitest';
import {
  ConsoleEntrySchema,
  PreviewSessionSchema,
  ResolutionSchema,
  RuntimeCaptureOptionsSchema,
  RuntimeCaptureResultSchema,
  RuntimeComponentSnapshotSchema,
  RuntimeNodeSnapshotSchema,
  ScenarioReportSchema,
  ScenarioStepSchema
} from '../src/runtime.js';

describe('运行态协议（阶段五）', () => {
  it('接受带数据来源与动态节点标注的运行时节点快照', () => {
    expect(RuntimeNodeSnapshotSchema.parse({
      source: 'preview-runtime',
      previewSessionId: 'p1',
      capturedAt: '2026-07-22T04:40:00.000Z',
      root: {
        uuid: 'u1',
        name: 'Canvas',
        active: true,
        dynamic: false,
        components: [{ type: 'cc.Canvas' }, { type: 'cc.UITransform', properties: { contentSize: { width: 1280, height: 720 } } }],
        children: [
          { uuid: 'u2', name: 'toast', active: true, dynamic: true, components: [], children: [] }
        ]
      }
    })).toBeTruthy();
  });

  it('拒绝错误的快照来源标记', () => {
    expect(() => RuntimeNodeSnapshotSchema.parse({
      source: 'editor-document',
      previewSessionId: 'p1',
      capturedAt: '2026-07-22T04:40:00.000Z',
      root: { uuid: 'u1', name: 'Canvas', active: true, dynamic: false, components: [], children: [] }
    })).toThrow();
  });

  it('Preview 会话限定自 launch 页面并回传实际生效分辨率', () => {
    expect(PreviewSessionSchema.parse({
      sessionId: 'p1',
      projectId: 'proj1',
      url: 'http://127.0.0.1:7457/',
      pageSource: 'self-launched',
      state: 'ready',
      requestedResolution: { width: 720, height: 1280 },
      actualResolution: { width: 720, height: 826 },
      launchedAt: '2026-07-22T04:40:00.000Z'
    })).toBeTruthy();

    expect(() => PreviewSessionSchema.parse({
      sessionId: 'p1',
      projectId: 'proj1',
      url: 'http://127.0.0.1:7457/',
      pageSource: 'editor-opened',
      state: 'ready',
      launchedAt: '2026-07-22T04:40:00.000Z'
    })).toThrow();
  });

  it('截图选项支持指定分辨率、多分辨率、裁剪与叠加开关', () => {
    expect(RuntimeCaptureOptionsSchema.parse({
      view: 'game',
      resolution: { width: 720, height: 1280 },
      crop: { x: 0, y: 0, width: 100, height: 100 },
      overlay: { nodeBounds: true, anchors: true },
      format: 'png'
    })).toBeTruthy();

    expect(RuntimeCaptureOptionsSchema.parse({
      view: 'game',
      resolutions: [{ width: 720, height: 1280 }, { width: 1280, height: 720 }]
    })).toBeTruthy();
  });

  it('截图选项拒绝单张与多分辨率同时给出', () => {
    expect(() => RuntimeCaptureOptionsSchema.parse({
      view: 'game',
      resolution: { width: 720, height: 1280 },
      resolutions: [{ width: 1280, height: 720 }]
    })).toThrow();
  });

  it('截图产物记录实际像素尺寸与实际生效分辨率', () => {
    expect(RuntimeCaptureResultSchema.parse({
      files: [{
        path: 'reports/capture-1.png',
        width: 720,
        height: 826,
        requestedResolution: { width: 720, height: 1280 },
        actualResolution: { width: 720, height: 826 },
        cropped: false,
        overlays: { nodeBounds: true, anchors: false }
      }],
      capturedAt: '2026-07-22T04:40:00.000Z'
    })).toBeTruthy();
  });

  it('Console 条目要求非负单调游标', () => {
    expect(ConsoleEntrySchema.parse({ seq: 0, level: 'error', text: 'boom', stack: 'at x', timestamp: '2026-07-22T04:40:00.000Z' })).toBeTruthy();
    expect(() => ConsoleEntrySchema.parse({ seq: -1, level: 'log', text: 'x', timestamp: '2026-07-22T04:40:00.000Z' })).toThrow();
  });

  it('运行时组件快照携带属性包', () => {
    expect(RuntimeComponentSnapshotSchema.parse({
      source: 'preview-runtime',
      previewSessionId: 'p1',
      nodeUuid: 'u1',
      componentType: 'cc.Label',
      properties: { string: '确定退出？', fontSize: 28 },
      capturedAt: '2026-07-22T04:40:00.000Z'
    })).toBeTruthy();
  });

  it('场景步骤覆盖启动、等待、断言、输入、Console 与截图', () => {
    const steps = [
      { kind: 'launch', resolution: { width: 720, height: 1280 } },
      { kind: 'wait-node', path: 'Canvas/btn', timeoutMs: 5000 },
      { kind: 'assert-property', path: 'Canvas/btn', property: 'active', expected: true },
      { kind: 'dispatch-input', inputType: 'tap', x: 100, y: 200 },
      { kind: 'assert-console', pattern: '登录成功', level: 'log', timeoutMs: 3000 },
      { kind: 'capture', overlay: { nodeBounds: true } },
      { kind: 'assert-image-diff', baselinePath: 'baselines/home.png', threshold: 0.01 }
    ];
    for (const step of steps) {
      expect(ScenarioStepSchema.parse(step), `步骤 ${step.kind} 应通过校验`).toBeTruthy();
    }
  });

  it('场景步骤拒绝未知种类与越界阈值', () => {
    expect(() => ScenarioStepSchema.parse({ kind: 'teleport' })).toThrow();
    expect(() => ScenarioStepSchema.parse({ kind: 'assert-image-diff', baselinePath: 'a.png', threshold: 1.5 })).toThrow();
  });

  it('场景报告步骤的 expected/actual 可省略（Zod 4 显式 optional 语义）', () => {
    expect(ScenarioReportSchema.parse({
      steps: [
        { index: 0, kind: 'launch', passed: true },
        { index: 1, kind: 'assert-property', passed: false, expected: true, actual: false, error: '属性不符' }
      ],
      passed: false,
      startedAt: '2026-07-22T04:40:00.000Z',
      finishedAt: '2026-07-22T04:41:00.000Z'
    })).toBeTruthy();
  });

  it('分辨率拒绝非正整数', () => {
    expect(() => ResolutionSchema.parse({ width: 0, height: 720 })).toThrow();
    expect(() => ResolutionSchema.parse({ width: 720.5, height: 1280 })).toThrow();
  });
});
