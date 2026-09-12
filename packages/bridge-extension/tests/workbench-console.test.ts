import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = ts.createSourceFile('app.js', readFileSync(new URL('../static/workbench/app.js', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const declarations = new Map<string, string>();
function collect(node: ts.Node): void {
  if (ts.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, node.getText(source));
  ts.forEachChild(node, collect);
}
collect(source);

/** 使用页面中的实际游标与会话逻辑，保留清空/切换与请求完成之间的竞态。 */
function consoleApi(state: Record<string, any>, api = vi.fn()) {
  const names = ['refreshConsole', 'resetConsole', 'clearConsole', 'consoleMatches'];
  return runInNewContext(`(function(){${names.map((name) => declarations.get(name)).join('\n')}return {refreshConsole,resetConsole,clearConsole,consoleMatches};})()`, {
    state, api, renderConsole: vi.fn(), renderConsoleMeta: vi.fn(), showToast: vi.fn()
  });
}

function createState() {
  return { host: { status: 'ready', session: { sessionId: 'first' } }, consoleSessionId: 'first', consoleSeq: 0,
    consoleGeneration: 0, consoleEntries: [], consoleBusy: false, consoleFollow: true };
}

describe('Workbench 控制台交互', () => {
  it('清空时丢弃在途旧日志，但推进游标避免下一次重复出现', async () => {
    const state = createState();
    let finish!: (value: unknown) => void;
    const api = consoleApi(state, vi.fn(() => new Promise((resolve) => { finish = resolve; })));
    const pending = api.refreshConsole();
    api.clearConsole();
    finish({ entries: [{ seq: 0, level: 'log', text: '已清空的旧日志' }], nextSeq: 1 });
    await pending;
    expect(state.consoleEntries).toHaveLength(0);
    expect(state.consoleSeq).toBe(1);
  });

  it('停止后保留可查记录，新会话拒收上一会话的迟到响应', async () => {
    const state = createState();
    let finish!: (value: unknown) => void;
    const api = consoleApi(state, vi.fn(() => new Promise((resolve) => { finish = resolve; })));
    state.consoleEntries.push({ seq: 0, level: 'error', text: '需要检查的异常' } as never);
    api.resetConsole('');
    expect(state.consoleEntries).toHaveLength(1);
    api.resetConsole('first');
    const pending = api.refreshConsole();
    api.resetConsole('second');
    finish({ entries: [{ seq: 10, level: 'log', text: '旧会话' }], nextSeq: 11 });
    await pending;
    expect(state.consoleEntries).toHaveLength(0);
    expect(state.consoleSeq).toBe(0);
  });

  it('级别筛选与文本/堆栈搜索组合生效', () => {
    const api = consoleApi(createState());
    expect(api.consoleMatches({ level: 'log', text: '已连接' }, 'info', '')).toBe(true);
    expect(api.consoleMatches({ level: 'warn', text: '已连接' }, 'error', '')).toBe(false);
    expect(api.consoleMatches({ level: 'error', text: '异常', stack: 'LoginView.ts:12' }, 'error', 'loginview')).toBe(true);
    expect(api.consoleMatches({ level: 'info', text: '启动' }, 'all', '不存在')).toBe(false);
  });
});
