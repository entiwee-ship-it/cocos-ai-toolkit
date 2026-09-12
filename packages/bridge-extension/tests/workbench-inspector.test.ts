import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const source = ts.createSourceFile('app.js', readFileSync(new URL('../static/workbench/app.js', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const functions = new Map<string, string>();
function collect(node: ts.Node): void {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(source));
  ts.forEachChild(node, collect);
}
collect(source);

/** 执行浏览器源码中的实际数据选择逻辑，不引入模拟 DOM 框架。 */
function inspector(state: object) {
  const names = ['componentKey', 'pendingKey', 'effectiveValue', 'widgetPropertyNames', 'propertyMetaFor', 'visiblePropertyNames'];
  return runInNewContext(`(function(){${names.map((name) => functions.get(name)).join('\n')}return { visiblePropertyNames };})()`, { state });
}

describe('Workbench 原生字段呈现', () => {
  it('显隐和稳定排序完全采用原生描述，合法 editor 字段与空引用不被误删', () => {
    const component = { componentType: 'cc.Example', properties: { editorValue: 1, target: null, renderCache: 2, later: 3 }, propertyMeta: {
      editorValue: { visible: true, displayOrder: 0 }, target: { visible: true, displayOrder: 0 },
      renderCache: { visible: false, displayOrder: -1 }, later: { visible: true, displayOrder: 2 }
    } };
    expect(inspector({ components: [component] }).visiblePropertyNames(component)).toEqual(['editorValue', 'target', 'later']);
  });

  it('Widget 仅呈现原生边距代理，方向草稿切换后不重复显示原始比例值', () => {
    const properties = { target: null, alignMode: 0, isAlignTop: true, isAlignBottom: false, editorTop: 10, top: 0.1, isAbsoluteTop: false, editorBottom: 20, bottom: 0.2, isAbsoluteBottom: false, alignFlags: 1 };
    const component = { componentType: 'cc.Widget', properties, propertyMeta: Object.fromEntries(Object.keys(properties).map((key) => [key, { visible: true }])) };
    const state = { components: [component], pending: new Map() };
    const api = inspector(state);
    expect(api.visiblePropertyNames(component)).toEqual(['target', 'alignMode', 'isAlignTop', 'isAlignBottom', 'editorTop', 'isAbsoluteTop']);
    state.pending.set('cc.Widget:0::isAlignTop', { value: false });
    state.pending.set('cc.Widget:0::isAlignBottom', { value: true });
    expect(api.visiblePropertyNames(component)).toEqual(['target', 'alignMode', 'isAlignTop', 'isAlignBottom', 'editorBottom', 'isAbsoluteBottom']);
  });
});
