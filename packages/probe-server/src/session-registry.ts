export interface BridgeSessionInfo {
  editorInstanceId: string;
  projectId: string;
  projectPath: string;
  creatorVersion: string;
  bridgeVersion: string;
  capabilities: string[];
}

export interface SessionSelector {
  projectId: string;
  editorInstanceId?: string;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, BridgeSessionInfo>();

  /**
   * 登记或更新一个编辑器 Bridge 会话。
   *
   * @param session 当前编辑器实例上报的稳定会话信息。
   */
  register(session: BridgeSessionInfo): void {
    this.sessions.set(session.editorInstanceId, session);
  }

  /**
   * 按项目和可选编辑器实例解析唯一会话。
   *
   * @param selector 会话选择条件。
   * @returns 唯一匹配的编辑器会话。
   */
  resolve(selector: SessionSelector): BridgeSessionInfo {
    const matches = [...this.sessions.values()].filter((session) => {
      if (session.projectId !== selector.projectId) {
        return false;
      }

      return !selector.editorInstanceId || session.editorInstanceId === selector.editorInstanceId;
    });

    if (matches.length === 0) {
      throw new Error('EDITOR_INSTANCE_NOT_FOUND');
    }

    if (matches.length > 1) {
      throw new Error('MULTIPLE_EDITOR_INSTANCES');
    }

    return matches[0];
  }

  /**
   * 返回当前全部已登记编辑器会话。
   *
   * @returns 编辑器会话快照。
   */
  list(): BridgeSessionInfo[] {
    return [...this.sessions.values()];
  }

  /**
   * 移除已断开的编辑器实例。
   *
   * @param editorInstanceId 编辑器实例标识。
   */
  remove(editorInstanceId: string): void {
    this.sessions.delete(editorInstanceId);
  }
}
