export type RecoveryPhase = 'subscription' | 'history' | 'pending' | 'projection' | 'goal';
export interface RecoveryDiagnostic {
  generation: number;
  connection: number;
  peer: number;
  operation: number;
  phase: RecoveryPhase;
  outcome: 'applied' | 'superseded' | 'failed';
  elapsedMs: number;
  foregroundElapsedMs: number;
  count?: number;
}

export async function settleMeasuredSnapshot<T>(
  read: Promise<T>, apply: (value: T) => boolean,
  report: (outcome: RecoveryDiagnostic['outcome']) => void,
): Promise<PromiseSettledResult<T>> {
  try {
    const value = await read;
    report(apply(value) ? 'applied' : 'superseded');
    return { status: 'fulfilled', value };
  } catch (reason) {
    report('failed');
    return { status: 'rejected', reason };
  }
}

/** Local numeric correlations only. Never emit topics, content or error messages. */
export function createRecoveryDiagnostics(
  emit: (event: RecoveryDiagnostic) => void,
  currentConnection: () => number,
  now = () => performance.now(),
) {
  let generation = 0;
  let nextOperation = 0;
  let foregroundAt: number | null = null;
  const peers = new Map<string, number>();
  return {
    foreground() {
      if (foregroundAt !== null) return;
      generation++;
      foregroundAt = now();
    },
    background() { foregroundAt = null; generation++; },
    capture(deviceId: string, connection: number) {
      const captured = generation;
      const operation = ++nextOperation;
      const startedAt = now();
      if (!peers.has(deviceId)) peers.set(deviceId, peers.size + 1);
      const peer = peers.get(deviceId)!;
      return (phase: RecoveryPhase, outcome: RecoveryDiagnostic['outcome'], count?: number) => {
        if (foregroundAt === null || captured !== generation || connection !== currentConnection()) return;
        emit({ generation, connection, peer, operation, phase, outcome,
          elapsedMs: Math.max(0, Math.round(now() - startedAt)),
          foregroundElapsedMs: Math.max(0, Math.round(now() - foregroundAt)),
          ...(count === undefined ? {} : { count }),
        });
      };
    },
  };
}
