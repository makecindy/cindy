/** Tool delivery is separate from evidence that a requested postcondition holds. */
export function computerResultOutcome(
  name: string,
  data: unknown,
): {
  ok: boolean;
  errorCode?: string;
  outcome?: {
    status: 'confirmed' | 'unknown' | 'failed';
    next_step: 'verify_state' | 'fresh_state' | 'done';
  };
} {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return name === 'verify_state'
      ? {
          ok: false,
          errorCode: 'POSTCONDITION_NOT_SATISFIED',
          outcome: { status: 'unknown', next_step: 'fresh_state' },
        }
      : { ok: true };
  }
  const result = data as Record<string, unknown>;
  const failure = result.ok === false || result.isError === true || result.effect === 'refused';
  if (failure) {
    return {
      ok: false,
      errorCode: typeof result.code === 'string' ? result.code : 'COMPUTER_DRIVER_ERROR',
      outcome: { status: 'failed', next_step: 'fresh_state' },
    };
  }
  if (name === 'verify_state') {
    const satisfied = result.status === 'satisfied' && result.stable !== false;
    return {
      ok: satisfied,
      ...(!satisfied ? { errorCode: 'POSTCONDITION_NOT_SATISFIED' } : {}),
      outcome: {
        status: satisfied ? 'confirmed' : result.status === 'unsatisfied' ? 'failed' : 'unknown',
        next_step: satisfied ? 'done' : 'fresh_state',
      },
    };
  }
  if (typeof result.effect === 'string') {
    return {
      ok: true,
      outcome: {
        status: result.effect === 'confirmed' ? 'confirmed' : 'unknown',
        next_step: 'verify_state',
      },
    };
  }
  return { ok: true };
}
