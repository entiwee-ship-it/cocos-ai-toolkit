import { describe, expect, it } from 'vitest';
import {
  LocalTransformSchema,
  RevisionPreconditionSchema,
  TransactionStateSchema,
  WriteOperationSchema,
  WriteTransactionRequestSchema,
  WriteTransactionResultSchema,
  WriteVerificationReportSchema
} from '../src/index.js';

/**
 * 构造一份合法的事务修订前置，便于各用例按需覆盖单字段。
 *
 * @returns 四个维度均为 null 的修订前置对象。
 */
function createRevisionPrecondition() {
  return {
    document: null,
    hierarchy: null,
    assetDatabase: null,
    scriptCompilation: null
  };
}

/**
 * 构造一份合法的写事务请求，便于各用例按需覆盖单字段。
 *
 * @returns 仅包含一个 node.rename 操作的合法写事务请求。
 */
function createValidRequest() {
  return {
    transactionId: 'tx-1',
    idempotencyKey: 'key-1',
    scope: 'current-document',
    revision: createRevisionPrecondition(),
    operations: [{ type: 'node.rename', nodeUuid: 'n1', name: 'NewName' }],
    save: true,
    undoGroup: 'rename-node'
  };
}

/**
 * 构造一份全部通过的重读验证报告。
 *
 * @returns passed 为 true、包含一条通过项的验证报告。
 */
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

describe('TransactionStateSchema', () => {
  it('接受事务状态机的全部十五个状态', () => {
    const states = [
      'draft', 'planned', 'validated', 'locked', 'executing', 'saving', 'verifying', 'committed',
      'failed', 'rolling-back', 'rolled-back',
      'connection-lost', 'outcome-unknown', 'recovering', 'manual-recovery-required'
    ];

    for (const state of states) {
      expect(TransactionStateSchema.parse(state)).toBe(state);
    }
  });

  it('拒绝状态机之外的未知状态', () => {
    expect(() => TransactionStateSchema.parse('half-committed')).toThrow();
  });
});

describe('RevisionPreconditionSchema', () => {
  it('接受四个维度均带指纹的修订前置', () => {
    expect(RevisionPreconditionSchema.parse({
      document: 'sha256:a',
      hierarchy: 'sha256:b',
      assetDatabase: 'sha256:c',
      scriptCompilation: 'sha256:d'
    })).toBeTruthy();
  });

  it('拒绝缺少维度字段的修订前置', () => {
    expect(() => RevisionPreconditionSchema.parse({ document: 'sha256:a' })).toThrow();
  });
});

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

describe('WriteTransactionRequestSchema', () => {
  it('拒绝缺少幂等键的写事务请求', () => {
    const request = createValidRequest();
    delete (request as { idempotencyKey?: string }).idempotencyKey;

    expect(() => WriteTransactionRequestSchema.parse(request)).toThrow();
  });

  it('接受合法的阶段二写事务请求', () => {
    expect(WriteTransactionRequestSchema.parse(createValidRequest())).toBeTruthy();
  });

  it('拒绝空操作列表', () => {
    const request = createValidRequest();
    request.operations = [];

    expect(() => WriteTransactionRequestSchema.parse(request)).toThrow();
  });

  it('拒绝阶段三的 source-prefab 作用域', () => {
    const request = createValidRequest();
    (request as { scope: string }).scope = 'source-prefab';

    expect(() => WriteTransactionRequestSchema.parse(request)).toThrow();
  });

  it('拒绝阶段三的 apply-to-source 作用域', () => {
    const request = createValidRequest();
    (request as { scope: string }).scope = 'apply-to-source';

    expect(() => WriteTransactionRequestSchema.parse(request)).toThrow();
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

describe('WriteTransactionResultSchema', () => {
  it('写事务结果不允许 committed 且 verification 缺失', () => {
    expect(() => WriteTransactionResultSchema.parse({
      transactionId: 'tx-1',
      status: 'committed',
      executedOps: 1,
      verification: null,
      failure: null,
      rollbackEvidence: null
    })).toThrow();
  });

  it('写事务结果不允许 committed 且 verification 未通过', () => {
    const verification = createPassedVerification();
    verification.passed = false;

    expect(() => WriteTransactionResultSchema.parse({
      transactionId: 'tx-1',
      status: 'committed',
      executedOps: 1,
      verification,
      failure: null,
      rollbackEvidence: null
    })).toThrow();
  });

  it('接受验证通过的 committed 结果', () => {
    expect(WriteTransactionResultSchema.parse({
      transactionId: 'tx-1',
      status: 'committed',
      executedOps: 1,
      verification: createPassedVerification(),
      failure: null,
      rollbackEvidence: null
    })).toBeTruthy();
  });

  it('接受带冲突详情的 failed 结果', () => {
    expect(WriteTransactionResultSchema.parse({
      transactionId: 'tx-1',
      status: 'failed',
      executedOps: 0,
      verification: null,
      failure: {
        code: 'REVISION_CONFLICT',
        message: '文档修订前置不一致',
        operationIndex: null,
        conflicts: [
          { scope: 'document', expected: 'sha256:a', actual: 'sha256:b' }
        ]
      },
      rollbackEvidence: null
    })).toBeTruthy();
  });

  it('接受标记 duplicateOf 的幂等重试结果', () => {
    expect(WriteTransactionResultSchema.parse({
      transactionId: 'tx-1',
      status: 'committed',
      duplicateOf: 'tx-0',
      executedOps: 1,
      verification: createPassedVerification(),
      failure: null,
      rollbackEvidence: null
    })).toBeTruthy();
  });

  it('接受 outcome-unknown 结果且不要求验证报告', () => {
    expect(WriteTransactionResultSchema.parse({
      transactionId: 'tx-1',
      status: 'outcome-unknown',
      executedOps: 0,
      verification: null,
      failure: {
        code: 'EXECUTION_TIMEOUT',
        message: '执行超时，结果未知',
        operationIndex: null
      },
      rollbackEvidence: null
    })).toBeTruthy();
  });
});

/**
 * 构造一份合法的影响分析报告，便于 scope 门禁用例按需覆盖单字段。
 *
 * @returns 通过 PrefabImpactAnalysisSchema 校验的影响分析对象。
 */
function createImpactAnalysis() {
  return {
    sourceAssetUuid: 'asset-1',
    sourceAssetPath: 'db://assets/gui/dialog.prefab',
    affectedDocuments: [
      { assetUuid: 'doc-1', path: 'db://assets/scenes/main.scene', documentType: 'scene', instanceCount: 3 }
    ],
    totalInstanceCount: 3,
    overrideLayers: ['scene'],
    risks: []
  };
}

describe('阶段三写事务协议', () => {
  it('scope 接受 current-document / source-prefab / apply-to-source 三值', () => {
    for (const scope of ['current-document', 'source-prefab', 'apply-to-source'] as const) {
      const request = {
        ...createValidRequest(),
        scope,
        ...(scope === 'current-document' ? {} : { impactAnalysis: createImpactAnalysis() })
      };
      expect(WriteTransactionRequestSchema.parse(request).scope).toBe(scope);
    }
  });

  it('scope 拒绝三值之外的取值', () => {
    expect(() => WriteTransactionRequestSchema.parse({
      ...createValidRequest(),
      scope: 'whole-project'
    })).toThrow();
  });

  it('source-prefab 缺少影响分析时拒绝', () => {
    expect(() => WriteTransactionRequestSchema.parse({
      ...createValidRequest(),
      scope: 'source-prefab'
    })).toThrow();
  });

  it('apply-to-source 缺少影响分析时拒绝', () => {
    expect(() => WriteTransactionRequestSchema.parse({
      ...createValidRequest(),
      scope: 'apply-to-source'
    })).toThrow();
  });

  it('current-document 不强制影响分析', () => {
    expect(WriteTransactionRequestSchema.parse(createValidRequest())).toBeTruthy();
  });

  it('prefab.apply_to_source 操作缺少 revision.prefabGraph 时拒绝', () => {
    expect(() => WriteTransactionRequestSchema.parse({
      ...createValidRequest(),
      scope: 'apply-to-source',
      impactAnalysis: createImpactAnalysis(),
      operations: [{ type: 'prefab.apply_to_source', instanceRootUuid: 'n1' }]
    })).toThrow();
  });

  it('prefab.apply_to_source 操作携带 revision.prefabGraph 时接受', () => {
    expect(WriteTransactionRequestSchema.parse({
      ...createValidRequest(),
      scope: 'apply-to-source',
      impactAnalysis: createImpactAnalysis(),
      revision: { ...createRevisionPrecondition(), prefabGraph: 'sha256:p' },
      operations: [{ type: 'prefab.apply_to_source', instanceRootUuid: 'n1' }]
    })).toBeTruthy();
  });

  it('接受七类 prefab 写操作', () => {
    const operations = [
      { type: 'prefab.instantiate', prefabAssetUuid: 'a1', parentNodeUuid: 'n0', name: 'Card' },
      { type: 'prefab.create_from_node', nodeUuid: 'n1', assetUrl: 'db://assets/a.prefab' },
      { type: 'prefab.revert_override', instanceRootUuid: 'n2' },
      { type: 'prefab.apply_to_source', instanceRootUuid: 'n3' },
      { type: 'prefab.replace_source', instanceRootUuid: 'n4', newPrefabAssetUuid: 'a2' },
      { type: 'prefab.unlink_instance', instanceRootUuid: 'n5' },
      { type: 'prefab.link_instance', nodeUuid: 'n6', prefabAssetUuid: 'a3' }
    ];
    for (const operation of operations) {
      expect(WriteOperationSchema.parse(operation)).toBeTruthy();
    }
  });

  it('prefab.revert_override 支持按属性路径的细粒度还原', () => {
    expect(WriteOperationSchema.parse({
      type: 'prefab.revert_override',
      instanceRootUuid: 'n1',
      propertyPath: 'position'
    })).toBeTruthy();
  });

  it('拒绝缺少 prefabAssetUuid 的实例化操作', () => {
    expect(() => WriteOperationSchema.parse({
      type: 'prefab.instantiate',
      parentNodeUuid: 'n0'
    })).toThrow();
  });

  it('Revision 接受 prefabGraph 维度且可省略', () => {
    expect(RevisionPreconditionSchema.parse(createRevisionPrecondition())).toBeTruthy();
    expect(RevisionPreconditionSchema.parse({
      ...createRevisionPrecondition(),
      prefabGraph: 'sha256:p'
    }).prefabGraph).toBe('sha256:p');
  });
});
