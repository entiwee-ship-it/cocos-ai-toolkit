import { ProbeError } from './probe-errors';
import type { WriteOperation } from './transaction-manager';

/** 节点写操作的可序列化证据快照。 */
export interface NodeInfo {
  uuid: string;
  name: string;
  active: boolean;
  layer: number;
  parentUuid: string | null;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  scale: { x: number; y: number; z: number };
}

export interface NodeLocalTransform {
  position?: { x: number; y: number; z: number };
  rotation?: { x: number; y: number; z: number; w: number };
  scale?: { x: number; y: number; z: number };
}

/**
 * 节点写依赖。全部由 Scene 进程真实能力注入（消息 API 或运行时对象），
 * 本模块只做编排，不直接触碰 Editor 全局对象或磁盘文件。
 */
export interface NodeWriterDependencies {
  getNodeInfo(uuid: string): Promise<NodeInfo | null>;
  listAncestors(uuid: string): Promise<string[]>;
  createNode(parentUuid: string, name: string): Promise<string>;
  removeNode(uuid: string): Promise<void>;
  renameNode(uuid: string, name: string): Promise<void>;
  setNodeActive(uuid: string, active: boolean): Promise<void>;
  setNodeLayer(uuid: string, layer: number): Promise<void>;
  setNodeTransform(uuid: string, transform: NodeLocalTransform): Promise<void>;
  reparentNode(uuid: string, newParentUuid: string, siblingIndex?: number): Promise<void>;
  /** 复制整个子树（含组件与引用），返回新节点 UUID；失败返回 null。 */
  duplicateNode(uuid: string): Promise<string | null>;
}

export interface NodeWriteOpResult {
  nodeUuid: string;
  before: Partial<NodeInfo> | null;
  after: Partial<NodeInfo> | null;
  /**
   * 显式逆操作序列，供 step-undo-with-inverse 回滚路径使用。
   * 空数组表示该操作无法用逆操作还原（如 delete 丢子树），回滚必须依赖编辑器 Undo。
   */
  inverse: WriteOperation[];
}

/**
 * 执行单个节点原子写操作，返回 before/after 证据和显式逆操作。
 * 只允许在事务上下文内由写执行器调用；非法目标抛稳定错误码，不留下半成品。
 *
 * @param operation 节点写操作（node.* 八类之一）。
 * @param dependencies Scene 侧真实能力。
 * @returns 写操作证据。
 */
export async function executeNodeWriteOperation(
  operation: WriteOperation,
  dependencies: NodeWriterDependencies
): Promise<NodeWriteOpResult> {
  switch (operation.type) {
    case 'node.create':
      return createNode(operation, dependencies);
    case 'node.delete':
      return deleteNode(operation, dependencies);
    case 'node.rename':
      return renameNode(operation, dependencies);
    case 'node.reparent':
      return reparentNode(operation, dependencies);
    case 'node.duplicate':
      return duplicateNode(operation, dependencies);
    case 'node.set_active':
      return setNodeActive(operation, dependencies);
    case 'node.set_layer':
      return setNodeLayer(operation, dependencies);
    case 'node.set_transform':
      return setNodeTransform(operation, dependencies);
    default:
      throw new ProbeError('INVALID_WRITE_OPERATION', { type: operation.type });
  }
}

/**
 * 按事务内顺序执行多个节点写操作。任一操作失败即停止，错误 details 携带
 * operationIndex 和已完成操作的逆操作（completedInverse），供执行器构造回滚计划。
 *
 * @param operations 节点写操作序列。
 * @param dependencies Scene 侧真实能力。
 * @returns 每个操作的证据，顺序与输入一致。
 */
export async function executeNodeWriteOperations(
  operations: WriteOperation[],
  dependencies: NodeWriterDependencies
): Promise<NodeWriteOpResult[]> {
  const results: NodeWriteOpResult[] = [];
  for (let index = 0; index < operations.length; index += 1) {
    try {
      results.push(await executeNodeWriteOperation(operations[index], dependencies));
    } catch (error) {
      const probeError = error instanceof ProbeError
        ? error
        : new ProbeError(readReason(error));
      throw new ProbeError(probeError.code, {
        ...probeError.details,
        operationIndex: index,
        completedInverse: results.map((result) => result.inverse)
      });
    }
  }
  return results;
}

async function createNode(
  operation: WriteOperation,
  dependencies: NodeWriterDependencies
): Promise<NodeWriteOpResult> {
  const parentNodeUuid = operation.parentNodeUuid as string;
  const parent = await dependencies.getNodeInfo(parentNodeUuid);
  if (!parent) {
    throw new ProbeError('NODE_PARENT_NOT_FOUND', { parentNodeUuid });
  }
  const name = operation.name as string;
  const nodeUuid = await dependencies.createNode(parentNodeUuid, name);
  try {
    if (typeof operation.layer === 'number') {
      await dependencies.setNodeLayer(nodeUuid, operation.layer);
    }
    if (typeof operation.active === 'boolean') {
      await dependencies.setNodeActive(nodeUuid, operation.active);
    }
  } catch (error) {
    // 创建后的可选属性设置失败时清理新节点，不留半成品。
    await dependencies.removeNode(nodeUuid);
    throw error;
  }
  return {
    nodeUuid,
    before: null,
    after: await requireNodeInfo(dependencies, nodeUuid),
    inverse: [{ type: 'node.delete', nodeUuid }]
  };
}

async function deleteNode(
  operation: WriteOperation,
  dependencies: NodeWriterDependencies
): Promise<NodeWriteOpResult> {
  const nodeUuid = operation.nodeUuid as string;
  const before = await requireNodeInfo(dependencies, nodeUuid);
  await dependencies.removeNode(nodeUuid);
  return { nodeUuid, before, after: null, inverse: [] };
}

async function renameNode(
  operation: WriteOperation,
  dependencies: NodeWriterDependencies
): Promise<NodeWriteOpResult> {
  const nodeUuid = operation.nodeUuid as string;
  const before = await requireNodeInfo(dependencies, nodeUuid);
  const name = operation.name as string;
  // Creator 允许同级重名，不做额外拦截；证据里保留新旧名称供重读验证。
  await dependencies.renameNode(nodeUuid, name);
  const after = await requireNodeInfo(dependencies, nodeUuid);
  return {
    nodeUuid,
    before: { uuid: nodeUuid, name: before.name },
    after: { uuid: nodeUuid, name: after.name },
    inverse: [{ type: 'node.rename', nodeUuid, name: before.name }]
  };
}

async function reparentNode(
  operation: WriteOperation,
  dependencies: NodeWriterDependencies
): Promise<NodeWriteOpResult> {
  const nodeUuid = operation.nodeUuid as string;
  const newParentUuid = operation.newParentUuid as string;
  const before = await requireNodeInfo(dependencies, nodeUuid);
  if (newParentUuid === nodeUuid) {
    throw new ProbeError('REPARENT_CYCLE', { nodeUuid, newParentUuid });
  }
  const ancestors = await dependencies.listAncestors(newParentUuid);
  if (ancestors.includes(nodeUuid)) {
    throw new ProbeError('REPARENT_CYCLE', { nodeUuid, newParentUuid });
  }
  if (!await dependencies.getNodeInfo(newParentUuid)) {
    throw new ProbeError('NODE_PARENT_NOT_FOUND', { parentNodeUuid: newParentUuid });
  }
  const siblingIndex = typeof operation.siblingIndex === 'number' ? operation.siblingIndex : undefined;
  await dependencies.reparentNode(nodeUuid, newParentUuid, siblingIndex);
  const after = await requireNodeInfo(dependencies, nodeUuid);
  return {
    nodeUuid,
    before: { uuid: nodeUuid, parentUuid: before.parentUuid },
    after: { uuid: nodeUuid, parentUuid: after.parentUuid },
    inverse: [{ type: 'node.reparent', nodeUuid, newParentUuid: before.parentUuid as string }]
  };
}

async function duplicateNode(
  operation: WriteOperation,
  dependencies: NodeWriterDependencies
): Promise<NodeWriteOpResult> {
  const nodeUuid = operation.nodeUuid as string;
  await requireNodeInfo(dependencies, nodeUuid);
  const duplicatedUuid = await dependencies.duplicateNode(nodeUuid);
  if (!duplicatedUuid) {
    throw new ProbeError('NODE_DUPLICATE_FAILED', { nodeUuid });
  }
  try {
    if (typeof operation.name === 'string' && operation.name) {
      await dependencies.renameNode(duplicatedUuid, operation.name);
    }
    if (typeof operation.parentUuid === 'string' && operation.parentUuid) {
      await dependencies.reparentNode(duplicatedUuid, operation.parentUuid, undefined);
    }
  } catch (error) {
    // 改名/移动失败时清理副本，不写半成品。
    await dependencies.removeNode(duplicatedUuid);
    throw error;
  }
  return {
    nodeUuid: duplicatedUuid,
    before: null,
    after: await requireNodeInfo(dependencies, duplicatedUuid),
    inverse: [{ type: 'node.delete', nodeUuid: duplicatedUuid }]
  };
}

async function setNodeActive(
  operation: WriteOperation,
  dependencies: NodeWriterDependencies
): Promise<NodeWriteOpResult> {
  const nodeUuid = operation.nodeUuid as string;
  const before = await requireNodeInfo(dependencies, nodeUuid);
  await dependencies.setNodeActive(nodeUuid, operation.active as boolean);
  const after = await requireNodeInfo(dependencies, nodeUuid);
  return {
    nodeUuid,
    before: { uuid: nodeUuid, active: before.active },
    after: { uuid: nodeUuid, active: after.active },
    inverse: [{ type: 'node.set_active', nodeUuid, active: before.active }]
  };
}

async function setNodeLayer(
  operation: WriteOperation,
  dependencies: NodeWriterDependencies
): Promise<NodeWriteOpResult> {
  const nodeUuid = operation.nodeUuid as string;
  const before = await requireNodeInfo(dependencies, nodeUuid);
  await dependencies.setNodeLayer(nodeUuid, operation.layer as number);
  const after = await requireNodeInfo(dependencies, nodeUuid);
  return {
    nodeUuid,
    before: { uuid: nodeUuid, layer: before.layer },
    after: { uuid: nodeUuid, layer: after.layer },
    inverse: [{ type: 'node.set_layer', nodeUuid, layer: before.layer }]
  };
}

async function setNodeTransform(
  operation: WriteOperation,
  dependencies: NodeWriterDependencies
): Promise<NodeWriteOpResult> {
  const nodeUuid = operation.nodeUuid as string;
  const before = await requireNodeInfo(dependencies, nodeUuid);
  const localTransform = operation.localTransform as NodeLocalTransform;
  await dependencies.setNodeTransform(nodeUuid, localTransform);
  const after = await requireNodeInfo(dependencies, nodeUuid);
  return {
    nodeUuid,
    before: pickTransform(before),
    after: pickTransform(after),
    // 逆操作恢复完整旧变换，避免只回滚本次修改的分量而留下偏移。
    inverse: [{
      type: 'node.set_transform',
      nodeUuid,
      localTransform: {
        position: before.position,
        rotation: before.rotation,
        scale: before.scale
      }
    }]
  };
}

function pickTransform(info: NodeInfo): Partial<NodeInfo> {
  return {
    uuid: info.uuid,
    position: info.position,
    rotation: info.rotation,
    scale: info.scale
  };
}

async function requireNodeInfo(
  dependencies: NodeWriterDependencies,
  nodeUuid: string
): Promise<NodeInfo> {
  const info = await dependencies.getNodeInfo(nodeUuid);
  if (!info) {
    throw new ProbeError('NODE_NOT_FOUND', { nodeUuid });
  }
  return info;
}

function readReason(error: unknown): string {
  return error instanceof Error ? error.message : 'NODE_WRITE_FAILED';
}
