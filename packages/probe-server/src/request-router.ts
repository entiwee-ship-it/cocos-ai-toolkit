interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class RequestRouter {
  private readonly pending = new Map<string, PendingRequest>();

  /**
   * 登记一个等待 Bridge 响应的请求。
   *
   * @param requestId 请求标识。
   * @param timeoutMs 等待响应的最大毫秒数。
   * @returns Bridge 响应载荷。
   */
  wait(requestId: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('OUTCOME_UNKNOWN'));
      }, timeoutMs);

      this.pending.set(requestId, { resolve, reject, timeout });
    });
  }

  /**
   * 使用 Bridge 响应完成对应请求。
   *
   * @param correlationId Bridge 返回的关联请求标识。
   * @param ok Bridge 是否成功执行请求。
   * @param payload 成功载荷或错误详情。
   * @returns 是否找到等待中的请求。
   */
  complete(correlationId: string, ok: boolean, payload: unknown): boolean {
    const request = this.pending.get(correlationId);
    if (!request) {
      return false;
    }

    clearTimeout(request.timeout);
    this.pending.delete(correlationId);

    if (ok) {
      request.resolve(payload);
    } else {
      request.reject(new Error(`BRIDGE_REQUEST_FAILED: ${JSON.stringify(payload)}`));
    }

    return true;
  }

  /**
   * 终止所有未完成请求，供 Server 关闭时清理。
   */
  abortAll(): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error('SERVER_STOPPED'));
    }
    this.pending.clear();
  }
}
