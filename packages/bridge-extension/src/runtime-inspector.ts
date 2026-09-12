import { readDumpValueDeep } from './raw-reflection';
import { ProbeError } from './probe-errors';

type Data = Record<string, any>;

/** Creator 3.8.8 encodeNode 使用的运行时字段；编辑器锁定和 Prefab 操作不属于运行态。 */
const NODE_PROPERTIES = ['active', 'name', 'position', 'eulerAngles', 'scale', 'mobility', 'layer', 'uuid'];
const VALUE_KINDS: Record<string, string> = {
  Boolean: 'boolean', Number: 'number', String: 'string', Enum: 'enum', BitMask: 'bitmask',
  'cc.Color': 'color', 'cc.Vec2': 'vector', 'cc.Vec3': 'vector', 'cc.Vec4': 'vector',
  'cc.Size': 'size', 'cc.Rect': 'rect'
};

/**
 * 在独立的只读快照上调用 Creator 原生 Dump，不构造用户组件、不修改编辑场景。
 *
 * @param input componentType 为类名；values 为 Simulator 采集值；writable 为运行时属性写能力。
 * @param cc 当前 Creator Scene 进程的引擎模块。
 * @param encode Creator 自身的 cce.Dump.encode。
 * @param translate 当前 Creator 的国际化查询。
 * @returns 首次返回需要采集的字段；带 values 时返回原生 Inspector 的属性和值描述。
 */
export function readRuntimeInspector(input: Data, cc: Data, encode: Data, translate: (key: string) => string): Data {
  const type = input.componentType;
  if (typeof type !== 'string' || !type) throw new ProbeError('COMPONENT_TYPE_REQUIRED');
  const ctor = cc.js.getClassByName(type) || cc.js.getClassByName(`cc.${type}`);
  if (!ctor) throw new ProbeError('RUNTIME_INSPECTOR_CLASS_NOT_FOUND', { componentType: type });
  const isNode = ctor === cc.Node;
  const propertyNames = isNode ? NODE_PROPERTIES : [...new Set([...(ctor.__props__ || []), 'uuid', 'name', 'enabled', 'node'])];
  if (!input.values) return { componentType: cc.js.getClassName(ctor), propertyNames };
  if (typeof input.values !== 'object' || Array.isArray(input.values)) throw new ProbeError('RUNTIME_INSPECTOR_VALUES_INVALID');

  const snapshot = Object.create(ctor.prototype);
  // 只接受原生类声明的字段；defineProperty 绕开 setter，运行时数据不会写入编辑器实例。
  for (const key of propertyNames) {
    if (Object.prototype.hasOwnProperty.call(input.values, key)) defineValue(snapshot, key, restoreValue(input.values[key], cc));
  }
  if (isNode) {
    for (const [key, value] of Object.entries({ parent: null, children: [], _components: [], _prefab: null, _objFlags: 0 })) {
      defineValue(snapshot, key, value);
    }
  }
  const dump = isNode ? { type: 'cc.Node', value: encode.encodeNode(snapshot) } : encode.encodeComponent(snapshot);
  if (isNode) {
    // 原生节点面板把 rotation 标签绑定到 eulerAngles，运行时必须保持同一写入语义。
    dump.value.eulerAngles = dump.value.rotation;
    delete dump.value.rotation;
    dump.value = Object.fromEntries(NODE_PROPERTIES.map((key) => [key, dump.value[key]]));
    dump.value.uuid.readonly = true;
    dump.value.uuid.visible = false;
    // 节点名称和 UUID 统一由选择区展示，运行时字段编辑保持现有路径身份稳定。
    dump.value.name.visible = false;
  }
  applyComponentVisibility(dump);
  const properties: Data = {};
  const propertyMeta: Data = {};
  Object.entries(dump.value as Data).forEach(([key, field], index) => {
    if (!field || (field.visible !== true && key !== 'enabled')) return;
    const kind = field.isArray ? 'array' : referenceKind(field) ? 'reference' : VALUE_KINDS[field.type] || 'object';
    const writable = input.writable?.[key] === true && !key.startsWith('_');
    const editable = writable && !field.readonly && ['boolean', 'number', 'string', 'enum', 'bitmask', 'color', 'vector', 'size', 'rect'].includes(kind);
    properties[key] = readDumpValueDeep(field);
    if (kind === 'reference' && input.values[key]?.name && properties[key]) properties[key].name = input.values[key].name;
    const group = typeof field.group === 'string' ? { name: field.group } : field.group;
    propertyMeta[key] = {
      kind, editable, visible: field.visible === true, declared: true,
      declaredType: field.type,
      displayName: displayName(field, key, translate),
      ...(field.tooltip && translated(field.tooltip, translate) ? { tooltip: translated(field.tooltip, translate) } : {}),
      displayOrder: typeof field.displayOrder === 'number' ? field.displayOrder : index,
      ...(group?.name ? { group: group.name, groupInfo: group } : {}),
      ...Object.fromEntries(['min', 'max', 'step'].filter((name) => typeof field[name] === 'number' && Number.isFinite(field[name])).map((name) => [name, field[name]])),
      ...(Array.isArray(field.enumList) ? { enumOptions: field.enumList } : {}),
      ...(Array.isArray(field.bitmaskList) ? { enumOptions: field.bitmaskList } : {}),
      ...(!editable ? { readOnlyReason: kind === 'reference' ? 'runtime-reference' : kind === 'array' ? 'array-not-editable' : 'property-read-only' } : {}),
      ...(['array', 'object', 'reference'].includes(kind) ? { details: {
        ...compactDump(field, translate, 0, input.values[key]),
        ...(kind === 'reference' ? { value: properties[key] } : {})
      } } : {})
    };
  });
  return {
    componentType: dump.type, properties, propertyMeta, inspectorSource: 'creator',
    showEnabled: !isNode && (input.showEnabled ?? dump.editor?._showTick) === true
  };
}

/**
 * 还原 Simulator 的带类型值，使原生 Dump 使用真实的 ValueType/引用/CCClass 类型。
 *
 * @param value 有界运行时快照；引用仅携带身份，类对象仅携带已声明字段。
 * @param cc 当前 Creator 引擎模块，用于查找已注册类型。
 * @returns 独立数据对象；不会运行组件构造函数或属性 setter。
 */
function restoreValue(value: any, cc: Data): any {
  if (Array.isArray(value)) return value.filter((item) => item?.__type !== 'truncated').map((item) => restoreValue(item, cc));
  if (!value || typeof value !== 'object') return value;
  const reference = ['node-reference', 'component-reference', 'asset-reference'].includes(value.__type);
  if (reference || value.__type === 'inspector-object') {
    const ctor = cc.js.getClassByName(value.className)
      || (value.__type === 'node-reference' ? cc.Node : value.__type === 'component-reference' ? cc.Component : value.__type === 'asset-reference' ? cc.Asset : null);
    if (!ctor) throw new ProbeError('RUNTIME_INSPECTOR_VALUE_TYPE_UNKNOWN', { className: value.className });
    const result = Object.create(ctor.prototype);
    if (reference) {
      for (const [key, item] of Object.entries({ uuid: value.uuid || '', _uuid: value.uuid || '', _id: value.uuid || '', name: value.name || '', _prefab: null, _objFlags: 0 })) defineValue(result, key, item);
      if (value.__type === 'component-reference' && value.node) defineValue(result, 'node', restoreValue(value.node, cc));
    } else {
      for (const [key, item] of Object.entries(value.properties || {})) {
        if (!['__proto__', 'constructor', 'prototype'].includes(key)) defineValue(result, key, restoreValue(item, cc));
      }
    }
    return result;
  }
  if (value.__type) return null;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restoreValue(item, cc)]));
}

/** 在快照上定义数据字段，避免触发引擎或用户组件 setter。 */
function defineValue(target: Data, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: true });
}

/** 按原生 Dump 的继承链识别引用，字段名称不参与分类。 */
function referenceKind(field: Data): boolean {
  return [field.type, ...(field.extends || [])].some((type) => ['cc.Node', 'cc.Component', 'cc.Asset'].includes(type));
}

/** 原生 i18n 缺项时交给属性名回退，避免把内部翻译键显示给用户。 */
function translated(value: string, translate: (key: string) => string): string {
  if (!value.startsWith('i18n:')) return value;
  const key = value.slice(5);
  const text = translate(key);
  return text && text !== key && text !== value ? text : '';
}

/** 采用 Creator inspector/utils/prop.js 的命名顺序：displayName、翻译、属性名。 */
function displayName(field: Data, key: string, translate: (key: string) => string): string {
  return (field.displayName && translated(field.displayName, translate))
    || String(field.name || key).trim().replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/(^|\s)\S/g, (value) => value.toUpperCase()).trim();
}

/** 保留只读复合属性的原生结构，去掉默认值树并隐藏原生不展示的内部成员。 */
function compactDump(field: Data, translate: (key: string) => string, depth = 0, source?: any): Data {
  const result: Data = { type: field.type, kind: field.isArray ? 'array' : referenceKind(field) ? 'reference' : 'object', displayName: displayName(field, '', translate), isArray: field.isArray === true };
  if (depth >= 6) return { ...result, value: '层级过深，未展开' };
  if (field.isArray && Array.isArray(field.value)) {
    result.value = field.value.map((item: Data, index: number) => compactDump(item, translate, depth + 1, source?.[index]));
    const truncated = Array.isArray(source) && source.find((item: Data) => item?.__type === 'truncated');
    if (truncated) result.total = truncated.total;
  }
  else if (field.value && typeof field.value === 'object' && !referenceKind(field)) {
    const values = source?.__type === 'inspector-object' ? source.properties : source;
    result.value = Object.fromEntries(Object.entries(field.value).filter(([, value]) => !(value && typeof value === 'object' && 'visible' in value) || (value as Data).visible === true).map(([key, value]) => [key, value && typeof value === 'object' && 'type' in value ? compactDump(value as Data, translate, depth + 1, values?.[key]) : value]));
  } else result.value = field.value;
  if (referenceKind(field) && !field.isArray && source?.name && result.value) result.value = { ...result.value, name: source.name };
  return result;
}

/**
 * Creator 3.8.8 内置面板在 Dump 后追加的条件显隐。
 * 来源：engine/editor/inspector/components/{sprite,button,layout,rich-text}.js；继承 Button 的 Toggle 共用规则。
 */
function applyComponentVisibility(dump: Data): void {
  const fields = dump.value;
  if (dump.type === 'cc.Sprite') {
    for (const name of ['fillType', 'fillCenter', 'fillStart', 'fillRange']) {
      if (fields[name]) fields[name].visible = fields[name].visible && fields.type?.value === 3;
    }
    if (fields.fillCenter) fields.fillCenter.readonly = fields.fillCenter.readonly || fields.fillType?.value !== 2;
  }
  if ([dump.type, ...(dump.extends || [])].includes('cc.Button')) {
    const transition = fields.transition?.value;
    for (const [names, mode] of [[['normalColor', 'pressedColor', 'hoverColor', 'disabledColor'], 1], [['normalSprite', 'pressedSprite', 'hoverSprite', 'disabledSprite'], 2], [['zoomScale', 'duration'], 3]] as const) {
      for (const name of names) if (fields[name]) fields[name].visible = fields[name].visible && transition === mode;
    }
  }
  if (dump.type === 'cc.Layout') {
    const type = fields.type?.value;
    const visible = (names: string[], condition: boolean): void => {
      for (const name of names) if (fields[name]) fields[name].visible = fields[name].visible && condition;
    };
    visible(['affectedByScale'], type !== 0);
    visible(['cellSize'], type === 3 || fields.resizeMode?.value === 2);
    visible(['startAxis', 'constraint'], type === 3);
    visible(['constraintNum'], type === 3 && fields.constraint?.value !== 0);
    visible(['paddingLeft', 'paddingRight', 'spacingX', 'horizontalDirection', 'alignHorizontal'], type !== 0 && type !== 2);
    visible(['paddingTop', 'paddingBottom', 'spacingY', 'verticalDirection', 'alignVertical'], type !== 0 && type !== 1);
  }
  if (dump.type === 'cc.RichText') {
    if (fields.fontFamily) fields.fontFamily.visible = fields.fontFamily.visible && fields.useSystemFont?.value === true;
    if (fields.font) fields.font.visible = fields.font.visible && fields.useSystemFont?.value !== true;
  }
}
