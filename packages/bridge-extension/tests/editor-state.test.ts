import { describe, expect, it } from 'vitest';
import { buildBridgeHello } from '../src/editor-state.js';

describe('buildBridgeHello', () => {
  it('保留项目路径和 Creator 精确版本', () => {
    const hello = buildBridgeHello({
      processId: 123,
      projectPath: 'E:/project',
      projectId: 'project-uuid',
      creatorVersion: '3.8.8',
      bridgeVersion: '0.1.0'
    });

    expect(hello.method).toBe('bridge.hello');
    expect(hello.payload.editorInstanceId).toBe('project-uuid:123');
    expect(hello.payload.projectPath).toBe('E:/project');
    expect(hello.payload.creatorVersion).toBe('3.8.8');
  });
});
