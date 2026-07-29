import { describe, expect, it } from 'vitest';
import type {
  DesignPlan,
  DesignPlanItem,
  RevisionPrecondition,
  WriteTransactionRequest,
  WriteTransactionResult
} from '@cocos-ai/protocol';
import {
  applyDesignPlan,
  DesignApplyCommittedError,
  DesignApplyConfirmError,
  DesignApplyRollbackError,
  type DesignApplyRuntime,
  type DesignApplyVerificationItem
} from '../src/design-apply.js';

describe('applyDesignPlan', () => {
  it('计划按序执行，逻辑 ID 引用物化为真实节点 UUID', async () => {
    const runtime = new FakeApplyRuntime();
    const result = await applyDesignPlan(createReferencePlan(), runtime, {
      executionId: 'run-1',
      initialNodeResolutions: { '$root': 'uuid-root' }
    });

    expect(result.status).toBe('committed');
    expect(result.resolutions.nodes).toMatchObject({
      '$dialog': 'uuid-dialog', '$label': 'uuid-label', '$button': 'uuid-button'
    });
    const lastOperation = runtime.requests.at(-1)?.operations[0];
    expect(lastOperation).toEqual({
      type: 'component.set_reference',
      componentUuid: 'component-button',
      propertyPath: 'clickEvents[0].target',
      reference: {
        kind: 'node', objectUuid: 'uuid-label', fileId: null, nodePath: null, available: true
      }
    });
  });

  it('临时流程仅在首个事务提交后允许继续写脏文档且始终不保存', async () => {
    const runtime = new FakeApplyRuntime();

    const result = await applyDesignPlan(createReferencePlan(), runtime, {
      executionId: 'run-scratch',
      initialNodeResolutions: { '$root': 'uuid-root' },
      revision: {
        document: null,
        hierarchy: 'sha256:hier-0',
        assetDatabase: null,
        scriptCompilation: null,
        prefabGraph: null
      },
      save: false,
      allowDirtyAfterFirstCommit: true
    });

    expect(result.status).toBe('committed');
    expect(runtime.requests[0]).toMatchObject({ save: false });
    expect(runtime.requests[0]).not.toHaveProperty('allowDirty');
    expect(runtime.requests.slice(1).every((request) => (
      request.save === false && request.allowDirty === true
    ))).toBe(true);
  });

  it('引用数组逐项物化逻辑 ID 并保留资产引用顺序', async () => {
    const runtime = new FakeApplyRuntime();
    const assetReference = {
      kind: 'asset' as const,
      assetUuid: 'texture-a',
      subAssetUuid: 'frame-a',
      assetType: 'cc.SpriteFrame',
      path: null,
      available: true
    };
    const plan: DesignPlan = {
      items: [{
        kind: 'component.set_reference',
        target: '$button',
        propertyPath: 'textureFrames',
        params: { componentType: 'FrameList', reference: ['$first', assetReference, '$second'] }
      }],
      risks: [],
      unresolved: []
    };

    await applyDesignPlan(plan, runtime, {
      executionId: 'run-reference-array',
      initialNodeResolutions: {
        '$button': 'uuid-button', '$first': 'uuid-first', '$second': 'uuid-second'
      }
    });

    expect(runtime.requests[0].operations[0]).toMatchObject({
      type: 'component.set_reference',
      propertyPath: 'textureFrames',
      reference: [
        { kind: 'node', objectUuid: 'uuid-first' },
        assetReference,
        { kind: 'node', objectUuid: 'uuid-second' }
      ]
    });
  });

  it('document.extract_subtree 物化为 Creator prefab.create_from_node', async () => {
    const runtime = new FakeApplyRuntime();
    const plan: DesignPlan = {
      items: [{
        kind: 'document.extract_subtree', target: '$dialog',
        params: { nodeLogicalId: '$dialog', assetUrl: 'db://assets/ui/Dialog.prefab' }
      }],
      risks: [], unresolved: []
    };

    await applyDesignPlan(plan, runtime, {
      executionId: 'run-extract-subtree',
      initialNodeResolutions: { '$dialog': 'node-dialog' }
    });

    expect(runtime.requests[0].operations).toEqual([{
      type: 'prefab.create_from_node', nodeUuid: 'node-dialog', assetUrl: 'db://assets/ui/Dialog.prefab'
    }]);
  });

  it('嵌套实例 override 物化实例根、组件目标和引用值', async () => {
    const runtime = new FakeApplyRuntime();
    const plan: DesignPlan = {
      items: [{
        kind: 'prefab.instance_override',
        target: '$label',
        propertyPath: 'target',
        params: {
          instanceRootLogicalId: '$panel',
          componentType: 'cc.Label',
          targetNodePath: 'Root/Panel/Label',
          reference: '$target'
        },
        producesOverride: true,
        overrideLayer: 'instance:$panel'
      }],
      risks: [], unresolved: []
    };

    await applyDesignPlan(plan, runtime, {
      executionId: 'run-instance-override',
      initialNodeResolutions: {
        '$panel': 'node-panel', '$label': 'node-label', '$target': 'node-target'
      }
    });

    expect(runtime.requests[0].operations).toEqual([{
      type: 'prefab.instance_override',
      instanceRootUuid: 'node-panel',
      targetObjectUuid: 'component-cc.Label',
      targetNodePath: 'Root/Panel/Label',
      propertyPath: 'target',
      value: {
        kind: 'node', objectUuid: 'node-target', fileId: null, nodePath: null, available: true
      }
    }]);
  });

  it('精确还原计划物化目标组件而不是整实例还原', async () => {
    const runtime = new FakeApplyRuntime();
    const plan: DesignPlan = {
      items: [{
        kind: 'prefab.revert_override',
        target: '$label',
        propertyPath: 'string',
        params: {
          instanceRootLogicalId: '$panel',
          targetObjectLogicalId: '$label',
          componentType: 'cc.Label',
          targetNodePath: 'Root/Panel/Label'
        }
      }],
      risks: [], unresolved: []
    };

    await applyDesignPlan(plan, runtime, {
      executionId: 'run-revert-instance-override',
      initialNodeResolutions: { '$panel': 'node-panel', '$label': 'node-label' }
    });

    expect(runtime.requests[0].operations).toEqual([{
      type: 'prefab.revert_override',
      instanceRootUuid: 'node-panel',
      targetObjectUuid: 'component-cc.Label',
      targetNodePath: 'Root/Panel/Label',
      propertyPath: 'string'
    }]);
  });

  it('连续属性与引用操作按依赖阶段合并为同一原子事务', async () => {
    const runtime = new FakeApplyRuntime();
    const plan: DesignPlan = {
      items: [
        {
          kind: 'component.set_property',
          target: '$label',
          propertyPath: 'string',
          value: '新标题',
          params: { componentType: 'cc.Label' }
        },
        {
          kind: 'component.set_reference',
          target: '$button',
          propertyPath: 'clickEvents[0].target',
          params: { componentType: 'cc.Button', resolveTo: '$label' }
        }
      ],
      risks: [],
      unresolved: []
    };

    const result = await applyDesignPlan(plan, runtime, {
      executionId: 'run-grouped-properties',
      initialNodeResolutions: {
        '$label': 'uuid-label',
        '$button': 'uuid-button'
      }
    });

    expect(result.status).toBe('committed');
    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0].operations).toHaveLength(2);
    expect(runtime.requests[0].operations.map((operation) => operation.type)).toEqual([
      'component.set_property',
      'component.set_reference'
    ]);
  });

  it('任一步失败即停并按逆序回滚已提交事务', async () => {
    const runtime = new FakeApplyRuntime({ failConfirmAt: 1 });
    const plan: DesignPlan = {
      items: [
        { kind: 'node.create', target: '$dialog', params: { parentLogicalId: '$root', name: 'dialog' } },
        { kind: 'node.create', target: '$label', params: { parentLogicalId: '$dialog', name: 'label' } },
        { kind: 'node.create', target: '$never', params: { parentLogicalId: '$dialog', name: 'never' } }
      ],
      risks: [], unresolved: []
    };

    const result = await applyDesignPlan(plan, runtime, {
      executionId: 'run-fail', initialNodeResolutions: { '$root': 'uuid-root' }
    });

    expect(result.status).toBe('rolled-back');
    expect(result.failedStep).toMatchObject({ index: 1, kind: 'node.create', target: '$label' });
    expect(runtime.rolledBackTransactions).toEqual(['run-fail-001']);
    expect(runtime.requests).toHaveLength(2);
  });

  it('事务提交后独立重读验证失败也会回滚并报告 expected/actual', async () => {
    const runtime = new FakeApplyRuntime({ failVerificationAt: 0 });
    const plan: DesignPlan = {
      items: [{ kind: 'node.create', target: '$dialog', params: { parentLogicalId: '$root', name: 'dialog' } }],
      risks: [], unresolved: []
    };

    const result = await applyDesignPlan(plan, runtime, {
      executionId: 'run-verify', initialNodeResolutions: { '$root': 'uuid-root' }
    });

    expect(result.status).toBe('rolled-back');
    expect(result.verification).toMatchObject({ passed: false });
    expect(result.verification.items[0]).toMatchObject({
      expected: 'node.create:$dialog', actual: 'mismatch', passed: false
    });
    expect(runtime.rolledBackTransactions).toEqual(['run-verify-001']);
  });

  it('未知计划项在任何写入前整体拒绝', async () => {
    const runtime = new FakeApplyRuntime();
    const plan: DesignPlan = {
      items: [
        { kind: 'node.create', target: '$dialog', params: { parentLogicalId: '$root', name: 'dialog' } },
        { kind: 'unknown.write', target: '$dialog' }
      ],
      risks: [], unresolved: []
    };

    await expect(applyDesignPlan(plan, runtime, {
      executionId: 'run-unknown', initialNodeResolutions: { '$root': 'uuid-root' }
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_DESIGN_PLAN_ITEM' });
    expect(runtime.requests).toHaveLength(0);
  });

  it('unresolved 计划在任何写入前整体拒绝', async () => {
    const runtime = new FakeApplyRuntime();
    const plan: DesignPlan = {
      items: [{ kind: 'node.create', target: '$dialog', params: { parentLogicalId: '$root', name: 'dialog' } }],
      risks: [],
      unresolved: [{ path: '$dialog', reason: '预制体内容封闭' }]
    };

    await expect(applyDesignPlan(plan, runtime, {
      executionId: 'run-unresolved', initialNodeResolutions: { '$root': 'uuid-root' }
    })).rejects.toMatchObject({ code: 'DESIGN_PLAN_UNRESOLVED' });
    expect(runtime.requests).toHaveLength(0);
  });

  it('多事务逆序回滚且任一回滚不干净时要求人工恢复', async () => {
    const runtime = new FakeApplyRuntime({
      failVerificationAt: 2,
      dirtyRollbackTransaction: 'run-dirty-002'
    });
    const plan: DesignPlan = {
      items: [
        { kind: 'node.create', target: '$dialog', params: { parentLogicalId: '$root', name: 'dialog' } },
        { kind: 'node.create', target: '$label', params: { parentLogicalId: '$dialog', name: 'label' } },
        { kind: 'node.create', target: '$never', params: { parentLogicalId: '$dialog', name: 'never' } }
      ],
      risks: [], unresolved: []
    };

    const result = await applyDesignPlan(plan, runtime, {
      executionId: 'run-dirty', initialNodeResolutions: { '$root': 'uuid-root' }
    });

    expect(result.status).toBe('manual-recovery-required');
    expect(runtime.rolledBackTransactions).toEqual([
      'run-dirty-003', 'run-dirty-002'
    ]);
  });

  it.each([
    ['prepare', 'executing'],
    ['confirm', 'saving']
  ] as const)('%s 返回非终态 %s 时要求人工恢复且不回滚依赖', async (phase, status) => {
    const runtime = new FakeApplyRuntime(phase === 'prepare'
      ? { prepareStatusAt: { index: 1, status } }
      : { confirmStatusAt: { index: 1, status } });
    const plan: DesignPlan = {
      items: [
        { kind: 'node.create', target: '$dialog', params: { parentLogicalId: '$root', name: 'dialog' } },
        { kind: 'node.create', target: '$label', params: { parentLogicalId: '$dialog', name: 'label' } }
      ],
      risks: [], unresolved: []
    };

    const result = await applyDesignPlan(plan, runtime, {
      executionId: `run-${phase}-in-flight`, initialNodeResolutions: { '$root': 'uuid-root' }
    });

    expect(result.status).toBe('manual-recovery-required');
    expect(runtime.rolledBackTransactions).toEqual([]);
  });

  it('prepare 幂等命中已提交事务时恢复提交事实并继续独立验证', async () => {
    const runtime = new FakeApplyRuntime({ prepareCommittedDuplicateAt: 0 });
    const plan: DesignPlan = {
      items: [{ kind: 'node.create', target: '$dialog', params: { parentLogicalId: '$root', name: 'dialog' } }],
      risks: [], unresolved: []
    };

    const result = await applyDesignPlan(plan, runtime, {
      executionId: 'run-duplicate-commit', initialNodeResolutions: { '$root': 'uuid-root' }
    });

    expect(result.status).toBe('committed');
    expect(result.resolutions.nodes.$dialog).toBe('uuid-dialog');
    expect(runtime.confirmedTransactions).toEqual([]);
  });

  it.each(['committed-error', 'confirm-error'] as const)(
    '%s 携带其它事务结果时按结果未知处理',
    async (errorKind) => {
      const runtime = new FakeApplyRuntime({ mismatchedConfirmError: errorKind });
      const plan: DesignPlan = {
        items: [{ kind: 'node.delete', target: 'uuid-a', params: { targetUuid: 'uuid-a' } }],
        risks: [], unresolved: []
      };

      const result = await applyDesignPlan(plan, runtime, { executionId: `run-${errorKind}-id` });

      expect(result.status).toBe('manual-recovery-required');
      expect(result.failedStep).toMatchObject({ code: 'DESIGN_TRANSACTION_ID_MISMATCH' });
      expect(runtime.rolledBackTransactions).toEqual([]);
    }
  );

  it('回滚返回其它事务 ID 时停止拆除更早依赖', async () => {
    const runtime = new FakeApplyRuntime({
      failVerificationAt: 2,
      mismatchedRollbackTransaction: 'run-rollback-id-003'
    });
    const plan: DesignPlan = {
      items: [
        { kind: 'node.create', target: '$dialog', params: { parentLogicalId: '$root', name: 'dialog' } },
        { kind: 'node.create', target: '$label', params: { parentLogicalId: '$dialog', name: 'label' } },
        { kind: 'node.create', target: '$never', params: { parentLogicalId: '$dialog', name: 'never' } }
      ],
      risks: [], unresolved: []
    };

    const result = await applyDesignPlan(plan, runtime, {
      executionId: 'run-rollback-id', initialNodeResolutions: { '$root': 'uuid-root' }
    });

    expect(result.status).toBe('manual-recovery-required');
    expect(runtime.rolledBackTransactions).toEqual(['run-rollback-id-003']);
  });

  it('回滚审计失败携带不干净结果时停止拆除更早依赖', async () => {
    const runtime = new FakeApplyRuntime({
      failVerificationAt: 2,
      rollbackAuditDirtyTransaction: 'run-rollback-audit-dirty-003'
    });
    const plan: DesignPlan = {
      items: [
        { kind: 'node.create', target: '$dialog', params: { parentLogicalId: '$root', name: 'dialog' } },
        { kind: 'node.create', target: '$label', params: { parentLogicalId: '$dialog', name: 'label' } },
        { kind: 'node.create', target: '$never', params: { parentLogicalId: '$dialog', name: 'never' } }
      ],
      risks: [], unresolved: []
    };

    const result = await applyDesignPlan(plan, runtime, {
      executionId: 'run-rollback-audit-dirty', initialNodeResolutions: { '$root': 'uuid-root' }
    });

    expect(result.status).toBe('manual-recovery-required');
    expect(runtime.rolledBackTransactions).toEqual(['run-rollback-audit-dirty-003']);
    expect(result.auditFailures).toMatchObject([{ phase: 'rollback' }]);
  });

  it('current-document 刷新不得丢失初始启用的 revision 维度', async () => {
    const runtime = new FakeApplyRuntime({ incompleteCapturedRevision: true });
    const plan: DesignPlan = {
      items: [
        { kind: 'node.create', target: '$dialog', params: { parentLogicalId: '$root', name: 'dialog' } },
        { kind: 'node.create', target: '$label', params: { parentLogicalId: '$dialog', name: 'label' } }
      ],
      risks: [], unresolved: []
    };

    const result = await applyDesignPlan(plan, runtime, {
      executionId: 'run-current-revision-drop',
      initialNodeResolutions: { '$root': 'uuid-root' },
      revision: {
        document: 'sha256:doc-0', hierarchy: 'sha256:hier-0',
        assetDatabase: 'sha256:asset-0', scriptCompilation: 'sha256:script-0'
      }
    });

    expect(result).toMatchObject({
      status: 'rolled-back', failedStep: { code: 'DESIGN_REVISION_DIMENSION_DROPPED' }
    });
    expect(runtime.requests).toHaveLength(1);
  });

  it('同一组件同一路径的连续写入建立新的事务边界', async () => {
    const runtime = new FakeApplyRuntime();
    const plan: DesignPlan = {
      items: [
        {
          kind: 'component.set_property', target: '$label', propertyPath: 'string',
          value: 'A', params: { componentType: 'cc.Label' }
        },
        {
          kind: 'component.set_property', target: '$label', propertyPath: 'string',
          value: 'B', params: { componentType: 'cc.Label' }
        }
      ],
      risks: [], unresolved: []
    };

    const result = await applyDesignPlan(plan, runtime, {
      executionId: 'run-repeated-write', initialNodeResolutions: { '$label': 'uuid-label' }
    });

    expect(result.status).toBe('committed');
    expect(runtime.requests).toHaveLength(2);
    expect(runtime.requests.map((request) => request.operations[0])).toMatchObject([
      { value: 'A' }, { value: 'B' }
    ]);
  });

  it('UITransform contentSize 在 Label 属性提交后使用独立事务', async () => {
    const runtime = new FakeApplyRuntime();
    const plan: DesignPlan = {
      items: [
        {
          kind: 'component.set_property', target: '$title', propertyPath: 'string',
          value: 'Cocos AI 0.2.0', params: { componentType: 'cc.Label' }
        },
        {
          kind: 'component.set_property', target: '$title', propertyPath: 'contentSize',
          value: { width: 400, height: 80 }, params: { componentType: 'cc.UITransform' }
        }
      ],
      risks: [], unresolved: []
    };

    const result = await applyDesignPlan(plan, runtime, {
      executionId: 'run-layout-final', initialNodeResolutions: { '$title': 'uuid-title' }
    });

    expect(result.status).toBe('committed');
    expect(runtime.requests).toHaveLength(2);
    expect(runtime.requests.map((request) => request.operations[0])).toMatchObject([
      { propertyPath: 'string' }, { propertyPath: 'contentSize' }
    ]);
  });

  it('脚本等待后刷新活动 revision 再执行写事务', async () => {
    const runtime = new FakeApplyRuntime({ captureScriptCompilation: true });
    const plan: DesignPlan = {
      items: [
        { kind: 'script.wait_for_compile', target: 'script-a', params: { scriptUuid: 'script-a' } },
        { kind: 'component.add', target: '$root', params: { componentType: 'GameLogic', scriptUuid: 'script-a' } }
      ],
      risks: [], unresolved: []
    };

    const result = await applyDesignPlan(plan, runtime, {
      executionId: 'run-wait-refresh', initialNodeResolutions: { '$root': 'uuid-root' },
      revision: {
        document: null, hierarchy: null, assetDatabase: null,
        scriptCompilation: 'sha256:script-0'
      }
    });

    expect(result.status).toBe('committed');
    expect(runtime.requests[0].revision.scriptCompilation).toBe('sha256:script-1');
  });

  it('连续脚本等待失败准确归因到对应计划项', async () => {
    const runtime = new FakeApplyRuntime({ failWaitForScript: 'script-b' });
    const plan: DesignPlan = {
      items: [
        { kind: 'script.wait_for_compile', target: 'script-a', params: { scriptUuid: 'script-a' } },
        { kind: 'script.wait_for_compile', target: 'script-b', params: { scriptUuid: 'script-b' } }
      ],
      risks: [], unresolved: []
    };

    const result = await applyDesignPlan(plan, runtime, { executionId: 'run-wait-failure' });

    expect(result).toMatchObject({
      status: 'failed', failedStep: { index: 1, target: 'script-b' }
    });
  });

  it('分组事务的提交结果必须覆盖全部操作和逐项验证', async () => {
    const runtime = new FakeApplyRuntime({ incompleteConfirmCoverageAt: 0 });
    const plan: DesignPlan = {
      items: [
        {
          kind: 'component.set_property', target: '$label', propertyPath: 'string',
          value: '标题', params: { componentType: 'cc.Label' }
        },
        {
          kind: 'component.set_reference', target: '$button', propertyPath: 'target',
          params: { componentType: 'cc.Button', resolveTo: '$label' }
        }
      ],
      risks: [], unresolved: []
    };

    const result = await applyDesignPlan(plan, runtime, {
      executionId: 'run-coverage',
      initialNodeResolutions: { '$label': 'uuid-label', '$button': 'uuid-button' }
    });

    expect(result).toMatchObject({
      status: 'rolled-back', failedStep: { code: 'DESIGN_CONFIRM_COVERAGE_MISMATCH' }
    });
  });

  it('Bridge 正常返回 outcome-unknown 时要求人工恢复且不盲目回滚', async () => {
    const runtime = new FakeApplyRuntime({ outcomeUnknownAt: 0 });
    const plan: DesignPlan = {
      items: [{ kind: 'node.create', target: '$dialog', params: { parentLogicalId: '$root', name: 'dialog' } }],
      risks: [], unresolved: []
    };

    const result = await applyDesignPlan(plan, runtime, {
      executionId: 'run-outcome-unknown', initialNodeResolutions: { '$root': 'uuid-root' }
    });

    expect(result.status).toBe('manual-recovery-required');
    expect(result.failedStep).toMatchObject({ code: 'DESIGN_CONFIRM_OUTCOME_UNKNOWN' });
    expect(runtime.rolledBackTransactions).toEqual([]);
  });

  it('后续事务 outcome-unknown 时保留前置事务且不盲目回滚', async () => {
    const runtime = new FakeApplyRuntime({ outcomeUnknownAt: 1 });
    const plan: DesignPlan = {
      items: [
        { kind: 'node.create', target: '$dialog', params: { parentLogicalId: '$root', name: 'dialog' } },
        { kind: 'node.create', target: '$label', params: { parentLogicalId: '$dialog', name: 'label' } }
      ],
      risks: [], unresolved: []
    };

    const result = await applyDesignPlan(plan, runtime, {
      executionId: 'run-late-outcome-unknown', initialNodeResolutions: { '$root': 'uuid-root' }
    });

    expect(result.status).toBe('manual-recovery-required');
    expect(runtime.rolledBackTransactions).toEqual([]);
  });

  it('prepare 返回 outcome-unknown 时要求人工恢复且不回滚前置事务', async () => {
    const runtime = new FakeApplyRuntime({ prepareUnknownAt: 1 });
    const plan: DesignPlan = {
      items: [
        { kind: 'node.create', target: '$dialog', params: { parentLogicalId: '$root', name: 'dialog' } },
        { kind: 'node.create', target: '$label', params: { parentLogicalId: '$dialog', name: 'label' } }
      ],
      risks: [], unresolved: []
    };

    const result = await applyDesignPlan(plan, runtime, {
      executionId: 'run-prepare-unknown', initialNodeResolutions: { '$root': 'uuid-root' }
    });

    expect(result.status).toBe('manual-recovery-required');
    expect(result.failedStep).toMatchObject({ code: 'DESIGN_PREPARE_OUTCOME_UNKNOWN' });
    expect(runtime.rolledBackTransactions).toEqual([]);
  });

  it('跨文档写入拒绝全 null revision', async () => {
    const runtime = new FakeApplyRuntime();
    const plan: DesignPlan = {
      items: [{ kind: 'node.create', target: '$dialog', params: { parentLogicalId: '$root', name: 'dialog' } }],
      risks: [], unresolved: []
    };

    await expect(applyDesignPlan(plan, runtime, {
      executionId: 'run-empty-revision',
      initialNodeResolutions: { '$root': 'uuid-root' },
      scope: 'source-prefab',
      revision: { document: null, hierarchy: null, assetDatabase: null, scriptCompilation: null, prefabGraph: null }
    })).rejects.toMatchObject({ code: 'DESIGN_REVISION_INCOMPLETE' });
    expect(runtime.requests).toHaveLength(0);
  });

  it('跨文档多步写入在每次提交后刷新 revision', async () => {
    const runtime = new FakeApplyRuntime();
    const plan: DesignPlan = {
      items: [
        { kind: 'node.delete', target: 'uuid-a', params: { targetUuid: 'uuid-a' } },
        {
          kind: 'prefab.apply_to_source',
          target: '$instance',
          params: {
            instanceRootLogicalId: '$instance',
            sourcePrefabAssetUuid: 'prefab-source'
          }
        }
      ],
      impactAnalysis: {
        sourceAssetUuid: 'prefab-source',
        sourceAssetPath: 'db://assets/source.prefab',
        affectedDocuments: [],
        totalInstanceCount: 0,
        overrideLayers: ['source-prefab'],
        risks: []
      },
      risks: [], unresolved: []
    };
    const initialRevision: RevisionPrecondition = {
      document: 'sha256:doc-0', hierarchy: 'sha256:hier-0',
      assetDatabase: null, scriptCompilation: null, prefabGraph: 'sha256:prefab-0'
    };

    const result = await applyDesignPlan(plan, runtime, {
      executionId: 'run-refresh-revision',
      initialNodeResolutions: { '$instance': 'uuid-instance-root' },
      scope: 'apply-to-source',
      revision: initialRevision
    });

    expect(result.status).toBe('committed');
    expect(runtime.requests.map((request) => request.revision.document)).toEqual([
      'sha256:doc-0', 'sha256:doc-1'
    ]);
  });

  it('apply-to-source 物化实例根 UUID 并携带影响分析和 prefabGraph revision', async () => {
    const runtime = new FakeApplyRuntime();
    const plan: DesignPlan = {
      items: [{
        kind: 'prefab.apply_to_source',
        target: '$instance',
        params: {
          instanceRootLogicalId: '$instance',
          sourcePrefabAssetUuid: 'prefab-source'
        }
      }],
      impactAnalysis: {
        sourceAssetUuid: 'prefab-source',
        sourceAssetPath: 'db://assets/source.prefab',
        affectedDocuments: [],
        totalInstanceCount: 0,
        overrideLayers: ['apply-to-source'],
        risks: []
      },
      risks: [],
      unresolved: []
    };

    const result = await applyDesignPlan(plan, runtime, {
      executionId: 'run-apply-source',
      initialNodeResolutions: { '$instance': 'uuid-instance-root' },
      scope: 'apply-to-source',
      revision: {
        document: 'sha256:doc-0',
        hierarchy: 'sha256:hier-0',
        assetDatabase: null,
        scriptCompilation: null,
        prefabGraph: 'sha256:prefab-0'
      }
    });

    expect(result.status).toBe('committed');
    expect(runtime.requests[0]).toMatchObject({
      scope: 'apply-to-source',
      revision: { prefabGraph: 'sha256:prefab-0' },
      impactAnalysis: { sourceAssetUuid: 'prefab-source' },
      operations: [{
        type: 'prefab.apply_to_source',
        instanceRootUuid: 'uuid-instance-root'
      }]
    });
  });

  it('apply-to-source 的计划源资产与影响分析不一致时零写入拒绝', async () => {
    const runtime = new FakeApplyRuntime();
    const plan: DesignPlan = {
      items: [{
        kind: 'prefab.apply_to_source',
        target: '$instance',
        params: {
          instanceRootLogicalId: '$instance',
          sourcePrefabAssetUuid: 'prefab-other'
        }
      }],
      impactAnalysis: {
        sourceAssetUuid: 'prefab-source',
        sourceAssetPath: 'db://assets/source.prefab',
        affectedDocuments: [],
        totalInstanceCount: 0,
        overrideLayers: ['apply-to-source'],
        risks: []
      },
      risks: [],
      unresolved: []
    };

    await expect(applyDesignPlan(plan, runtime, {
      executionId: 'run-impact-mismatch',
      initialNodeResolutions: { '$instance': 'uuid-instance-root' },
      scope: 'apply-to-source',
      revision: {
        document: 'sha256:doc-0',
        hierarchy: 'sha256:hier-0',
        assetDatabase: null,
        scriptCompilation: null,
        prefabGraph: 'sha256:prefab-0'
      }
    })).rejects.toMatchObject({ code: 'DESIGN_PREFAB_IMPACT_MISMATCH' });
    expect(runtime.requests).toHaveLength(0);
  });

  it('apply-to-source 作用域缺少最后的显式应用操作时零写入拒绝', async () => {
    const runtime = new FakeApplyRuntime();
    const plan: DesignPlan = {
      items: [{ kind: 'node.delete', target: 'uuid-a', params: { targetUuid: 'uuid-a' } }],
      impactAnalysis: {
        sourceAssetUuid: 'prefab-source',
        sourceAssetPath: 'db://assets/source.prefab',
        affectedDocuments: [],
        totalInstanceCount: 0,
        overrideLayers: ['apply-to-source'],
        risks: []
      },
      risks: [],
      unresolved: []
    };

    await expect(applyDesignPlan(plan, runtime, {
      executionId: 'run-missing-apply-source',
      scope: 'apply-to-source',
      revision: {
        document: 'sha256:doc-0',
        hierarchy: 'sha256:hier-0',
        assetDatabase: null,
        scriptCompilation: null,
        prefabGraph: 'sha256:prefab-0'
      }
    })).rejects.toMatchObject({ code: 'DESIGN_APPLY_TO_SOURCE_REQUIRED' });
    expect(runtime.requests).toHaveLength(0);
  });

  it('prefab.apply_to_source 禁止伪装成 current-document 写入', async () => {
    const runtime = new FakeApplyRuntime();
    const plan: DesignPlan = {
      items: [{
        kind: 'prefab.apply_to_source',
        target: '$instance',
        params: { instanceRootLogicalId: '$instance', sourcePrefabAssetUuid: 'prefab-source' }
      }],
      impactAnalysis: {
        sourceAssetUuid: 'prefab-source', sourceAssetPath: 'db://assets/source.prefab',
        affectedDocuments: [], totalInstanceCount: 0, overrideLayers: ['apply-to-source'], risks: []
      },
      risks: [], unresolved: []
    };

    await expect(applyDesignPlan(plan, runtime, {
      executionId: 'run-wrong-apply-scope',
      initialNodeResolutions: { '$instance': 'uuid-instance-root' },
      scope: 'current-document',
      revision: {
        document: 'sha256:doc-0', hierarchy: 'sha256:hier-0',
        assetDatabase: null, scriptCompilation: null, prefabGraph: 'sha256:prefab-0'
      }
    })).rejects.toMatchObject({ code: 'DESIGN_APPLY_SCOPE_REQUIRED' });
    expect(runtime.requests).toHaveLength(0);
  });

  it('刷新后的跨文档 revision 不完整时停止后续写入并回滚', async () => {
    const runtime = new FakeApplyRuntime({ incompleteCapturedRevision: true });
    const plan: DesignPlan = {
      items: [
        { kind: 'node.delete', target: 'uuid-a', params: { targetUuid: 'uuid-a' } },
        {
          kind: 'prefab.apply_to_source', target: '$instance',
          params: { instanceRootLogicalId: '$instance', sourcePrefabAssetUuid: 'prefab-source' }
        }
      ],
      impactAnalysis: {
        sourceAssetUuid: 'prefab-source', sourceAssetPath: 'db://assets/source.prefab',
        affectedDocuments: [], totalInstanceCount: 0, overrideLayers: ['apply-to-source'], risks: []
      },
      risks: [], unresolved: []
    };

    const result = await applyDesignPlan(plan, runtime, {
      executionId: 'run-incomplete-refresh',
      initialNodeResolutions: { '$instance': 'uuid-instance-root' },
      scope: 'apply-to-source',
      revision: {
        document: 'sha256:doc-0', hierarchy: 'sha256:hier-0',
        assetDatabase: null, scriptCompilation: null, prefabGraph: 'sha256:prefab-0'
      }
    });

    expect(result).toMatchObject({
      status: 'rolled-back',
      failedStep: { code: 'DESIGN_REVISION_INCOMPLETE' }
    });
    expect(runtime.requests).toHaveLength(1);
  });

  it('连续多个脚本等待逐个核对后才执行挂载', async () => {
    const runtime = new FakeApplyRuntime();
    const plan: DesignPlan = {
      items: [
        { kind: 'script.wait_for_compile', target: 'script-a', params: { scriptUuid: 'script-a' } },
        { kind: 'script.wait_for_compile', target: 'script-b', params: { scriptUuid: 'script-b' } }
      ],
      risks: [], unresolved: []
    };

    const result = await applyDesignPlan(plan, runtime, { executionId: 'run-script-waits' });

    expect(result.status).toBe('committed');
    expect(runtime.waitedScripts).toEqual(['script-a', 'script-b']);
  });

  it('confirm 返回其它事务 ID 时按结果未知处理', async () => {
    const runtime = new FakeApplyRuntime({ mismatchedConfirmAt: 0 });
    const plan: DesignPlan = {
      items: [{ kind: 'node.delete', target: 'uuid-a', params: { targetUuid: 'uuid-a' } }],
      risks: [], unresolved: []
    };

    const result = await applyDesignPlan(plan, runtime, { executionId: 'run-id-mismatch' });

    expect(result.status).toBe('manual-recovery-required');
    expect(result.failedStep).toMatchObject({ code: 'DESIGN_TRANSACTION_ID_MISMATCH' });
    expect(runtime.rolledBackTransactions).toEqual([]);
  });

  it('最新事务回滚结果未知时停止回滚更早的依赖事务', async () => {
    const runtime = new FakeApplyRuntime({
      failVerificationAt: 2,
      rollbackUnknownTransaction: 'run-rollback-unknown-003'
    });
    const plan: DesignPlan = {
      items: [
        { kind: 'node.create', target: '$dialog', params: { parentLogicalId: '$root', name: 'dialog' } },
        { kind: 'node.create', target: '$label', params: { parentLogicalId: '$dialog', name: 'label' } },
        { kind: 'node.create', target: '$never', params: { parentLogicalId: '$dialog', name: 'never' } }
      ],
      risks: [], unresolved: []
    };

    const result = await applyDesignPlan(plan, runtime, {
      executionId: 'run-rollback-unknown', initialNodeResolutions: { '$root': 'uuid-root' }
    });

    expect(result.status).toBe('manual-recovery-required');
    expect(runtime.rolledBackTransactions).toEqual(['run-rollback-unknown-003']);
  });
});

class FakeApplyRuntime implements DesignApplyRuntime {
  readonly requests: WriteTransactionRequest[] = [];
  readonly rolledBackTransactions: string[] = [];
  readonly waitedScripts: string[] = [];
  readonly confirmedTransactions: string[] = [];
  private prepareIndex = 0;
  private confirmIndex = 0;
  private verificationIndex = 0;
  private revisionIndex = 0;

  constructor(private readonly options: {
    failConfirmAt?: number;
    failVerificationAt?: number;
    dirtyRollbackTransaction?: string;
    outcomeUnknownAt?: number;
    prepareUnknownAt?: number;
    prepareStatusAt?: { index: number; status: WriteTransactionResult['status'] };
    confirmStatusAt?: { index: number; status: WriteTransactionResult['status'] };
    prepareCommittedDuplicateAt?: number;
    incompleteCapturedRevision?: boolean;
    captureScriptCompilation?: boolean;
    mismatchedConfirmAt?: number;
    mismatchedConfirmError?: 'committed-error' | 'confirm-error';
    rollbackUnknownTransaction?: string;
    mismatchedRollbackTransaction?: string;
    rollbackAuditDirtyTransaction?: string;
    failWaitForScript?: string;
    incompleteConfirmCoverageAt?: number;
  } = {}) {}

  async prepare(request: WriteTransactionRequest): Promise<WriteTransactionResult> {
    this.requests.push(request);
    const index = this.prepareIndex++;
    if (index === this.options.prepareUnknownAt) {
      return transactionResult(request.transactionId, 'outcome-unknown', 0);
    }
    if (index === this.options.prepareStatusAt?.index) {
      return transactionResult(request.transactionId, this.options.prepareStatusAt.status, 0);
    }
    if (index === this.options.prepareCommittedDuplicateAt) {
      return {
        ...transactionResult(request.transactionId, 'committed', request.operations.length),
        duplicateOf: request.transactionId
      };
    }
    return transactionResult(request.transactionId, 'validated', 0);
  }

  async confirm(transactionId: string): Promise<WriteTransactionResult> {
    const index = this.confirmIndex++;
    this.confirmedTransactions.push(transactionId);
    const operationCount = this.requests.find((request) => request.transactionId === transactionId)?.operations.length ?? 0;
    if (this.options.mismatchedConfirmError === 'committed-error') {
      throw new DesignApplyCommittedError(
        transactionResult(`${transactionId}-other`, 'committed', operationCount),
        '模拟 committed 审计失败'
      );
    }
    if (this.options.mismatchedConfirmError === 'confirm-error') {
      throw new DesignApplyConfirmError(
        transactionResult(`${transactionId}-other`, 'failed', 0),
        '模拟 confirm 审计失败'
      );
    }
    if (index === this.options.outcomeUnknownAt) {
      return transactionResult(transactionId, 'outcome-unknown', 0);
    }
    if (index === this.options.confirmStatusAt?.index) {
      return transactionResult(transactionId, this.options.confirmStatusAt.status, 0);
    }
    if (index === this.options.failConfirmAt) {
      return {
        ...transactionResult(transactionId, 'failed', 0),
        failure: { code: 'FAKE_CONFIRM_FAILURE', message: '模拟确认失败', operationIndex: 0 }
      };
    }
    if (index === this.options.mismatchedConfirmAt) {
      return transactionResult(`${transactionId}-other`, 'committed', 1);
    }
    if (index === this.options.incompleteConfirmCoverageAt) {
      return transactionResult(transactionId, 'committed', Math.max(0, operationCount - 1));
    }
    return transactionResult(transactionId, 'committed', operationCount);
  }

  async rollback(transactionId: string): Promise<WriteTransactionResult> {
    this.rolledBackTransactions.push(transactionId);
    if (transactionId === this.options.rollbackUnknownTransaction) {
      return transactionResult(transactionId, 'outcome-unknown', 1);
    }
    if (transactionId === this.options.mismatchedRollbackTransaction) {
      return {
        ...transactionResult(`${transactionId}-other`, 'rolled-back', 1),
        verification: null,
        rollbackEvidence: { attempted: true, succeeded: true, verifiedClean: true }
      };
    }
    if (transactionId === this.options.rollbackAuditDirtyTransaction) {
      throw new DesignApplyRollbackError({
        ...transactionResult(transactionId, 'rolled-back', 1),
        verification: null,
        rollbackEvidence: { attempted: true, succeeded: true, verifiedClean: false }
      }, '模拟 rollback 审计失败');
    }
    const verifiedClean = transactionId !== this.options.dirtyRollbackTransaction;
    return {
      ...transactionResult(transactionId, 'rolled-back', 1),
      verification: null,
      rollbackEvidence: { attempted: true, succeeded: true, verifiedClean }
    };
  }

  async resolveCreatedNode(logicalId: string): Promise<string | null> {
    const names: Record<string, string> = {
      '$dialog': 'uuid-dialog', '$label': 'uuid-label', '$button': 'uuid-button', '$never': 'uuid-never'
    };
    return names[logicalId] ?? null;
  }

  async resolveComponent(_nodeUuid: string, componentType: string): Promise<string | null> {
    return componentType === 'cc.Button' ? 'component-button' : `component-${componentType}`;
  }

  async verifyPlanItem(item: DesignPlanItem): Promise<DesignApplyVerificationItem> {
    const index = this.verificationIndex++;
    const expected = `${item.kind}:${item.target}`;
    if (index === this.options.failVerificationAt) {
      return { description: expected, expected, actual: 'mismatch', passed: false };
    }
    return { description: expected, expected, actual: expected, passed: true };
  }

  async waitForScript(scriptUuid: string): Promise<void> {
    this.waitedScripts.push(scriptUuid);
    if (scriptUuid === this.options.failWaitForScript) throw new Error(`WAIT_FAILED:${scriptUuid}`);
  }

  async captureRevision(): Promise<RevisionPrecondition> {
    this.revisionIndex += 1;
    if (this.options.incompleteCapturedRevision) {
      return {
        document: null, hierarchy: null,
        assetDatabase: null, scriptCompilation: null, prefabGraph: null
      };
    }
    return {
      document: `sha256:doc-${this.revisionIndex}`,
      hierarchy: `sha256:hier-${this.revisionIndex}`,
      assetDatabase: null,
      scriptCompilation: this.options.captureScriptCompilation
        ? `sha256:script-${this.revisionIndex}`
        : null,
      prefabGraph: `sha256:prefab-${this.revisionIndex}`
    };
  }
}

function createReferencePlan(): DesignPlan {
  return {
    items: [
      { kind: 'node.create', target: '$dialog', params: { parentLogicalId: '$root', name: 'dialog' } },
      { kind: 'node.create', target: '$label', params: { parentLogicalId: '$dialog', name: 'label' } },
      { kind: 'prefab.instantiate', target: '$button', params: { parentLogicalId: '$dialog', prefabAssetUuid: 'asset-button', name: 'button' } },
      {
        kind: 'component.set_reference', target: '$button', propertyPath: 'clickEvents[0].target',
        params: { componentType: 'cc.Button', resolveTo: '$label' }, dependsOn: ['$button', '$label']
      }
    ],
    risks: [], unresolved: []
  };
}

function transactionResult(
  transactionId: string,
  status: WriteTransactionResult['status'],
  executedOps: number
): WriteTransactionResult {
  return {
    transactionId,
    status,
    executedOps,
    verification: status === 'committed'
      ? {
          passed: true,
          verifiedAt: '2026-07-20T00:00:00.000Z',
          items: Array.from({ length: executedOps }, (_, operationIndex) => ({
            operationIndex,
            description: `operation-${operationIndex}`,
            expected: true,
            actual: true,
            passed: true
          }))
        }
      : null,
    failure: null,
    rollbackEvidence: null
  };
}
