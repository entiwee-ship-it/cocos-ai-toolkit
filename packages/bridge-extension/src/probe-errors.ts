export class ProbeError extends Error {
  constructor(
    readonly code: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(code);
    this.name = 'ProbeError';
  }
}

export function toProbeErrorPayload(error: unknown): { code: string; details: Record<string, unknown> } {
  if (error instanceof ProbeError) {
    return { code: error.code, details: error.details };
  }
  if (error instanceof Error) {
    return { code: error.message || 'BRIDGE_HANDLER_FAILED', details: {} };
  }
  return { code: 'BRIDGE_HANDLER_FAILED', details: {} };
}
