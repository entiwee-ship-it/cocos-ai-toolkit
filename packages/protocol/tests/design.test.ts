import { describe, expect, it } from 'vitest';
import {
  DesignPlanItemSchema,
  DesignPlanSchema,
  DesignTargetDocumentSchema,
  DesignVerifyReportSchema,
  PROTOCOL_VERSION
} from '../src/index.js';

/** 构造一份最小合法目标文档，便于各用例按字段覆盖。 */
function createValidTarget() {
  return {
    document: { scope: 'current-document' },
    tree: [
      {
        id: '$dialog',
        name: 'exitDialog',
        components: [{ type: 'cc.UITransform' }],
        children: [
          { id: '$label', name: 'title', components: [{ type: 'cc.Label', properties: { string: '确定退出？', fontSize: 28 } }] },
          {
            id: '$btn',
            name: 'okBtn',
            prefabInstance: { assetUuid: 'asset-btn-1' },
            references: { 'clickEvents[0].target': '$label' }
          }
        ]
      }
    ]
  };
}

describe('DesignTargetDocumentSchema', () => {
  it('接受带临时逻辑 ID 与引用的目标文档', () => {
    expect(DesignTargetDocumentSchema.parse(createValidTarget())).toBeTruthy();
  });

  it('保留导出文档用于匹配的 fileId 与完整 path', () => {
    const target = createValidTarget();
    const root = target.tree[0] as Record<string, unknown>;
    root.fileId = 'root-file-id';
    root.path = 'Canvas/exitDialog';

    const parsed = DesignTargetDocumentSchema.parse(target) as typeof target & {
      tree: Array<{ fileId?: string; path?: string }>;
    };
    expect(parsed.tree[0]).toMatchObject({ fileId: 'root-file-id', path: 'Canvas/exitDialog' });
  });

  it('拒绝自引用的逻辑 ID', () => {
    const target = createValidTarget();
    target.tree = [{ id: '$a', name: 'a', references: { 'clickEvents[0].target': '$a' } }];
    expect(() => DesignTargetDocumentSchema.parse(target)).toThrow();
  });

  it('拒绝重复的逻辑 ID', () => {
    const target = createValidTarget();
    target.tree[0].children!.push({ id: '$label', name: 'dup' });
    expect(() => DesignTargetDocumentSchema.parse(target)).toThrow();
  });

  it('拒绝指向不存在逻辑 ID 的引用', () => {
    const target = createValidTarget();
    target.tree[0].children![1] = {
      id: '$btn',
      name: 'okBtn',
      references: { 'clickEvents[0].target': '$missing' }
    };
    expect(() => DesignTargetDocumentSchema.parse(target)).toThrow();
  });

  it('接受资产引用形态（非逻辑 ID）', () => {
    const target = createValidTarget();
    target.tree[0].children![1] = {
      id: '$btn',
      name: 'okBtn',
      references: {
        spriteFrame: { kind: 'asset', assetUuid: 'asset-sprite-1', subAssetUuid: null, assetType: 'cc.SpriteFrame', path: null, available: true }
      }
    };
    expect(DesignTargetDocumentSchema.parse(target)).toBeTruthy();
  });

  it('接受引用数组并校验其中每个逻辑 ID', () => {
    const target = createValidTarget();
    target.tree[0].children![1] = {
      id: '$btn',
      name: 'okBtn',
      references: {
        textureFrames: [
          { kind: 'asset', assetUuid: 'texture-a', subAssetUuid: 'frame-a', assetType: 'cc.SpriteFrame', path: null, available: true },
          '$label'
        ]
      }
    };
    expect(DesignTargetDocumentSchema.parse(target)).toBeTruthy();

    target.tree[0].children![1].references!.textureFrames[1] = '$missing';
    expect(() => DesignTargetDocumentSchema.parse(target)).toThrow('引用指向不存在的逻辑 ID');
  });

  it('document.extract_subtree 只接受文档内节点并要求 Prefab 目标路径', () => {
    const target = createValidTarget();
    target.operations = [{
      type: 'document.extract_subtree', nodeId: '$label', assetUrl: 'db://assets/ui/Label.prefab'
    }];
    expect(DesignTargetDocumentSchema.parse(target)).toBeTruthy();

    target.operations[0].nodeId = '$missing';
    expect(() => DesignTargetDocumentSchema.parse(target)).toThrow('抽取节点不存在');
    target.operations[0].nodeId = '$label';
    target.operations[0].assetUrl = 'db://assets/ui/Label.json';
    expect(() => DesignTargetDocumentSchema.parse(target)).toThrow();
  });

  it('拒绝不合规的逻辑 ID 形态', () => {
    const target = createValidTarget();
    target.tree[0].id = 'dialog';
    expect(() => DesignTargetDocumentSchema.parse(target)).toThrow();
  });
});

describe('DesignPlanItemSchema / DesignPlanSchema', () => {
  it('计划项保留 Override 标注与依赖信息', () => {
    expect(DesignPlanItemSchema.parse({
      kind: 'component.set_property',
      target: '$label',
      propertyPath: 'fontSize',
      value: 28,
      producesOverride: true,
      overrideLayer: 'current-document',
      dependsOn: ['$dialog']
    })).toBeTruthy();
  });

  it('计划保留影响分析、风险与不可表达差异', () => {
    expect(DesignPlanSchema.parse({
      items: [],
      impactAnalysis: {
        sourceAssetUuid: 'asset-1',
        sourceAssetPath: 'db://assets/a.prefab',
        affectedDocuments: [],
        totalInstanceCount: 0,
        overrideLayers: [],
        risks: []
      },
      risks: ['示例风险'],
      unresolved: [{ path: '$dialog.items', reason: '数组重排暂不支持' }]
    })).toBeTruthy();
  });
});

describe('DesignVerifyReportSchema', () => {
  it('逐项验证报告保留 expected/actual/passed', () => {
    expect(DesignVerifyReportSchema.parse({
      passed: true,
      verifiedAt: '2026-07-20T00:00:00.000Z',
      items: [
        { target: '$label', description: '标题字号为 28', expected: 28, actual: 28, passed: true }
      ]
    })).toBeTruthy();
  });
});

describe('协议版本', () => {
  it('协议版本为 0.6.0', () => {
    expect(PROTOCOL_VERSION).toBe('0.6.0');
  });
});
