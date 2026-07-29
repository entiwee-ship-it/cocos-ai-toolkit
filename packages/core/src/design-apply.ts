import {
  ReferenceSchema,
  RevisionPreconditionSchema,
  WriteTransactionRequestSchema,
  WriteTransactionResultSchema,
  type DesignPlan,
  type DesignPlanItem,
  type PrefabImpactAnalysis,
  type Reference,
  type RevisionPrecondition,
  type WriteOperation,
  type WriteScope,
  type WriteTransactionRequest,
  type WriteTransactionResult
} from '@cocos-ai/protocol';

/** 声明式计划逐项重读验证结果。 */
export interface DesignApplyVerificationItem {
  description: string;
  expected: unknown;
  actual: unknown;
  passed: boolean;
}

/** 执行期解析上下文，供 Creator 重读验证定位真实对象。 */
export interface DesignApplyVerificationContext {
  nodeResolutions: Readonly<Record<string, string>>;
  componentResolutions: Readonly<Record<string, string>>;
  transactionResult: WriteTransactionResult | null;
}

/** 声明式执行器依赖的 Editor 写通道与重读能力。 */
export interface DesignApplyRuntime {
  prepare(request: WriteTransactionRequest): Promise<WriteTransactionResult>;
  confirm(transactionId: string): Promise<WriteTransactionResult>;
  rollback(transactionId: string): Promise<WriteTransactionResult>;
  resolveCreatedNode(
    logicalId: string,
    item: DesignPlanItem,
    result: WriteTransactionResult
  ): Promise<string | null>;
  resolveComponent(nodeUuid: string, componentType: string, expectCreated?: boolean): Promise<string | null>;
  verifyPlanItem(
    item: DesignPlanItem,
    context: DesignApplyVerificationContext
  ): Promise<DesignApplyVerificationItem>;
  refreshResolutions?(context: DesignApplyVerificationContext): Promise<{
    nodeResolutions?: Record<string, string>;
    componentResolutions?: Record<string, string>;
  }>;
  waitForScript?(scriptUuid: string): Promise<void>;
  captureRevision?(): Promise<RevisionPrecondition>;
}

/** 声明式执行选项。非当前文档作用域必须显式提供 revision。 */
export interface DesignApplyOptions {
  executionId: string;
  initialNodeResolutions?: Record<string, string>;
  scope?: WriteScope;
  revision?: RevisionPrecondition;
  save?: boolean;
  allowDirtyAfterFirstCommit?: boolean;
}

export interface DesignApplyFailedStep {
  index: number;
  kind: string;
  target: string;
  code: string;
  message: string;
}

export interface DesignApplyResult {
  executionId: string;
  status: 'committed' | 'failed' | 'rolled-back' | 'manual-recovery-required';
  executedSteps: number;
  transactions: WriteTransactionResult[];
  rollbackResults: WriteTransactionResult[];
  auditFailures: Array<{
    phase: 'prepare' | 'confirm' | 'rollback';
    transactionId: string;
    message: string;
  }>;
  failedStep: DesignApplyFailedStep | null;
  resolutions: {
    nodes: Record<string, string>;
    components: Record<string, string>;
  };
  verification: {
    passed: boolean;
    verifiedAt: string;
    items: DesignApplyVerificationItem[];
  };
}

/** 带稳定 code 的声明式执行错误，供 CLI 输出结构化失败。 */
export class DesignApplyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'DesignApplyError';
  }
}

/** runtime 已确认 Bridge committed，但后置处理失败时携带提交事实。 */
export class DesignApplyCommittedError extends DesignApplyError {
  constructor(
    readonly transactionResult: WriteTransactionResult,
    message: string
  ) {
    super('DESIGN_COMMITTED_POSTPROCESS_FAILED', message, transactionResult);
    this.name = 'DesignApplyCommittedError';
  }
}

/** confirm 已返回非 committed 协议结果，但后置审计失败。 */
export class DesignApplyConfirmError extends DesignApplyError {
  constructor(
    readonly transactionResult: WriteTransactionResult,
    message: string
  ) {
    super('DESIGN_CONFIRM_POSTPROCESS_FAILED', message, transactionResult);
    this.name = 'DesignApplyConfirmError';
  }
}

/** prepare 已返回 validated，但后置审计失败并留下待恢复锁。 */
export class DesignApplyPreparedError extends DesignApplyError {
  constructor(
    readonly transactionResult: WriteTransactionResult,
    message: string
  ) {
    super('DESIGN_PREPARED_POSTPROCESS_FAILED', message, transactionResult);
    this.name = 'DesignApplyPreparedError';
  }
}

/** rollback 已返回协议结果，但后置审计失败。 */
export class DesignApplyRollbackError extends DesignApplyError {
  constructor(
    readonly transactionResult: WriteTransactionResult,
    message: string
  ) {
    super('DESIGN_ROLLBACK_POSTPROCESS_FAILED', message, transactionResult);
    this.name = 'DesignApplyRollbackError';
  }
}

/** confirm 请求已发出但无法确认最终状态，需要人工恢复。 */
export class DesignApplyOutcomeUnknownError extends DesignApplyError {
  constructor(message: string) {
    super('DESIGN_CONFIRM_OUTCOME_UNKNOWN', message);
    this.name = 'DesignApplyOutcomeUnknownError';
  }
}

/** prepare 请求已发出但无法确认事务是否登记，需要先查询事务状态。 */
export class DesignApplyPrepareOutcomeUnknownError extends DesignApplyError {
  constructor(message: string) {
    super('DESIGN_PREPARE_OUTCOME_UNKNOWN', message);
    this.name = 'DesignApplyPrepareOutcomeUnknownError';
  }
}

interface ApplyState {
  nodeResolutions: Record<string, string>;
  componentResolutions: Record<string, string>;
  committedTransactionIds: string[];
  transactions: WriteTransactionResult[];
  rollbackResults: WriteTransactionResult[];
  verificationItems: DesignApplyVerificationItem[];
  outcomeUnknown: boolean;
  auditFailures: DesignApplyResult['auditFailures'];
  currentRevision: RevisionPrecondition;
}

interface PlanExecutionEntry {
  item: DesignPlanItem;
  index: number;
}

interface PlanExecutionGroup {
  category: string;
  entries: PlanExecutionEntry[];
}

class DesignApplyStepError extends DesignApplyError {
  constructor(
    readonly entry: PlanExecutionEntry,
    readonly cause: unknown
  ) {
    const failure = normalizeFailure(cause);
    super(failure.code, failure.message);
    this.name = 'DesignApplyStepError';
  }
}

const EMPTY_REVISION: RevisionPrecondition = {
  document: null,
  hierarchy: null,
  assetDatabase: null,
  scriptCompilation: null
};

const JOURNAL_SAFE_ID = /^[A-Za-z0-9._-]+$/;
const SUPPORTED_PLAN_KINDS = new Set([
  'node.create',
  'node.delete',
  'prefab.instantiate',
  'component.add',
  'component.remove',
  'component.set_property',
  'component.set_reference',
  'document.extract_subtree',
  'prefab.instance_override',
  'prefab.revert_override',
  'prefab.apply_to_source',
  'script.wait_for_compile'
]);
const KNOWN_FINAL_STATUSES = new Set(['committed', 'failed', 'rolled-back']);
const REVISION_DIMENSIONS = [
  'document', 'hierarchy', 'assetDatabase', 'scriptCompilation', 'prefabGraph'
] as const;

/**
 * 按顺序执行声明式计划并维护逻辑 ID 到 Creator UUID 的映射。
 *
 * 会产生新 UUID 的计划项保留事务边界；已有身份上的连续属性、引用和删除操作
 * 按阶段合并为原子事务。任一步写入或独立验证失败都会停止并逆序回滚。
 */
export async function applyDesignPlan(
  plan: DesignPlan,
  runtime: DesignApplyRuntime,
  options: DesignApplyOptions
): Promise<DesignApplyResult> {
  const groups = buildExecutionGroups(plan.items);
  validateApplyInput(plan, runtime, options, groups);
  const state: ApplyState = {
    nodeResolutions: { ...(options.initialNodeResolutions ?? {}) },
    componentResolutions: {},
    committedTransactionIds: [],
    transactions: [],
    rollbackResults: [],
    verificationItems: [],
    outcomeUnknown: false,
    auditFailures: [],
    currentRevision: RevisionPreconditionSchema.parse(options.revision ?? EMPTY_REVISION)
  };

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    try {
      const result = await executePlanGroup(group, plan.impactAnalysis, runtime, options, state);
      await refreshStateResolutions(runtime, state, result);
      for (const entry of group.entries) {
        const verification = await runtime.verifyPlanItem(entry.item, {
          nodeResolutions: state.nodeResolutions,
          componentResolutions: state.componentResolutions,
          transactionResult: result
        });
        state.verificationItems.push(verification);
        if (!verification.passed) {
          throw new DesignApplyStepError(entry, new DesignApplyError(
            'DESIGN_VERIFY_FAILED',
            `计划第 ${entry.index + 1} 步独立重读验证失败`,
            verification
          ));
        }
      }
      if (hasLaterWriteGroup(groups, groupIndex) && revisionIsActive(state.currentRevision)) {
        if (!runtime.captureRevision) {
          throw new DesignApplyError(
            'DESIGN_REVISION_REFRESH_UNAVAILABLE',
            '多事务计划缺少提交后的 revision 采集能力'
          );
        }
        const refreshedRevision = RevisionPreconditionSchema.parse(await runtime.captureRevision());
        validateRevisionForScope(refreshedRevision, options.scope ?? 'current-document');
        validatePreservedRevisionDimensions(state.currentRevision, refreshedRevision);
        state.currentRevision = refreshedRevision;
      }
    } catch (error) {
      if (error instanceof DesignApplyPreparedError) {
        state.transactions.push(WriteTransactionResultSchema.parse(error.transactionResult));
        state.outcomeUnknown = true;
        recordAuditFailure(state, 'prepare', error.transactionResult.transactionId, error.message);
      } else if (
        error instanceof DesignApplyOutcomeUnknownError
        || error instanceof DesignApplyPrepareOutcomeUnknownError
      ) {
        state.outcomeUnknown = true;
      }
      const failedEntry = selectFailedEntry(group, error);
      return failApply(
        failedEntry.item,
        failedEntry.index,
        error instanceof DesignApplyStepError ? error.cause : error,
        runtime,
        options.executionId,
        state
      );
    }
  }

  return createResult('committed', options.executionId, plan.items.length, null, state);
}

/**
 * 在任何 Editor 写请求前整体校验声明式计划的可执行边界。
 *
 * @param plan 已排序并附带影响分析的声明式计划。
 * @param runtime Editor 写通道与 revision 重读能力。
 * @param options 本次执行的作用域、revision 与稳定执行 ID。
 * @param groups 根据身份屏障划分的事务组。
 */
function validateApplyInput(
  plan: DesignPlan,
  runtime: DesignApplyRuntime,
  options: DesignApplyOptions,
  groups: PlanExecutionGroup[]
): void {
  if (!JOURNAL_SAFE_ID.test(options.executionId)) {
    throw new DesignApplyError('INVALID_DESIGN_EXECUTION_ID', 'executionId 只能包含字母、数字、点、下划线和连字符');
  }
  if (plan.unresolved.length > 0) {
    throw new DesignApplyError('DESIGN_PLAN_UNRESOLVED', '声明式计划包含未解析项，拒绝执行', plan.unresolved);
  }
  const unsupportedItem = plan.items.find((item) => !SUPPORTED_PLAN_KINDS.has(item.kind));
  if (unsupportedItem) {
    throw new DesignApplyError(
      'UNSUPPORTED_DESIGN_PLAN_ITEM',
      `不支持的声明式计划项：${unsupportedItem.kind}`,
      unsupportedItem
    );
  }
  const scope = options.scope ?? 'current-document';
  if (scope !== 'current-document' && !options.revision) {
    throw new DesignApplyError('DESIGN_REVISION_REQUIRED', `${scope} 作用域必须显式提供 revision`);
  }
  const revision = RevisionPreconditionSchema.parse(options.revision ?? EMPTY_REVISION);
  validateRevisionForScope(revision, scope);
  const applyItems = plan.items.filter((item) => item.kind === 'prefab.apply_to_source');
  if (applyItems.length > 0 && scope !== 'apply-to-source') {
    throw new DesignApplyError(
      'DESIGN_APPLY_SCOPE_REQUIRED',
      'prefab.apply_to_source 只能在 apply-to-source 作用域执行'
    );
  }
  if (scope === 'apply-to-source') {
    if (applyItems.length !== 1 || plan.items.at(-1) !== applyItems[0]) {
      throw new DesignApplyError(
        'DESIGN_APPLY_TO_SOURCE_REQUIRED',
        'apply-to-source 作用域要求计划最后恰好一个 prefab.apply_to_source 操作'
      );
    }
    const sourcePrefabAssetUuid = readString(applyItems[0].params, 'sourcePrefabAssetUuid');
    if (!sourcePrefabAssetUuid || plan.impactAnalysis?.sourceAssetUuid !== sourcePrefabAssetUuid) {
      throw new DesignApplyError(
        'DESIGN_PREFAB_IMPACT_MISMATCH',
        'prefab.apply_to_source 的源资产必须与影响分析一致'
      );
    }
  }
  const needsRevisionRefresh = groups.some((_group, index) => hasLaterWriteGroup(groups, index));
  if (needsRevisionRefresh && revisionIsActive(revision) && !runtime.captureRevision) {
    throw new DesignApplyError(
      'DESIGN_REVISION_REFRESH_UNAVAILABLE',
      '带 revision 的多事务计划要求 runtime.captureRevision'
    );
  }
}

/**
 * 执行一个已经按身份依赖划分好的原子事务组。
 *
 * @param group 同一阶段且可在提交前全部物化的计划项。
 * @param impactAnalysis 源 Prefab 写入所需影响分析。
 * @param runtime Editor 写通道与独立重读能力。
 * @param options 本次声明式执行的作用域、revision 与保存策略。
 * @param state 当前逻辑身份、事务、审计和验证状态。
 * @returns 写事务提交结果；脚本等待组没有写结果时返回 null。
 */
async function executePlanGroup(
  group: PlanExecutionGroup,
  impactAnalysis: PrefabImpactAnalysis | undefined,
  runtime: DesignApplyRuntime,
  options: DesignApplyOptions,
  state: ApplyState
): Promise<WriteTransactionResult | null> {
  const firstEntry = group.entries[0];
  if (!firstEntry) throw new DesignApplyError('DESIGN_PLAN_GROUP_EMPTY', '声明式事务组不能为空');
  if (group.category === 'script-wait') {
    if (!runtime.waitForScript) {
      throw new DesignApplyError('SCRIPT_WAIT_UNAVAILABLE', '当前运行时无法等待脚本编译');
    }
    for (const entry of group.entries) {
      const scriptUuid = readString(entry.item.params, 'scriptUuid') ?? entry.item.target;
      try {
        await runtime.waitForScript(scriptUuid);
      } catch (error) {
        throw new DesignApplyStepError(entry, error);
      }
    }
    return null;
  }

  await refreshStateResolutions(runtime, state, state.transactions.at(-1) ?? null);
  const operations: WriteOperation[] = [];
  for (const entry of group.entries) {
    try {
      operations.push(await materializeOperation(entry.item, runtime, state));
    } catch (error) {
      throw new DesignApplyStepError(entry, error);
    }
  }
  const transactionId = `${options.executionId}-${String(firstEntry.index + 1).padStart(3, '0')}`;
  const request = WriteTransactionRequestSchema.parse({
    transactionId,
    idempotencyKey: transactionId,
    scope: options.scope ?? 'current-document',
    revision: state.currentRevision,
    impactAnalysis,
    operations,
    save: options.save ?? true,
    ...(options.allowDirtyAfterFirstCommit === true && state.committedTransactionIds.length > 0
      ? { allowDirty: true }
      : {}),
    undoGroup: `design-apply-${options.executionId}`
  });

  const prepared = WriteTransactionResultSchema.parse(await runtime.prepare(request));
  assertTransactionId(prepared, transactionId, state);
  state.transactions.push(prepared);
  if (prepared.status === 'committed' && prepared.duplicateOf) {
    state.committedTransactionIds.push(transactionId);
    assertCommittedCoverage(prepared, operations.length);
    await refreshStateResolutions(runtime, state, prepared);
    await updateGroupResolutions(group, prepared, runtime, state);
    return prepared;
  }
  if (transactionOutcomeIsUncertain(prepared.status, 'validated')) {
    state.outcomeUnknown = true;
    throw new DesignApplyError(
      'DESIGN_PREPARE_OUTCOME_UNKNOWN',
      `prepare 返回结果未知状态：${prepared.status}`,
      prepared
    );
  }
  if (prepared.status !== 'validated') {
    throw transactionStateError('DESIGN_PREPARE_FAILED', 'prepare', prepared);
  }

  let confirmed: WriteTransactionResult;
  try {
    confirmed = WriteTransactionResultSchema.parse(await runtime.confirm(transactionId));
    assertTransactionId(confirmed, transactionId, state);
  } catch (error) {
    if (error instanceof DesignApplyCommittedError) {
      const committed = WriteTransactionResultSchema.parse(error.transactionResult);
      assertTransactionId(committed, transactionId, state);
      state.transactions.push(committed);
      state.committedTransactionIds.push(transactionId);
      recordAuditFailure(state, 'confirm', transactionId, error.message);
      assertCommittedCoverage(committed, operations.length);
    } else if (error instanceof DesignApplyConfirmError) {
      const result = WriteTransactionResultSchema.parse(error.transactionResult);
      assertTransactionId(result, transactionId, state);
      state.transactions.push(result);
      recordAuditFailure(state, 'confirm', transactionId, error.message);
      if (transactionOutcomeIsUncertain(result.status, 'committed')) state.outcomeUnknown = true;
    } else if (error instanceof DesignApplyOutcomeUnknownError) {
      state.outcomeUnknown = true;
    }
    throw error;
  }
  state.transactions.push(confirmed);
  if (transactionOutcomeIsUncertain(confirmed.status, 'committed')) {
    state.outcomeUnknown = true;
    throw new DesignApplyError(
      'DESIGN_CONFIRM_OUTCOME_UNKNOWN',
      `confirm 返回结果未知状态：${confirmed.status}`,
      confirmed
    );
  }
  if (confirmed.status !== 'committed' || !confirmed.verification?.passed) {
    throw transactionStateError('DESIGN_CONFIRM_FAILED', 'confirm', confirmed);
  }
  state.committedTransactionIds.push(transactionId);
  assertCommittedCoverage(confirmed, operations.length);
  await refreshStateResolutions(runtime, state, confirmed);
  await updateGroupResolutions(group, confirmed, runtime, state);
  return confirmed;
}

async function refreshStateResolutions(
  runtime: DesignApplyRuntime,
  state: ApplyState,
  transactionResult: WriteTransactionResult | null
): Promise<void> {
  if (!runtime.refreshResolutions) return;
  const refreshed = await runtime.refreshResolutions({
    nodeResolutions: state.nodeResolutions,
    componentResolutions: state.componentResolutions,
    transactionResult
  });
  Object.assign(state.nodeResolutions, refreshed.nodeResolutions ?? {});
  Object.assign(state.componentResolutions, refreshed.componentResolutions ?? {});
}

/**
 * 提交后按原始计划项顺序更新新建节点与组件的真实身份。
 *
 * @param group 已提交的事务组。
 * @param result Bridge 返回的 committed 结果。
 * @param runtime 用于重读 Creator 新身份的运行时。
 * @param state 当前声明式执行状态。
 */
async function updateGroupResolutions(
  group: PlanExecutionGroup,
  result: WriteTransactionResult,
  runtime: DesignApplyRuntime,
  state: ApplyState
): Promise<void> {
  for (const entry of group.entries) {
    try {
      await updateResolutions(entry.item, result, runtime, state);
    } catch (error) {
      throw new DesignApplyStepError(entry, error);
    }
  }
}

/**
 * 把单个声明式计划项物化为 Creator 原子写操作。
 *
 * @param item 当前待执行的声明式计划项。
 * @param runtime 用于按编辑器当前状态解析组件身份的运行时。
 * @param state 当前逻辑 ID、组件 UUID 与事务状态。
 * @returns 已把逻辑身份替换为真实 Creator UUID 的原子写操作。
 */
async function materializeOperation(
  item: DesignPlanItem,
  runtime: DesignApplyRuntime,
  state: ApplyState
): Promise<WriteOperation> {
  const params = item.params;
  switch (item.kind) {
    case 'node.create':
      return {
        type: 'node.create',
        parentNodeUuid: requireNodeResolution(readString(params, 'parentLogicalId') ?? readString(params, 'parentNodeUuid'), state),
        name: requireString(params, 'name'),
        ...(readNumber(params, 'layer') === undefined ? {} : { layer: readNumber(params, 'layer') }),
        ...(readBoolean(params, 'active') === undefined ? {} : { active: readBoolean(params, 'active') })
      };
    case 'node.delete':
      return { type: 'node.delete', nodeUuid: requireTargetNode(item, state) };
    case 'prefab.instantiate': {
      const name = readString(params, 'name');
      return {
        type: 'prefab.instantiate',
        prefabAssetUuid: requireString(params, 'prefabAssetUuid'),
        parentNodeUuid: requireNodeResolution(readString(params, 'parentLogicalId') ?? readString(params, 'parentNodeUuid'), state),
        ...(name ? { name } : {})
      };
    }
    case 'component.add':
      return {
        type: 'component.add',
        nodeUuid: requireTargetNode(item, state),
        componentType: requireString(params, 'componentType'),
        scriptUuid: readNullableString(params, 'scriptUuid')
      };
    case 'component.remove':
      return {
        type: 'component.remove',
        componentUuid: await requireComponentResolution(item, runtime, state)
      };
    case 'component.set_property':
      return {
        type: 'component.set_property',
        componentUuid: await requireComponentResolution(item, runtime, state),
        propertyPath: requirePropertyPath(item),
        value: item.value,
        ...(hasOwn(params, 'expectedOldValue') ? { expectedOldValue: params?.expectedOldValue } : {})
      };
    case 'component.set_reference':
      return {
        type: 'component.set_reference',
        componentUuid: await requireComponentResolution(item, runtime, state),
        propertyPath: requirePropertyPath(item),
        reference: materializeReference(params, state)
      };
    case 'document.extract_subtree':
      return {
        type: 'prefab.create_from_node',
        nodeUuid: requireNodeResolution(
          readString(params, 'nodeLogicalId') ?? readString(params, 'nodeUuid') ?? item.target,
          state
        ),
        assetUrl: requireString(params, 'assetUrl')
      };
    case 'prefab.instance_override': {
      const targetNodePath = readString(params, 'targetNodePath');
      const overrideValue = hasOwn(params, 'resolveTo') || hasOwn(params, 'reference')
        ? materializeReference(params, state)
        : item.value;
      return {
        type: 'prefab.instance_override',
        instanceRootUuid: requireNodeResolution(requireString(params, 'instanceRootLogicalId'), state),
        targetObjectUuid: await requireOverrideTargetObject(item, runtime, state),
        ...(targetNodePath ? { targetNodePath } : {}),
        propertyPath: requirePropertyPath(item),
        value: overrideValue
      };
    }
    case 'prefab.revert_override': {
      const targetNodePath = readString(params, 'targetNodePath');
      return {
        type: 'prefab.revert_override',
        instanceRootUuid: requireNodeResolution(requireString(params, 'instanceRootLogicalId'), state),
        targetObjectUuid: await requireOverrideTargetObject(item, runtime, state),
        ...(targetNodePath ? { targetNodePath } : {}),
        propertyPath: requirePropertyPath(item)
      };
    }
    case 'prefab.apply_to_source':
      return {
        type: 'prefab.apply_to_source',
        instanceRootUuid: requireNodeResolution(
          readString(params, 'instanceRootLogicalId') ?? readString(params, 'instanceRootUuid') ?? item.target,
          state
        )
      };
    default:
      throw new DesignApplyError('UNSUPPORTED_DESIGN_PLAN_ITEM', `不支持的声明式计划项：${item.kind}`, item);
  }
}

async function updateResolutions(
  item: DesignPlanItem,
  result: WriteTransactionResult,
  runtime: DesignApplyRuntime,
  state: ApplyState
): Promise<void> {
  if ((item.kind === 'node.create' || item.kind === 'prefab.instantiate') && item.target.startsWith('$')) {
    const nodeUuid = await runtime.resolveCreatedNode(item.target, item, result);
    if (!nodeUuid) {
      throw new DesignApplyError('CREATED_NODE_NOT_FOUND', `提交后无法重读新建节点：${item.target}`);
    }
    state.nodeResolutions[item.target] = nodeUuid;
  }
  if (item.kind === 'component.add') {
    const nodeUuid = requireTargetNode(item, state);
    const componentType = requireString(item.params, 'componentType');
    const componentUuid = await runtime.resolveComponent(nodeUuid, componentType, true);
    if (!componentUuid) {
      throw new DesignApplyError('CREATED_COMPONENT_NOT_FOUND', `提交后无法重读组件：${componentType}`);
    }
    state.componentResolutions[componentResolutionKey(item.target, componentType)] = componentUuid;
  }
}

async function requireComponentResolution(
  item: DesignPlanItem,
  runtime: DesignApplyRuntime,
  state: ApplyState
): Promise<string> {
  const directUuid = readString(item.params, 'componentUuid');
  if (directUuid) return directUuid;
  const componentType = requireString(item.params, 'componentType');
  const nodeUuid = requireTargetNode(item, state);
  const key = componentResolutionKey(item.target, componentType);
  const cached = state.componentResolutions[key];
  if (cached) return cached;
  const resolved = await runtime.resolveComponent(nodeUuid, componentType, false);
  if (!resolved) {
    throw new DesignApplyError('COMPONENT_NOT_FOUND', `无法解析组件：${item.target} / ${componentType}`);
  }
  state.componentResolutions[key] = resolved;
  return resolved;
}

function materializeReference(params: DesignPlanItem['params'], state: ApplyState): Reference | Reference[] {
  const resolveTo = readString(params, 'resolveTo');
  if (resolveTo) {
    return materializeLogicalNodeReference(resolveTo, state);
  }
  return materializeReferenceValue(params?.reference, state);
}

async function requireOverrideTargetObject(
  item: DesignPlanItem,
  runtime: DesignApplyRuntime,
  state: ApplyState
): Promise<string> {
  const directUuid = readString(item.params, 'targetObjectUuid');
  if (directUuid) return directUuid;
  const componentType = readString(item.params, 'componentType');
  if (componentType) return requireComponentResolution(item, runtime, state);
  return requireNodeResolution(
    readString(item.params, 'targetObjectLogicalId')
      ?? readString(item.params, 'targetNodeLogicalId')
      ?? item.target,
    state
  );
}

function materializeReferenceValue(value: unknown, state: ApplyState): Reference | Reference[] {
  if (Array.isArray(value)) {
    return value.map((item) => {
      const materialized = materializeReferenceValue(item, state);
      if (Array.isArray(materialized)) {
        throw new DesignApplyError('INVALID_REFERENCE_ARRAY', '引用数组不能嵌套数组');
      }
      return materialized;
    });
  }
  if (typeof value === 'string' && value.startsWith('$')) {
    return materializeLogicalNodeReference(value, state);
  }
  return ReferenceSchema.parse(value);
}

function materializeLogicalNodeReference(logicalId: string, state: ApplyState): Reference {
  return {
    kind: 'node',
    objectUuid: requireNodeResolution(logicalId, state),
    fileId: null,
    nodePath: null,
    available: true
  };
}

async function failApply(
  item: DesignPlanItem,
  index: number,
  error: unknown,
  runtime: DesignApplyRuntime,
  executionId: string,
  state: ApplyState
): Promise<DesignApplyResult> {
  const failure = normalizeFailure(error);
  const rollbackClean = state.outcomeUnknown ? false : await rollbackCommitted(runtime, state);
  const status = state.outcomeUnknown
    ? 'manual-recovery-required'
    : state.committedTransactionIds.length === 0
      ? 'failed'
      : rollbackClean ? 'rolled-back' : 'manual-recovery-required';
  return createResult(status, executionId, index, {
    index,
    kind: item.kind,
    target: item.target,
    ...failure
  }, state);
}

async function rollbackCommitted(runtime: DesignApplyRuntime, state: ApplyState): Promise<boolean> {
  let clean = true;
  for (const transactionId of [...state.committedTransactionIds].reverse()) {
    try {
      const result = WriteTransactionResultSchema.parse(await runtime.rollback(transactionId));
      state.rollbackResults.push(result);
      assertTransactionId(result, transactionId, state);
      const resultClean = rollbackResultIsClean(result);
      clean = resultClean && clean;
      if (!resultClean) {
        if (transactionOutcomeIsUncertain(result.status, 'rolled-back')) state.outcomeUnknown = true;
        break;
      }
    } catch (error) {
      if (error instanceof DesignApplyRollbackError) {
        const result = WriteTransactionResultSchema.parse(error.transactionResult);
        state.rollbackResults.push(result);
        recordAuditFailure(state, 'rollback', transactionId, error.message);
        try {
          assertTransactionId(result, transactionId, state);
        } catch {
          clean = false;
          break;
        }
        const resultClean = rollbackResultIsClean(result);
        clean = resultClean && clean;
        if (transactionOutcomeIsUncertain(result.status, 'rolled-back')) state.outcomeUnknown = true;
      } else {
        clean = false;
        state.outcomeUnknown = true;
      }
      break;
    }
  }
  return clean;
}

function createResult(
  status: DesignApplyResult['status'],
  executionId: string,
  executedSteps: number,
  failedStep: DesignApplyFailedStep | null,
  state: ApplyState
): DesignApplyResult {
  return {
    executionId,
    status,
    executedSteps,
    transactions: state.transactions,
    rollbackResults: state.rollbackResults,
    auditFailures: state.auditFailures,
    failedStep,
    resolutions: {
      nodes: { ...state.nodeResolutions },
      components: { ...state.componentResolutions }
    },
    verification: {
      passed: status === 'committed' && state.verificationItems.every((item) => item.passed),
      verifiedAt: new Date().toISOString(),
      items: state.verificationItems
    }
  };
}

function rollbackResultIsClean(result: WriteTransactionResult): boolean {
  const evidence = result.rollbackEvidence;
  return result.status === 'rolled-back'
    && evidence?.attempted === true
    && evidence.succeeded === true
    && evidence.verifiedClean === true;
}

function recordAuditFailure(
  state: ApplyState,
  phase: DesignApplyResult['auditFailures'][number]['phase'],
  transactionId: string,
  message: string
): void {
  state.auditFailures.push({ phase, transactionId, message });
}

function transactionStateError(code: string, phase: string, result: WriteTransactionResult): DesignApplyError {
  const message = result.failure?.message ?? `${phase} 返回非预期状态：${result.status}`;
  return new DesignApplyError(code, message, result);
}

function normalizeFailure(error: unknown): Pick<DesignApplyFailedStep, 'code' | 'message'> {
  if (error instanceof DesignApplyError) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: 'DESIGN_APPLY_FAILED', message: error.message };
  return { code: 'DESIGN_APPLY_FAILED', message: String(error) };
}

function requireTargetNode(item: DesignPlanItem, state: ApplyState): string {
  return requireNodeResolution(readString(item.params, 'targetUuid') ?? item.target, state);
}

function requireNodeResolution(identity: string | null, state: ApplyState): string {
  if (!identity) throw new DesignApplyError('NODE_IDENTITY_REQUIRED', '计划项缺少节点身份');
  if (!identity.startsWith('$')) return identity;
  const resolved = state.nodeResolutions[identity];
  if (!resolved) throw new DesignApplyError('NODE_NOT_RESOLVED', `逻辑节点尚未物化：${identity}`);
  return resolved;
}

function requirePropertyPath(item: DesignPlanItem): string {
  if (!item.propertyPath) throw new DesignApplyError('PROPERTY_PATH_REQUIRED', `${item.kind} 缺少 propertyPath`);
  return item.propertyPath;
}

function requireString(params: DesignPlanItem['params'], key: string): string {
  const value = readString(params, key);
  if (!value) throw new DesignApplyError('DESIGN_PLAN_PARAM_REQUIRED', `计划项缺少字符串参数：${key}`);
  return value;
}

function readString(params: DesignPlanItem['params'], key: string): string | null {
  const value = params?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNullableString(params: DesignPlanItem['params'], key: string): string | null {
  const value = params?.[key];
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.length > 0) return value;
  throw new DesignApplyError('INVALID_DESIGN_PLAN_PARAM', `计划项参数 ${key} 必须为字符串或 null`);
}

function readNumber(params: DesignPlanItem['params'], key: string): number | undefined {
  const value = params?.[key];
  return typeof value === 'number' ? value : undefined;
}

function readBoolean(params: DesignPlanItem['params'], key: string): boolean | undefined {
  const value = params?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function hasOwn(params: DesignPlanItem['params'], key: string): boolean {
  return params !== undefined && Object.prototype.hasOwnProperty.call(params, key);
}

function componentResolutionKey(target: string, componentType: string): string {
  return `${target}::${componentType}`;
}

function revisionIsActive(revision: RevisionPrecondition): boolean {
  return Object.values(revision).some((value) => value !== null && value !== undefined);
}

/**
 * 刷新 revision 时保留此前已启用的并发控制维度。
 *
 * @param previous 上一事务或初始写入使用的 revision。
 * @param refreshed Editor 提交或脚本等待后重新采集的 revision。
 */
function validatePreservedRevisionDimensions(
  previous: RevisionPrecondition,
  refreshed: RevisionPrecondition
): void {
  const dropped = REVISION_DIMENSIONS.filter((dimension) => (
    previous[dimension] !== null
    && previous[dimension] !== undefined
    && (refreshed[dimension] === null || refreshed[dimension] === undefined)
  ));
  if (dropped.length > 0) {
    throw new DesignApplyError(
      'DESIGN_REVISION_DIMENSION_DROPPED',
      `revision 刷新丢失已启用维度：${dropped.join('、')}`,
      { dropped }
    );
  }
}

/**
 * 判断事务结果是否仍可能继续变化，不能按确定失败推进回滚。
 *
 * @param status Bridge 返回的事务状态。
 * @param expected 当前阶段唯一允许推进的状态。
 * @returns 非预期且非已知终态时返回 true。
 */
function transactionOutcomeIsUncertain(
  status: WriteTransactionResult['status'],
  expected: 'validated' | 'committed' | 'rolled-back'
): boolean {
  return status !== expected && !KNOWN_FINAL_STATUSES.has(status);
}

/**
 * 确认 committed 结果覆盖事务内的全部原子操作和验证明细。
 *
 * @param result Bridge 返回的 committed 结果。
 * @param operationCount 当前事务请求中的原子操作数。
 */
function assertCommittedCoverage(result: WriteTransactionResult, operationCount: number): void {
  const coveredOperations = new Set(result.verification?.items.map((item) => item.operationIndex) ?? []);
  const coversEveryOperation = Array.from(
    { length: operationCount },
    (_value, operationIndex) => coveredOperations.has(operationIndex)
  ).every(Boolean);
  if (result.executedOps === operationCount && coversEveryOperation) return;
  throw new DesignApplyError(
    'DESIGN_CONFIRM_COVERAGE_MISMATCH',
    `committed 结果未覆盖全部操作：执行 ${result.executedOps}/${operationCount}，验证 ${coveredOperations.size}/${operationCount}`,
    result
  );
}

/**
 * 校验当前作用域要求的 revision 维度，初始与事务后刷新共用同一门禁。
 *
 * @param revision 待用于下一事务的五维 revision。
 * @param scope 下一事务的写入作用域。
 */
function validateRevisionForScope(revision: RevisionPrecondition, scope: WriteScope): void {
  if (scope === 'current-document') return;
  if (!revision.document || !revision.hierarchy || !revision.prefabGraph) {
    throw new DesignApplyError(
      'DESIGN_REVISION_INCOMPLETE',
      `${scope} 作用域要求非空的 document、hierarchy 与 prefabGraph 指纹`
    );
  }
}

/**
 * 确认 Bridge 结果属于当前请求事务，错配时按最终状态未知处理。
 *
 * @param result Bridge 返回且已通过协议校验的事务结果。
 * @param expectedTransactionId 当前请求使用的事务 ID。
 * @param state 当前声明式执行状态。
 */
function assertTransactionId(
  result: WriteTransactionResult,
  expectedTransactionId: string,
  state: ApplyState
): void {
  if (result.transactionId === expectedTransactionId) return;
  state.outcomeUnknown = true;
  throw new DesignApplyError(
    'DESIGN_TRANSACTION_ID_MISMATCH',
    `Bridge 返回事务 ID ${result.transactionId}，预期 ${expectedTransactionId}`,
    result
  );
}

/**
 * 按执行期身份屏障把有序计划划分为原子事务组。
 *
 * @param items 已完成拓扑排序的声明式计划项。
 * @returns 保留原始计划下标的有序事务组。
 */
function buildExecutionGroups(items: DesignPlanItem[]): PlanExecutionGroup[] {
  const groups: PlanExecutionGroup[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const category = executionGroupCategory(item, index);
    const previous = groups.at(-1);
    const writeKey = planItemWriteKey(item);
    const repeatsWriteKey = writeKey !== null
      && previous?.entries.some((entry) => planItemWriteKey(entry.item) === writeKey);
    if (previous && previous.category === category && !repeatsWriteKey) {
      previous.entries.push({ item, index });
    } else {
      groups.push({ category, entries: [{ item, index }] });
    }
  }
  return groups;
}

/**
 * 读取会在最终状态上互相覆盖的组件属性写键。
 *
 * @param item 当前声明式计划项。
 * @returns 组件身份与属性路径组成的键；非属性或引用写返回 null。
 */
function planItemWriteKey(item: DesignPlanItem): string | null {
  if (item.kind !== 'component.set_property'
    && item.kind !== 'component.set_reference'
    && item.kind !== 'prefab.instance_override'
    && item.kind !== 'prefab.revert_override') return null;
  const componentIdentity = readString(item.params, 'componentUuid')
    ?? `${item.target}::${readString(item.params, 'componentType') ?? ''}`;
  return `${componentIdentity}::${item.propertyPath ?? ''}`;
}

/**
 * 读取单个计划项的事务分组类别。
 *
 * @param item 待读取类别的计划项。
 * @param index 计划项在完整计划中的稳定下标。
 * @returns 可合并阶段名，或带下标的独立身份屏障名。
 */
function executionGroupCategory(item: DesignPlanItem, index: number): string {
  if (item.kind === 'script.wait_for_compile') return 'script-wait';
  if (item.kind === 'component.set_property'
    && readString(item.params, 'componentType') === 'cc.UITransform'
    && item.propertyPath === 'contentSize') {
    return 'layout-final';
  }
  if (item.kind === 'component.set_property'
    || item.kind === 'component.set_reference'
    || item.kind === 'prefab.instance_override'
    || item.kind === 'prefab.revert_override') {
    return 'property-reference';
  }
  if (item.kind === 'node.delete' || item.kind === 'component.remove') return 'destructive';
  // 创建、实例化、挂组件和应用到源都会改变后续身份或作用域，必须保留提交边界。
  return `identity-barrier:${index}`;
}

/**
 * 从事务失败明细或物化错误中定位真正失败的计划项。
 *
 * @param group 当前正在执行的事务组。
 * @param error prepare、confirm、物化或验证阶段抛出的错误。
 * @returns 应写入 failedStep 的原始计划项与下标。
 */
function selectFailedEntry(group: PlanExecutionGroup, error: unknown): PlanExecutionEntry {
  if (error instanceof DesignApplyStepError) return error.entry;
  if (error instanceof DesignApplyError && error.details && typeof error.details === 'object') {
    const operationIndex = (error.details as WriteTransactionResult).failure?.operationIndex;
    if (typeof operationIndex === 'number' && group.entries[operationIndex]) {
      return group.entries[operationIndex];
    }
  }
  const firstEntry = group.entries[0];
  if (!firstEntry) throw new DesignApplyError('DESIGN_PLAN_GROUP_EMPTY', '声明式事务组不能为空');
  return firstEntry;
}

/** 判断当前事务组之后是否仍有写事务，用于决定是否刷新 revision。 */
function hasLaterWriteGroup(groups: PlanExecutionGroup[], currentIndex: number): boolean {
  return groups.slice(currentIndex + 1).some((group) => group.category !== 'script-wait');
}
