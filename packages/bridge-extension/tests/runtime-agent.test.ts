import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../static/runtime-agent.js', import.meta.url), 'utf8');

/** 运行实际代理脚本，保留原生 console 与 Cocos 缓存日志函数的调用边界。 */
async function startAgent() {
  const original = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map((level) => [level, vi.fn()]));
  const runtimeConsole = { ...original };
  const editBoxMethods = { hide: vi.fn(), show: vi.fn() };
  const cc: Record<string, any> = {
    settings: { querySettings: () => ({ baseUrl: 'http://127.0.0.1/runtime' }) },
    EditBox: { prototype: { _hideLabels: editBoxMethods.hide, _showLabels: editBoxMethods.show } },
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
  return { context, original, cc, editBoxMethods, agent: (context as any).__cocosAiSimulatorRuntimeAgent };
}

describe('Simulator 运行代理日志', () => {
  it('捕获原生输入框时保留 Cocos 文本标签，并在停止后恢复', async () => {
    const { agent, cc, editBoxMethods } = await startAgent();
    expect(cc.EditBox.prototype._hideLabels).toBe(editBoxMethods.show);
    agent.stop();
    expect(cc.EditBox.prototype._hideLabels).toBe(editBoxMethods.hide);
  });

  it('命令长轮询成功后立即续订，只在连接失败时退避', async () => {
    const { context } = await startAgent();
    expect(context.setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 0);
  });

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

  it('写入工作台前脱敏认证和登录凭据，但不修改游戏原始日志', async () => {
    const { context, original, agent } = await startAgent();
    const payload = {
      headers: { authorization: 'Bearer header-secret' },
      credentials: { account: 'demo', password: 'password-secret' },
      accessToken: 'access-secret',
      mergedConfig: JSON.stringify({ authorization: 'Bearer nested-secret', password: 'nested-password' })
    };
    const query = 'https://example.test/login?token=query-secret&safe=1';
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature-secret';
    context.console.log('请求', payload, query, jwt);
    const text = agent.readConsole(0).entries.at(-1).text;
    for (const secret of ['header-secret', 'password-secret', 'access-secret', 'nested-secret', 'nested-password', 'query-secret', jwt]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('[REDACTED]');
    expect(text).toContain('safe=1');
    expect(original.log).toHaveBeenCalledWith('请求', payload, query, jwt);
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
    Object.defineProperty(value, 'computed', { enumerable: true, get: getter });
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
