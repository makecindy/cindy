export class RuntimeControlTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'RuntimeControlTimeoutError';
  }
}

function withRuntimeControlTimeout<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs: number,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(
      () => reject(new RuntimeControlTimeoutError(label, timeoutMs)),
      timeoutMs,
    );
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });
}

export interface ApplyRuntimeEffortWithRecoveryInput {
  applyRuntime: () => Promise<void>;
  terminateSession: () => Promise<void>;
  runtimeTimeoutMs?: number;
  terminationTimeoutMs?: number;
}

/**
 * Bounds a live effort mutation and retires its session before reporting recovery.
 * A timed-out control request may still settle later, so callers must not reuse that
 * live session; the next send recreates it from the already-persisted effort.
 */
export async function applyRuntimeEffortWithRecovery(
  input: ApplyRuntimeEffortWithRecoveryInput,
): Promise<'applied' | 'session-terminated'> {
  const runtimeTimeoutMs = input.runtimeTimeoutMs ?? 3_500;
  const terminationTimeoutMs = input.terminationTimeoutMs ?? 1_000;
  try {
    await withRuntimeControlTimeout(
      Promise.resolve().then(input.applyRuntime),
      'effort runtime update',
      runtimeTimeoutMs,
    );
    return 'applied';
  } catch (error) {
    if (!(error instanceof RuntimeControlTimeoutError)) throw error;
    await withRuntimeControlTimeout(
      Promise.resolve().then(input.terminateSession),
      'effort runtime recovery',
      terminationTimeoutMs,
    );
    return 'session-terminated';
  }
}
