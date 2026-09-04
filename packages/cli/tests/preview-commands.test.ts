import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/commands.js';
import { assertCliCommandSupported, toRequest } from '../src/index.js';

describe('preview 命令解析', () => {
  it('无后台服务时 CLI 只允许自包含的 runtime-scenario', () => {
    expect(() => assertCliCommandSupported(parseCommand([
      'preview-launch', '--project-id', 'p1'
    ]))).toThrow('CLI_RUNTIME_SESSION_REQUIRES_MCP');
    expect(() => assertCliCommandSupported(parseCommand([
      'runtime-scenario',
      '--project-id', 'p1',
      '--steps', '[{"kind":"launch"},{"kind":"stop","always":true}]'
    ]))).not.toThrow();
    expect(() => assertCliCommandSupported(parseCommand([
      'runtime-scenario',
      '--session-id', 's1',
      '--steps', '[{"kind":"stop","always":true}]'
    ]))).toThrow('CLI_SCENARIO_MUST_OWN_SESSION');
  });

  it('preview-launch 解析项目选择器、分辨率与浏览器通道', () => {
    const command = parseCommand([
      'preview-launch',
      '--project-id', 'proj1',
      '--editor-instance-id', 'editor-1',
      '--resolution', '720x1280',
      '--channel', 'msedge'
    ]);
    expect(command).toEqual({
      command: 'preview-launch',
      projectId: 'proj1',
      editorInstanceId: 'editor-1',
      resolution: { width: 720, height: 1280 },
      channel: 'msedge'
    });
  });

  it('preview-launch 拒绝非法分辨率格式与非法通道', () => {
    expect(() => parseCommand(['preview-launch', '--project-id', 'p', '--resolution', '720*1280'])).toThrow('INVALID_RESOLUTION');
    expect(() => parseCommand(['preview-launch', '--project-id', 'p', '--resolution', '0x720'])).toThrow('INVALID_RESOLUTION');
    expect(() => parseCommand(['preview-launch', '--project-id', 'p', '--channel', 'firefox'])).toThrow('INVALID_BROWSER_CHANNEL');
  });

  it('preview-stop 与 runtime-console 属于会话维度，不需要 project-id', () => {
    expect(parseCommand(['preview-stop', '--session-id', 's1'])).toEqual({ command: 'preview-stop', sessionId: 's1' });
    expect(parseCommand(['runtime-console', '--session-id', 's1', '--since-seq', '3', '--level', 'error']))
      .toEqual({ command: 'runtime-console', sessionId: 's1', sinceSeq: 3, level: 'error' });
  });

  it('preview-sessions 的 project-id 可选', () => {
    expect(parseCommand(['preview-sessions'])).toEqual({ command: 'preview-sessions' });
    expect(parseCommand(['preview-sessions', '--project-id', 'proj1'])).toEqual({ command: 'preview-sessions', projectId: 'proj1' });
  });

  it('runtime-console 拒绝非法游标与级别', () => {
    expect(() => parseCommand(['runtime-console', '--session-id', 's1', '--since-seq', '-1'])).toThrow('INVALID_SINCE_SEQ');
    expect(() => parseCommand(['runtime-console', '--session-id', 's1', '--level', 'verbose'])).toThrow('INVALID_CONSOLE_LEVEL');
  });

  it('runtime-hierarchy 解析会话与可选上限', () => {
    expect(parseCommand(['runtime-hierarchy', '--session-id', 's1'])).toEqual({ command: 'runtime-hierarchy', sessionId: 's1' });
    expect(parseCommand([
      'runtime-hierarchy', '--session-id', 's1', '--max-depth', '4', '--max-nodes', '500',
      '--path', 'Scene/Canvas', '--include-inactive', 'false'
    ])).toEqual({
      command: 'runtime-hierarchy',
      sessionId: 's1',
      maxDepth: 4,
      maxNodes: 500,
      path: 'Scene/Canvas',
      includeInactive: false
    });
    expect(() => parseCommand(['runtime-hierarchy', '--session-id', 's1', '--max-depth', '0'])).toThrow('INVALID_MAX_DEPTH');
    expect(() => parseCommand(['runtime-hierarchy', '--session-id', 's1', '--max-depth', '99'])).toThrow('INVALID_MAX_DEPTH');
    expect(() => parseCommand(['runtime-hierarchy', '--session-id', 's1', '--include-inactive', 'no']))
      .toThrow('INVALID_INCLUDE_INACTIVE');
  });

  it('runtime-component 解析路径与组件类型', () => {
    expect(parseCommand(['runtime-component', '--session-id', 's1', '--path', 'Canvas/btn', '--component-type', 'cc.Button']))
      .toEqual({ command: 'runtime-component', sessionId: 's1', path: 'Canvas/btn', componentType: 'cc.Button' });
    expect(() => parseCommand(['runtime-component', '--session-id', 's1', '--component-type', 'cc.Button'])).toThrow('NODE_PATH_REQUIRED');
    expect(() => parseCommand(['runtime-component', '--session-id', 's1', '--path', 'Canvas/btn'])).toThrow('COMPONENT_TYPE_REQUIRED');
  });

  it('runtime-invoke 解析方法名与 JSON 参数数组', () => {
    expect(parseCommand(['runtime-invoke', '--session-id', 's1', '--path', 'Canvas/panel', '--component-type', 'GameLogic', '--method', 'add', '--args', '[2,3]']))
      .toEqual({ command: 'runtime-invoke', sessionId: 's1', path: 'Canvas/panel', componentType: 'GameLogic', method: 'add', args: [2, 3] });
    expect(parseCommand(['runtime-invoke', '--session-id', 's1', '--path', 'p', '--component-type', 'T', '--method', 'm']))
      .toEqual({ command: 'runtime-invoke', sessionId: 's1', path: 'p', componentType: 'T', method: 'm' });
    expect(() => parseCommand(['runtime-invoke', '--session-id', 's1', '--path', 'p', '--component-type', 'T', '--method', 'm', '--args', '{"a":1}'])).toThrow('INVALID_INVOKE_ARGS');
    expect(() => parseCommand(['runtime-invoke', '--session-id', 's1', '--path', 'p', '--component-type', 'T', '--method', 'm', '--args', '[1'])).toThrow('INVALID_INVOKE_ARGS_JSON');
  });

  it('runtime-watch 解析属性与轮询参数', () => {
    expect(parseCommand(['runtime-watch', '--session-id', 's1', '--path', 'Canvas/panel', '--component-type', 'GameLogic', '--property', 'state.hp', '--timeout-ms', '5000', '--interval-ms', '100', '--max-changes', '3']))
      .toEqual({ command: 'runtime-watch', sessionId: 's1', path: 'Canvas/panel', componentType: 'GameLogic', property: 'state.hp', timeoutMs: 5000, intervalMs: 100, maxChanges: 3 });
    expect(() => parseCommand(['runtime-watch', '--session-id', 's1', '--path', 'p', '--component-type', 'T'])).toThrow('PROPERTY_REQUIRED');
    expect(() => parseCommand(['runtime-watch', '--session-id', 's1', '--path', 'p', '--component-type', 'T', '--property', 'x', '--timeout-ms', '60000'])).toThrow('INVALID_TIMEOUT_MS');
  });

  it('runtime-input 解析输入类型、坐标与按键', () => {
    expect(parseCommand(['runtime-input', '--session-id', 's1', '--input-type', 'tap', '--x', '480', '--y', '320.5']))
      .toEqual({ command: 'runtime-input', sessionId: 's1', inputType: 'tap', x: 480, y: 320.5 });
    expect(parseCommand(['runtime-input', '--session-id', 's1', '--input-type', 'key', '--key', 'Escape']))
      .toEqual({ command: 'runtime-input', sessionId: 's1', inputType: 'key', key: 'Escape' });
    expect(() => parseCommand(['runtime-input', '--session-id', 's1', '--input-type', 'hover'])).toThrow('INVALID_INPUT_TYPE');
    expect(() => parseCommand(['runtime-input', '--session-id', 's1', '--input-type', 'tap', '--x', '-1'])).toThrow('INVALID_COORDINATE');
    expect(() => parseCommand(['runtime-input', '--session-id', 's1'])).toThrow('INPUT_TYPE_REQUIRED');
  });

  it('runtime-instantiate 解析资产与父路径，坐标允许负数', () => {
    expect(parseCommand(['runtime-instantiate', '--session-id', 's1', '--asset-uuid', 'abc-123', '--parent-path', 'root/gui/LayerUI', '--x', '-50', '--y', '120']))
      .toEqual({ command: 'runtime-instantiate', sessionId: 's1', assetUuid: 'abc-123', parentPath: 'root/gui/LayerUI', x: -50, y: 120 });
    expect(() => parseCommand(['runtime-instantiate', '--session-id', 's1', '--parent-path', 'p'])).toThrow('ASSET_UUID_REQUIRED');
    expect(() => parseCommand(['runtime-instantiate', '--session-id', 's1', '--asset-uuid', 'a'])).toThrow('PARENT_PATH_REQUIRED');
  });

  it('runtime-capture 解析分辨率、裁剪与叠加', () => {
    expect(parseCommand(['runtime-capture', '--session-id', 's1'])).toEqual({ command: 'runtime-capture', sessionId: 's1' });
    expect(parseCommand([
      'runtime-capture', '--session-id', 's1',
      '--resolution', '720x1280',
      '--crop', '0,10,200,300',
      '--overlay-nodes', 'Canvas/a,Canvas/b',
      '--overlay-anchors', 'true'
    ])).toEqual({
      command: 'runtime-capture',
      sessionId: 's1',
      resolution: { width: 720, height: 1280 },
      crop: { x: 0, y: 10, width: 200, height: 300 },
      overlayNodeBounds: ['Canvas/a', 'Canvas/b'],
      overlayAnchors: true
    });
    expect(parseCommand(['runtime-capture', '--session-id', 's1', '--resolutions', '[{"width":720,"height":1280},{"width":1280,"height":720}]']))
      .toMatchObject({ resolutions: [{ width: 720, height: 1280 }, { width: 1280, height: 720 }] });
    expect(() => parseCommand(['runtime-capture', '--session-id', 's1', '--resolution', '720x1280', '--resolutions', '[{"width":1,"height":1}]'])).toThrow('CAPTURE_RESOLUTION_CONFLICT');
    expect(() => parseCommand(['runtime-capture', '--session-id', 's1', '--crop', '1,2,3'])).toThrow('INVALID_CROP');
    expect(() => parseCommand(['runtime-capture', '--session-id', 's1', '--resolutions', '[]'])).toThrow('INVALID_RESOLUTIONS');
    expect(() => parseCommand(['runtime-capture', '--session-id', 's1', '--overlay-nodes', ''])).toThrow('INVALID_OVERLAY');
  });

  it('runtime-scenario 解析目标与步骤 JSON', () => {
    const steps = JSON.stringify([
      { kind: 'launch' },
      { kind: 'instantiate-prefab', assetUuid: 'asset-1', parentPath: 'Canvas/LayerUI' },
      { kind: 'assert-property', path: 'Canvas/btn', property: 'cc.Button.interactable', expected: true },
      { kind: 'stop', always: true }
    ]);
    expect(parseCommand(['runtime-scenario', '--session-id', 's1', '--steps', steps]))
      .toMatchObject({
        command: 'runtime-scenario',
        sessionId: 's1',
        steps: [{ kind: 'launch' }, { kind: 'instantiate-prefab' }, { kind: 'assert-property' }, { kind: 'stop', always: true }]
      });
    expect(parseCommand(['runtime-scenario', '--project-id', 'p1', '--editor-instance-id', 'e1', '--steps', steps]))
      .toMatchObject({ projectId: 'p1', editorInstanceId: 'e1' });
    expect(() => parseCommand(['runtime-scenario', '--steps', steps])).toThrow('SCENARIO_TARGET_REQUIRED');
    expect(() => parseCommand(['runtime-scenario', '--session-id', 's1', '--steps', '{"kind":"launch"}'])).toThrow('INVALID_SCENARIO_STEPS');
    expect(() => parseCommand(['runtime-scenario', '--session-id', 's1', '--steps', '[1'])).toThrow('INVALID_SCENARIO_STEPS_JSON');
    expect(() => parseCommand(['runtime-scenario', '--session-id', 's1', '--steps', '[{"kind":"teleport"}]'])).toThrow('INVALID_SCENARIO_STEPS');
  });
});

describe('preview 命令请求映射', () => {
  it('preview-launch 映射 server.previewLaunch', () => {
    expect(toRequest({
      command: 'preview-launch',
      projectId: 'proj1',
      editorInstanceId: 'editor-1',
      resolution: { width: 720, height: 1280 }
    })).toEqual(['server.previewLaunch', {
      selector: { projectId: 'proj1', editorInstanceId: 'editor-1' },
      params: { resolution: { width: 720, height: 1280 } }
    }]);
  });

  it('preview-stop / preview-sessions / runtime-console 映射对应 server 方法', () => {
    expect(toRequest({ command: 'preview-stop', sessionId: 's1' }))
      .toEqual(['server.previewStop', { sessionId: 's1' }]);
    expect(toRequest({ command: 'preview-sessions', projectId: 'proj1' }))
      .toEqual(['server.previewSessions', { projectId: 'proj1' }]);
    expect(toRequest({ command: 'preview-sessions' }))
      .toEqual(['server.previewSessions', {}]);
    expect(toRequest({ command: 'runtime-console', sessionId: 's1', sinceSeq: 5, level: 'error' }))
      .toEqual(['server.runtimeConsole', { sessionId: 's1', sinceSeq: 5, level: 'error' }]);
  });

  it('runtime-hierarchy / runtime-component 映射对应 server 方法', () => {
    expect(toRequest({
      command: 'runtime-hierarchy',
      sessionId: 's1',
      maxDepth: 4,
      maxNodes: 500,
      path: 'Scene/Canvas',
      includeInactive: false
    })).toEqual(['server.runtimeHierarchy', {
      sessionId: 's1',
      maxDepth: 4,
      maxNodes: 500,
      path: 'Scene/Canvas',
      includeInactive: false
    }]);
    expect(toRequest({ command: 'runtime-hierarchy', sessionId: 's1' }))
      .toEqual(['server.runtimeHierarchy', { sessionId: 's1' }]);
    expect(toRequest({ command: 'runtime-component', sessionId: 's1', path: 'Canvas/btn', componentType: 'cc.Button' }))
      .toEqual(['server.runtimeComponent', { sessionId: 's1', path: 'Canvas/btn', componentType: 'cc.Button' }]);
  });

  it('runtime-invoke / runtime-watch 映射对应 server 方法', () => {
    expect(toRequest({ command: 'runtime-invoke', sessionId: 's1', path: 'p', componentType: 'T', method: 'add', args: [1, 2] }))
      .toEqual(['server.runtimeInvoke', { sessionId: 's1', path: 'p', componentType: 'T', method: 'add', args: [1, 2] }]);
    expect(toRequest({ command: 'runtime-invoke', sessionId: 's1', path: 'p', componentType: 'T', method: 'm' }))
      .toEqual(['server.runtimeInvoke', { sessionId: 's1', path: 'p', componentType: 'T', method: 'm' }]);
    expect(toRequest({ command: 'runtime-watch', sessionId: 's1', path: 'p', componentType: 'T', property: 'a.b', timeoutMs: 5000 }))
      .toEqual(['server.runtimeWatch', { sessionId: 's1', path: 'p', componentType: 'T', property: 'a.b', timeoutMs: 5000 }]);
  });

  it('runtime-input 映射 server.runtimeDispatchInput', () => {
    expect(toRequest({ command: 'runtime-input', sessionId: 's1', inputType: 'tap', x: 480, y: 320 }))
      .toEqual(['server.runtimeDispatchInput', { sessionId: 's1', inputType: 'tap', x: 480, y: 320 }]);
    expect(toRequest({ command: 'runtime-input', sessionId: 's1', inputType: 'key', key: 'Enter' }))
      .toEqual(['server.runtimeDispatchInput', { sessionId: 's1', inputType: 'key', key: 'Enter' }]);
  });

  it('runtime-instantiate 映射 server.runtimeInstantiate', () => {
    expect(toRequest({ command: 'runtime-instantiate', sessionId: 's1', assetUuid: 'abc', parentPath: 'root/gui', x: 0, y: -10 }))
      .toEqual(['server.runtimeInstantiate', { sessionId: 's1', assetUuid: 'abc', parentPath: 'root/gui', x: 0, y: -10 }]);
  });

  it('runtime-capture 映射 server.runtimeCapture', () => {
    expect(toRequest({ command: 'runtime-capture', sessionId: 's1' }))
      .toEqual(['server.runtimeCapture', { sessionId: 's1' }]);
    expect(toRequest({
      command: 'runtime-capture',
      sessionId: 's1',
      resolution: { width: 720, height: 1280 },
      crop: { x: 0, y: 0, width: 100, height: 100 },
      overlayNodeBounds: ['Canvas/a'],
      overlayAnchors: true
    })).toEqual(['server.runtimeCapture', {
      sessionId: 's1',
      resolution: { width: 720, height: 1280 },
      crop: { x: 0, y: 0, width: 100, height: 100 },
      overlay: { nodeBounds: ['Canvas/a'], anchors: true }
    }]);
  });

  it('runtime-scenario 映射 server.runtimeRunScenario', () => {
    expect(toRequest({
      command: 'runtime-scenario',
      sessionId: 's1',
      steps: [{ kind: 'launch' }]
    })).toEqual(['server.runtimeRunScenario', { sessionId: 's1', steps: [{ kind: 'launch' }] }]);
    expect(toRequest({
      command: 'runtime-scenario',
      projectId: 'p1',
      editorInstanceId: 'e1',
      steps: [{ kind: 'launch' }]
    })).toEqual(['server.runtimeRunScenario', {
      selector: { projectId: 'p1', editorInstanceId: 'e1' },
      steps: [{ kind: 'launch' }]
    }]);
  });
});
