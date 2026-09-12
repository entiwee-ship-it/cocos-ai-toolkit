import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../static/runtime-agent.js', import.meta.url), 'utf8');

/** 运行实际代理脚本，保留原生 console 与 Cocos 缓存日志函数的调用边界。 */
async function startAgent() {
  const original = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map((level) => [level, vi.fn()]));
  const runtimeConsole = { ...original };
  const cc: Record<string, any> = {
    settings: { querySettings: () => ({ baseUrl: 'http://127.0.0.1/runtime' }) },
    DebugMode: { INFO: 1 },
    _resetDebugSetting: vi.fn(() => {
      cc.log = runtimeConsole.log;
      cc.warn = runtimeConsole.warn;
      cc.error = runtimeConsole.error;
    })
  };
  const context = {
    console: runtimeConsole, System: { import: async () => cc }, Error,
    setTimeout: vi.fn(),
    XMLHttpRequest: class {
      status = 204;
      onload?: () => void;
      open() {}
      setRequestHeader() {}
      send() { this.onload?.(); }
    }
  };
  runInNewContext(source, context);
  await new Promise(setImmediate);
  return { context, original, cc, agent: (context as any).__cocosAiSimulatorRuntimeAgent };
}

describe('Simulator 运行代理日志', () => {
  it('JSB 异步异常正文与源码堆栈分开展示，源码占位符不被再次格式化', async () => {
    const { context, original, agent } = await startAgent();
    const location = 'file.js:10\nconsole.log("%c%s", style, text);\n^';
    const stack = 'Error: 异步异常\n    at action (file.js:10:3)';
    context.console.error(location, 'Error: 异步异常', stack);
    const entry = agent.readConsole(0).entries.at(-1);
    expect(entry.text).toBe('Error: 异步异常');
    expect(entry.stack).toBe(location + '\n' + stack);
    expect(original.error).toHaveBeenCalledWith(location, 'Error: 异步异常', stack);
  });

  it('按 console 占位符显示文字和对象，CSS 样式参数不混入日志正文', async () => {
    const { context, agent } = await startAgent();
    context.console.log('%c%s %o count=%d', 'color:orange', '[网络日志]', { ready: true }, 2);
    expect(agent.readConsole(0).entries.at(-1).text).toBe('[网络日志] {"ready":true} count=2');
  });

  it('采集原生和 Cocos 日志，保留真实时间、异常堆栈并仍调用原有输出', async () => {
    const { context, original, cc, agent } = await startAgent();
    expect(typeof agent.readConsole).toBe('function');
    const start = agent.readConsole(0).nextSeq;
    context.console.log('启动', { count: 2 });
    cc.warn('Cocos 警告');
    const error = new Error('运行异常');
    context.console.error(error);
    const result = agent.readConsole(start);
    expect(result.entries.map((entry: any) => entry.level)).toEqual(['log', 'warn', 'error']);
    expect(result.entries[0].text).toContain('"count":2');
    expect(result.entries[1].text).toBe('Cocos 警告');
    expect(result.entries[2].stack).toContain('运行异常');
    expect(result.entries[2].text).toBe('Error: 运行异常');
    expect(Number.isNaN(Date.parse(result.entries[0].timestamp))).toBe(false);
    expect(original.log).toHaveBeenCalledWith('启动', { count: 2 });
    expect(original.warn).toHaveBeenCalledOnce();
    expect(original.error).toHaveBeenCalledWith(error);
    expect(cc._resetDebugSetting).toHaveBeenCalledWith(cc.DebugMode.INFO);
    expect(agent.readConsole(result.nextSeq).entries).toHaveLength(0);
  });

  it('日志是有界快照，不执行对象 getter；停止后恢复输出方法', async () => {
    const { context, original, agent } = await startAgent();
    expect(typeof agent.readConsole).toBe('function');
    const getter = vi.fn(() => { throw new Error('不应执行'); });
    const value: Record<string, unknown> = { count: 1 };
    Object.defineProperty(value, 'secret', { enumerable: true, get: getter });
    value.self = value;
    context.console.log(value);
    value.count = 2;
    const snapshot = agent.readConsole(0).entries.at(-1).text;
    expect(snapshot).toContain('"count":1');
    expect(snapshot).toContain('[Circular]');
    expect(snapshot).toContain('[Getter]');
    expect(getter).not.toHaveBeenCalled();
    for (let index = 0; index < 550; index += 1) context.console.debug('条目', index);
    let cursor = 0;
    const entries = [];
    while (true) {
      const page = agent.readConsole(cursor);
      if (!page.entries.length) break;
      expect(page.entries.length).toBeLessThanOrEqual(100);
      entries.push(...page.entries);
      cursor = page.nextSeq;
    }
    expect(entries).toHaveLength(500);
    agent.stop();
    expect(context.console.log).toBe(original.log);
    context.console.log('正常输出仍可用');
    expect(agent.readConsole(cursor).entries).toHaveLength(0);
  });
});
