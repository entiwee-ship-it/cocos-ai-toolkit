import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/commands.js';
import { toRequest } from '../src/index.js';

describe('preview 命令解析（阶段五）', () => {
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
    expect(parseCommand(['runtime-hierarchy', '--session-id', 's1', '--max-depth', '4', '--max-nodes', '500']))
      .toEqual({ command: 'runtime-hierarchy', sessionId: 's1', maxDepth: 4, maxNodes: 500 });
    expect(() => parseCommand(['runtime-hierarchy', '--session-id', 's1', '--max-depth', '0'])).toThrow('INVALID_MAX_DEPTH');
    expect(() => parseCommand(['runtime-hierarchy', '--session-id', 's1', '--max-depth', '99'])).toThrow('INVALID_MAX_DEPTH');
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
    expect(toRequest({ command: 'runtime-hierarchy', sessionId: 's1', maxDepth: 4, maxNodes: 500 }))
      .toEqual(['server.runtimeHierarchy', { sessionId: 's1', maxDepth: 4, maxNodes: 500 }]);
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
});
