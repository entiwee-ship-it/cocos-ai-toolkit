import { describe, expect, it, vi } from 'vitest';
import { readRuntimeInspector } from '../src/runtime-inspector';

describe('Creator 原生运行时 Inspector', () => {
  it('嵌套数组的只读展开保留截断后的真实总数', () => {
    class Owner { static __props__ = ['settings']; }
    class Settings {}
    const classes: Record<string, any> = { Owner, Settings };
    const result = readRuntimeInspector({ componentType: 'Owner', values: { settings: {
      __type: 'inspector-object', className: 'Settings', properties: { items: ['a', { __type: 'truncated', total: 60 }] }
    } }, writable: {} }, { js: { getClassByName: (name: string) => classes[name] } }, {
      encodeComponent: () => ({ type: 'Owner', value: { settings: { type: 'Settings', visible: true, value: {
        items: { type: 'String', visible: true, isArray: true, value: [{ type: 'String', visible: true, value: 'a' }] }
      } } } })
    }, (key) => key);
    expect(result.propertyMeta.settings.details.value.items).toMatchObject({ isArray: true, total: 60, value: [{ value: 'a' }] });
  });

  it('只用原生字段、保留类型和动态 attrs，并且不执行用户构造器或 setter', () => {
    class Color {}
    class Node {}
    class SpriteFrame {}
    class Sprite {
      static __props__ = ['_type', 'type', 'color', 'customMaterial', 'spriteFrame', 'fillType', 'fillCenter', 'renderEvents'];
      constructor() { throw new Error('不允许构造用户组件'); }
      set type(_value: number) { throw new Error('不允许执行编辑态 setter'); }
    }
    const classes: Record<string, any> = { 'cc.Sprite': Sprite, 'cc.Color': Color, 'cc.Node': Node, 'cc.SpriteFrame': SpriteFrame };
    const cc = { Node, js: { getClassByName: (name: string) => classes[name], getClassName: (ctor: any) => Object.keys(classes).find((name) => classes[name] === ctor) } };
    const encodeComponent = vi.fn((component: any) => {
      expect(component).toBeInstanceOf(Sprite);
      expect(component.color).toBeInstanceOf(Color);
      expect(component.spriteFrame).toBeInstanceOf(SpriteFrame);
      expect(component.spriteFrame._uuid).toBe('frame');
      expect(component.renderCache).toBeUndefined();
      expect(component._type).toBe(3);
      // 字段结构来自 Creator 3.8.8 的 Sprite Dump；实际编码器由 Creator 运行验证覆盖。
      return { type: 'cc.Sprite', extends: ['cc.UIRenderer', 'cc.Component'], editor: { _showTick: true }, value: {
        enabled: { type: 'Boolean', value: true, visible: false },
        customMaterial: { type: 'cc.Material', extends: ['cc.Asset'], value: { uuid: '' }, visible: true, displayOrder: 0 },
        color: { type: 'cc.Color', value: { r: 1, g: 2, b: 3, a: 255 }, visible: true, displayOrder: 1, displayName: 'i18n:color' },
        type: { type: 'Enum', value: component.type, enumList: [{ name: 'FILLED', value: 3 }], visible: true, displayOrder: 6 },
        fillType: { type: 'Enum', value: 0, visible: true },
        fillCenter: { type: 'cc.Vec2', value: { x: 0, y: 0 }, visible: true },
        renderEvents: { type: 'cc.Node', extends: ['cc.Object'], isArray: true, visible: true, value: [
          { type: 'cc.Node', value: { uuid: 'target' }, visible: true }
        ] },
        _type: { type: 'Number', value: component._type, visible: false }
      } };
    });
    const schema = readRuntimeInspector({ componentType: 'Sprite' }, cc, { encodeComponent }, (key) => key);
    expect(schema.propertyNames).not.toContain('renderCache');
    expect(encodeComponent).not.toHaveBeenCalled();
    const result = readRuntimeInspector({ componentType: 'Sprite', values: {
      type: 3, _type: 3, renderCache: 999,
      color: { __type: 'inspector-object', className: 'cc.Color', properties: { r: 1, g: 2, b: 3, a: 255 } },
      spriteFrame: { __type: 'asset-reference', className: 'cc.SpriteFrame', uuid: 'frame' }
    }, writable: { enabled: true, type: true, color: true, customMaterial: true, fillCenter: true, renderEvents: true } }, cc, { encodeComponent }, (key) => key === 'color' ? '颜色' : key);
    expect(result.propertyMeta.color).toMatchObject({ displayName: '颜色', editable: true, displayOrder: 1 });
    expect(result.propertyMeta.customMaterial).toMatchObject({ kind: 'reference', visible: true, editable: false });
    expect(result.propertyMeta.fillCenter).toMatchObject({ visible: true, editable: false });
    expect(result.propertyMeta.type.enumOptions).toEqual([{ name: 'FILLED', value: 3 }]);
    expect(result.propertyMeta.renderEvents.details).toMatchObject({ isArray: true, kind: 'array', value: [{ kind: 'reference', value: { uuid: 'target' } }] });
    expect(result.properties).not.toHaveProperty('_type');
    expect(result).toMatchObject({ inspectorSource: 'creator', showEnabled: true });
  });

  it('同名 visible 属性遵从原生结果，Button 过渡字段按原生面板条件显示', () => {
    class Button { static __props__ = ['transition']; }
    const cc = { js: { getClassByName: () => Button, getClassName: () => 'cc.Button' } };
    const result = readRuntimeInspector({ componentType: 'cc.Button', values: { transition: 0 }, writable: {} }, cc, {
      encodeComponent: () => ({ type: 'cc.Button', value: {
        transition: { type: 'Enum', value: 0, visible: true },
        normalColor: { type: 'cc.Color', value: {}, visible: true },
        duration: { type: 'Number', value: 0.1, visible: true },
        editorTitle: { type: 'String', value: '原生明确展示', visible: true, readonly: true },
        clickEvents: { type: 'cc.ClickEvent', value: [], isArray: true, visible: true }
      } })
    }, (key) => key);
    expect(Object.keys(result.properties)).toEqual(['transition', 'editorTitle', 'clickEvents']);
    expect(result.propertyMeta.editorTitle.visible).toBe(true);
  });
});
