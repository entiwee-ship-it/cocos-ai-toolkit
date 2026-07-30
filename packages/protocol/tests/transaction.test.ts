import { describe, expect, it } from 'vitest';
import {
  DirectWriteOutcomeSchema,
  DirectWriteRequestSchema,
  LocalTransformSchema,
  WriteOperationSchema,
  WriteVerificationReportSchema
} from '../src/index.js';

describe('LocalTransformSchema', () => {
  it('接受只带位置的局部变换', () => {
    expect(LocalTransformSchema.parse({
      position: { x: 1, y: 2, z: 3 }
    })).toBeTruthy();
  });

  it('拒绝三个分量全空的局部变换', () => {
    expect(() => LocalTransformSchema.parse({})).toThrow();
  });
});

describe('WriteOperationSchema', () => {
  it('接受节点八类原子写操作', () => {
    const operations = [
      { type: 'node.create', parentNodeUuid: 'p1', name: 'child' },
      { type: 'node.delete', nodeUuid: 'n1' },
      { type: 'node.rename', nodeUuid: 'n1', name: 'NewName' },
      { type: 'node.reparent', nodeUuid: 'n1', newParentUuid: 'p2', siblingIndex: 0 },
      { type: 'node.duplicate', nodeUuid: 'n1' },
      { type: 'node.set_active', nodeUuid: 'n1', active: false },
      { type: 'node.set_layer', nodeUuid: 'n1', layer: 33554432 },
      {
        type: 'node.set_transform',
        nodeUuid: 'n1',
        localTransform: { position: { x: 0, y: 0, z: 0 } }
      }
    ];

    for (const operation of operations) {
      expect(WriteOperationSchema.parse(operation)).toBeTruthy();
    }
  });

  it('接受组件七类原子写操作', () => {
    const operations = [
      { type: 'component.add', nodeUuid: 'n1', componentType: 'cc.Button', scriptUuid: null },
      { type: 'component.remove', componentUuid: 'c1' },
      { type: 'component.enable', componentUuid: 'c1', enabled: false },
      { type: 'component.set_property', componentUuid: 'c1', propertyPath: 'items[2]', value: 3 },
      {
        type: 'component.set_reference',
        componentUuid: 'c1',
        propertyPath: 'clickEvents[0].target',
        reference: { kind: 'node', objectUuid: 'n9', fileId: null, nodePath: '/root/btn', available: true }
      },
      { type: 'component.clear_reference', componentUuid: 'c1', propertyPath: 'clickEvents[0].target' },
      { type: 'component.resize_array', componentUuid: 'c1', propertyPath: 'items', length: 2 }
    ];

    for (const operation of operations) {
      expect(WriteOperationSchema.parse(operation)).toBeTruthy();
    }
  });

  it('接受嵌套属性路径的引用设置', () => {
    expect(WriteOperationSchema.parse({
      type: 'component.set_reference',
      componentUuid: 'c1',
      propertyPath: 'clickEvents[0].target',
      reference: { kind: 'node', objectUuid: 'n9', fileId: null, nodePath: '/root/btn', available: true }
    })).toBeTruthy();
  });

  it('component.set_reference 接受有序引用数组', () => {
    const operation = WriteOperationSchema.parse({
      type: 'component.set_reference',
      componentUuid: 'component-a',
      propertyPath: 'textureFrames',
      reference: [
        { kind: 'asset', assetUuid: 'texture-a', subAssetUuid: 'frame-a', assetType: 'cc.SpriteFrame', path: null, available: true },
        { kind: 'asset', assetUuid: 'texture-b', subAssetUuid: 'frame-b', assetType: 'cc.SpriteFrame', path: null, available: true }
      ]
    });

    expect(operation.reference).toHaveLength(2);
  });

  it('接受 Creator AssetDB 创建、移动、删除和元数据写入操作', () => {
    const operations = [
      {
        type: 'asset.create', assetUrl: 'db://assets/ui', assetKind: 'folder'
      },
      {
        type: 'asset.create', assetUrl: 'db://assets/ui/Dialog.ts', assetKind: 'component-script',
        content: 'import { _decorator, Component } from "cc"; export class Dialog extends Component {}'
      },
      {
        type: 'asset.move', sourceUrl: 'db://assets/ui/Dialog.ts', targetUrl: 'db://assets/view/Dialog.ts',
        expectedAssetUuid: 'script-dialog'
      },
      {
        type: 'asset.write_meta', assetUrl: 'db://assets/view/Dialog.ts', expectedAssetUuid: 'script-dialog',
        meta: { userData: { priority: 1 } }
      },
      {
        type: 'asset.delete', assetUrl: 'db://assets/view/Dialog.ts', expectedAssetUuid: 'script-dialog'
      }
    ];

    for (const operation of operations) expect(WriteOperationSchema.parse(operation)).toBeTruthy();
    expect(() => WriteOperationSchema.parse({
      type: 'asset.create', assetUrl: 'db://assets/empty.prefab', assetKind: 'prefab'
    })).toThrow();
  });

  it('受控资产内容恢复要求 UUID 与恢复前后 SHA256 前置', () => {
    const currentSha256 = 'a'.repeat(64);
    const targetSha256 = 'b'.repeat(64);
    expect(WriteOperationSchema.parse({
      type: 'asset.restore_content',
      assetUrl: 'db://assets/ui/Dialog.prefab',
      expectedAssetUuid: 'dialog-prefab',
      expectedCurrentSha256: currentSha256,
      content: '[{\"__type__\":\"cc.Prefab\"}]',
      targetSha256
    })).toBeTruthy();
    expect(() => WriteOperationSchema.parse({
      type: 'asset.restore_content',
      assetUrl: 'db://assets/ui/Dialog.prefab',
      expectedAssetUuid: 'dialog-prefab',
      expectedCurrentSha256: 'not-a-hash',
      content: '[]',
      targetSha256
    })).toThrow();
  });

  it('安全文本替换要求精确旧文本且禁止无效替换', () => {
    expect(WriteOperationSchema.parse({
      type: 'asset.update_text',
      assetUrl: 'db://assets/script/GameUIConfig.ts',
      expectedAssetUuid: 'game-ui-config',
      expectedCurrentSha256: 'a'.repeat(64),
      oldText: 'UIID.Lobby,',
      newText: 'UIID.Lobby,\n  UIID.CocosAiValidation,'
    })).toBeTruthy();
    expect(() => WriteOperationSchema.parse({
      type: 'asset.update_text',
      assetUrl: 'db://assets/script/GameUIConfig.ts',
      expectedAssetUuid: 'game-ui-config',
      oldText: 'UIID.Lobby,',
      newText: 'UIID.Lobby,'
    })).toThrow();
  });

  it('接受带 expectedOldValue 乐观锁的属性写入', () => {
    expect(WriteOperationSchema.parse({
      type: 'component.set_property',
      componentUuid: 'c1',
      propertyPath: 'settings.colors[0]',
      value: '#FFFFFF',
      expectedOldValue: '#000000'
    })).toBeTruthy();
  });

  it('拒绝未知操作类型', () => {
    expect(() => WriteOperationSchema.parse({ type: 'node.explode', nodeUuid: 'n1' })).toThrow();
  });

  it('拒绝空名称的节点创建', () => {
    expect(() => WriteOperationSchema.parse({
      type: 'node.create',
      parentNodeUuid: 'p1',
      name: ''
    })).toThrow();
  });

  it('拒绝负数长度的数组调整', () => {
    expect(() => WriteOperationSchema.parse({
      type: 'component.resize_array',
      componentUuid: 'c1',
      propertyPath: 'items',
      length: -1
    })).toThrow();
  });
});

describe('WriteVerificationReportSchema', () => {
  it('接受逐项列出期望值和实际值的验证报告', () => {
    expect(WriteVerificationReportSchema.parse(createPassedVerification())).toBeTruthy();
  });

  it('拒绝缺少逐项明细的验证报告', () => {
    const report = createPassedVerification();
    delete (report as { items?: unknown[] }).items;

    expect(() => WriteVerificationReportSchema.parse(report)).toThrow();
  });
});

describe('DirectWriteRequestSchema', () => {
  it('接受一批原子写操作加保存开关', () => {
    expect(DirectWriteRequestSchema.parse({
      operations: [{ type: 'node.rename', nodeUuid: 'n1', name: 'NewName' }],
      save: true,
      undoGroup: 'direct-rename'
    })).toBeTruthy();
  });

  it('拒绝空操作列表和空 Undo 组名', () => {
    expect(() => DirectWriteRequestSchema.parse({
      operations: [],
      save: true,
      undoGroup: 'direct'
    })).toThrow();
    expect(() => DirectWriteRequestSchema.parse({
      operations: [{ type: 'node.rename', nodeUuid: 'n1', name: 'NewName' }],
      save: true,
      undoGroup: ''
    })).toThrow();
  });
});

describe('DirectWriteOutcomeSchema', () => {
  it('接受带验证报告的成功结果', () => {
    expect(DirectWriteOutcomeSchema.parse({
      kind: 'success',
      executedOps: 1,
      verification: createPassedVerification()
    })).toBeTruthy();
  });

  it('接受带失败明细的操作失败结果', () => {
    expect(DirectWriteOutcomeSchema.parse({
      kind: 'operation-failed',
      executedOps: 0,
      failure: {
        code: 'WRITE_OPERATION_FAILED',
        message: 'WRITE_OPERATION_FAILED',
        operationIndex: 0
      }
    })).toBeTruthy();
  });

  it('拒绝未知结果类型', () => {
    expect(() => DirectWriteOutcomeSchema.parse({ kind: 'half-done', executedOps: 0 })).toThrow();
  });
});

function createPassedVerification() {
  return {
    passed: true,
    verifiedAt: '2026-07-17T00:00:00.000Z',
    items: [
      {
        operationIndex: 0,
        description: '节点重命名生效',
        expected: 'NewName',
        actual: 'NewName',
        passed: true
      }
    ]
  };
}
