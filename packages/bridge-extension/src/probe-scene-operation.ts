import { ProbeError } from './probe-errors';
import type { ProbeExecutionResult } from './probe-transaction';

interface ProbeSceneTransaction {
  transactionId: string;
  parentNodeUuid: string;
  probeName: string;
  operation: {
    type: 'create-save-rollback-probe';
    position: { x: 17; y: 23; z: 0 };
    component: 'cc.UITransform';
    verificationPauseMs: 2000;
  };
}

interface ProbeSceneDependencies {
  createNode: (options: Record<string, unknown>) => Promise<string>;
  createComponent: (options: { uuid: string; component: string }) => Promise<unknown>;
  setProperty: (options: Record<string, unknown>) => Promise<unknown>;
  queryNode: (uuid: string) => Promise<unknown>;
  saveScene: () => Promise<unknown>;
  delay: (milliseconds: number) => Promise<void>;
  undoSource: string;
  undo: () => Promise<void>;
  removeNode: (options: { uuid: string }) => Promise<unknown>;
}

export async function executeProbeSceneOperation(
  transaction: ProbeSceneTransaction,
  dependencies: ProbeSceneDependencies
): Promise<ProbeExecutionResult> {
  const createdNodeUuid = await dependencies.createNode({
    parent: transaction.parentNodeUuid,
    name: transaction.probeName,
    snapshot: true,
    position: transaction.operation.position
  });
  let created = await requireCreatedProbeNode(dependencies, createdNodeUuid, transaction.probeName);
  if (!hasComponent(created, transaction.operation.component)) {
    await dependencies.createComponent({
      uuid: createdNodeUuid,
      component: transaction.operation.component
    });
    created = await requireCreatedProbeNode(dependencies, createdNodeUuid, transaction.probeName);
  }
  const positionDump = readObject(created.position);
  if (!positionDump.type) {
    throw new ProbeError('PROBE_POSITION_DUMP_UNAVAILABLE', { createdNodeUuid });
  }
  await dependencies.setProperty({
    uuid: createdNodeUuid,
    path: 'position',
    dump: {
      ...positionDump,
      value: transaction.operation.position
    },
    record: false
  });
  created = await requireCreatedProbeNode(dependencies, createdNodeUuid, transaction.probeName);
  assertProbePosition(created, transaction.operation.position);

  await dependencies.saveScene();
  const saved = await requireCreatedProbeNode(dependencies, createdNodeUuid, transaction.probeName);
  await dependencies.delay(transaction.operation.verificationPauseMs);
  await dependencies.undo();

  let rollbackMethod: ProbeExecutionResult['rollbackMethod'] = 'undo';
  const afterUndo = await dependencies.queryNode(createdNodeUuid);
  if (afterUndo) {
    assertCreatedProbeNode(afterUndo, createdNodeUuid, transaction.probeName);
    await dependencies.removeNode({ uuid: createdNodeUuid });
    rollbackMethod = 'explicit-remove';
  }

  await dependencies.saveScene();
  const finalNode = await dependencies.queryNode(createdNodeUuid);
  if (finalNode) {
    throw new ProbeError('PROBE_ROLLBACK_FAILED', { createdNodeUuid });
  }

  return {
    status: 'rolled-back',
    createdNodeUuid,
    diskHashRestored: false,
    rollbackMethod,
    recoveryMethod: 'none',
    undoSource: dependencies.undoSource,
    before: { probeExists: false },
    created: summarizeProbeNode(created),
    saved: summarizeProbeNode(saved),
    rolledBack: { probeExists: false }
  };
}

/**
 * 确保回滚目标就是当前事务创建的固定探针节点。
 *
 * @param value Creator query-node 返回值。
 * @param expectedNodeUuid 当前事务记录的节点 UUID。
 * @param expectedProbeName prepare 阶段锁定的节点名称。
 */
export function assertCreatedProbeNode(
  value: unknown,
  expectedNodeUuid: string,
  expectedProbeName: string
): void {
  const node = readObject(value);
  const actualNodeUuid = readDumpString(node.uuid);
  const actualName = readDumpString(node.name);
  if (actualNodeUuid !== expectedNodeUuid || actualName !== expectedProbeName) {
    throw new ProbeError('PROBE_NODE_IDENTITY_MISMATCH', {
      expectedNodeUuid,
      expectedProbeName,
      actualNodeUuid,
      actualName
    });
  }
}

async function requireCreatedProbeNode(
  dependencies: ProbeSceneDependencies,
  createdNodeUuid: string,
  probeName: string
): Promise<Record<string, unknown>> {
  const value = await dependencies.queryNode(createdNodeUuid);
  if (!value) {
    throw new ProbeError('CREATED_PROBE_NODE_NOT_FOUND', { createdNodeUuid });
  }
  assertCreatedProbeNode(value, createdNodeUuid, probeName);
  return readObject(value);
}

function hasComponent(node: Record<string, unknown>, componentType: string): boolean {
  const components = Array.isArray(node.components)
    ? node.components
    : Array.isArray(node.__comps__) ? node.__comps__ : [];
  return components.some((component) => {
    const entry = readObject(component);
    return entry.type === componentType || readObject(entry.value).type === componentType;
  });
}

function summarizeProbeNode(node: Record<string, unknown>): Record<string, unknown> {
  const position = readDumpObject(node.position);
  return {
    probeExists: true,
    uuid: readDumpString(node.uuid),
    name: readDumpString(node.name),
    hasUITransform: hasComponent(node, 'cc.UITransform'),
    position
  };
}

function assertProbePosition(
  node: Record<string, unknown>,
  expected: { x: 17; y: 23; z: 0 }
): void {
  const actual = readDumpObject(node.position);
  if (actual.x !== expected.x || actual.y !== expected.y || actual.z !== expected.z) {
    throw new ProbeError('PROBE_POSITION_MISMATCH', { expected, actual });
  }
}

function readDumpString(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  const dump = readObject(value);
  return typeof dump.value === 'string' ? dump.value : null;
}

function readDumpObject(value: unknown): Record<string, unknown> {
  const dump = readObject(value);
  return readObject(dump.value ?? value);
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
