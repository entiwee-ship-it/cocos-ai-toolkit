export class ProbeError extends Error {
  constructor(
    readonly code: string,
    readonly details: Record<string, unknown> = {},
    message = code
  ) {
    super(message);
    this.name = 'ProbeError';
  }
}

export interface ProbeErrorPayload {
  code: string;
  message: string;
  details: Record<string, unknown>;
  stage?: string;
  nextAction?: string;
}

export function toProbeErrorPayload(error: unknown): ProbeErrorPayload {
  if (error instanceof ProbeError) {
    const stage = typeof error.details.stage === 'string' ? error.details.stage : undefined;
    const nextAction = typeof error.details.nextAction === 'string'
      ? error.details.nextAction
      : undefined;
    return {
      code: error.code,
      message: error.message,
      details: error.details,
      ...(stage ? { stage } : {}),
      ...(nextAction ? { nextAction } : {})
    };
  }
  if (error instanceof Error) {
    return {
      code: 'BRIDGE_HANDLER_FAILED',
      message: error.message || 'Bridge handler failed',
      details: {}
    };
  }
  return { code: 'BRIDGE_HANDLER_FAILED', message: 'Bridge handler failed', details: {} };
}
