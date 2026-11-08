/** Local-only marker for the bounded in-process pick coalescer. Never sent over the wire. */
export class ProviderGroupLocalCapacityError extends Error {
  constructor() {
    super('[REMOTE_AGENT_UNAVAILABLE] Group routing capacity is temporarily exhausted');
    this.name = 'ProviderGroupLocalCapacityError';
  }
}

export function isProviderGroupLocalCapacityError(value: unknown): value is ProviderGroupLocalCapacityError {
  return value instanceof ProviderGroupLocalCapacityError;
}
