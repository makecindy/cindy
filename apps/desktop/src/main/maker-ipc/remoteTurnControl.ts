import { createHmac, randomBytes } from 'node:crypto';

interface LiveTurn {
  readonly instanceId: string;
  isTurnRunning(): boolean;
  getTurnGeneration(): number;
}

export const REMOTE_STOP_TURN = 'maker:input:stop-turn';

interface RuntimeAuthority {
  key: Buffer;
  stoppedGeneration?: number;
  stoppedBoundary?: string;
  interruptedGeneration?: number;
}

/** A stop token belongs to one live runtime, one turn, and one authenticated device. */
export class RemoteTurnControl<T extends LiveTurn> {
  private readonly runtimes = new WeakMap<T, RuntimeAuthority>();

  token(runtime: T, controller: string, boundary = ''): string | undefined {
    if (!runtime.isTurnRunning() || !controller) return undefined;
    const generation = runtime.getTurnGeneration();
    if (!Number.isSafeInteger(generation) || generation < 1) return undefined;
    let authority = this.runtimes.get(runtime);
    if (!authority) {
      authority = { key: randomBytes(32) };
      this.runtimes.set(runtime, authority);
    }
    if (authority.stoppedGeneration === generation) return undefined;
    return createHmac('sha256', authority.key).update(controller).update('\0').update(String(generation)).update('\0').update(boundary).digest('hex');
  }

  consume(runtime: T, controller: string, token: unknown, boundary = ''): boolean {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false;
    const authority = this.runtimes.get(runtime);
    if (!authority || this.token(runtime, controller, boundary) !== token) return false;
    authority.stoppedGeneration = runtime.getTurnGeneration();
    authority.stoppedBoundary = boundary;
    return true;
  }

  observeTerminal(runtime: T, event: {
    type: string;
    source?: string;
    turnScope?: string;
    sessionInstanceId?: string;
    sessionTurnGeneration?: number;
    data?: unknown;
  }): void {
    if (event.type !== 'done' || event.turnScope === 'background'
      || event.sessionInstanceId !== runtime.instanceId || !event.data || typeof event.data !== 'object') return;
    const authority = this.runtimes.get(runtime);
    const generation = runtime.getTurnGeneration();
    if (!authority || authority.stoppedGeneration !== generation || event.sessionTurnGeneration !== generation) return;
    const data = event.data as Record<string, unknown>;
    const raw = data.raw;
    const interrupted = event.source === 'claude-code' && data.terminal_reason === 'aborted_streaming'
      || event.source === 'codex' && data.cancelled === true && typeof raw === 'object' && raw !== null
        && 'status' in raw && raw.status === 'interrupted'
      || event.source === 'pi' && data.status === 'cancelled' && data.type === 'pi/agent_settled';
    if (interrupted) authority.interruptedGeneration = generation;
  }

  outcome(runtime: T, boundary = ''): 'interrupted' | undefined {
    const authority = this.runtimes.get(runtime);
    return authority?.interruptedGeneration === runtime.getTurnGeneration() && authority.stoppedBoundary === boundary
      && !runtime.isTurnRunning()
      ? 'interrupted' : undefined;
  }
}

export function isOrdinaryRemoteTurnSession(row: {
  status: string;
  source?: string | null;
  remoteHostId?: string | null;
  agentDeviceId?: string | null;
  orcaRole?: string | null;
  orcaRemoteLead?: string | null;
}): boolean {
  return row.status === 'active' && row.source === 'desktop' && !row.remoteHostId &&
    !row.agentDeviceId && !row.orcaRole && !row.orcaRemoteLead;
}

export function remoteTurnInputBoundary(input: {
  generation: number;
  clearInFlight: boolean;
  observedClear: number | null;
  persistedClear: number | null;
}): string | undefined {
  // An in-memory clear remains authoritative while its durable write is pending.
  if (input.clearInFlight || (input.observedClear !== null
    && (input.persistedClear === null || input.persistedClear < input.observedClear))) return undefined;
  return `${input.generation}:${input.persistedClear ?? ''}`;
}

export function projectActiveRuntimeSummary(result: unknown, options: unknown, sameAccountController: boolean): unknown {
  // Opt-in only: legacy/desktop controllers still receive complete runtime capabilities.
  // Home only needs run state; repeating the model catalog per runtime blocks slow links.
  if (options && typeof options === 'object'
    && !Array.isArray(options) && 'summary' in options && options.summary === true
    && (Array.isArray(result) || (
      'snapshotVersion' in options && options.snapshotVersion === 2
      && result && typeof result === 'object' && !Array.isArray(result)
      && 'format' in result && result.format === 'active-sessions-v2'
      && 'sessions' in result && Array.isArray(result.sessions)
    ))) {
    const complete = !Array.isArray(result);
    const rows = Array.isArray(result) ? result : (result as { sessions: unknown[] }).sessions;
    const turnControl = complete && sameAccountController
      && (options as Record<string, unknown>).turnControlVersion === 1
      && (result as { turnControlVersion?: unknown }).turnControlVersion === 1;
    const projected = rows.map((item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      const row = item as Record<string, unknown>;
      return {
        sessionId: row.sessionId,
        isTurnRunning: row.isTurnRunning,
        ...(turnControl && row.isTurnRunning === true && typeof row.turnControlToken === 'string'
          && /^[a-f0-9]{64}$/.test(row.turnControlToken) ? { turnControlToken: row.turnControlToken } : {}),
        ...(turnControl && row.isTurnRunning === false && row.turnControlOutcome === 'interrupted'
          ? { turnControlOutcome: row.turnControlOutcome } : {}),
        ...(typeof row.activityPhase === 'string' && typeof row.activityAttention === 'boolean'
          ? { activityPhase: row.activityPhase, activityAttention: row.activityAttention } : {}),
      };
    });
    return complete
      ? { format: 'active-sessions-v2', sessions: projected, ...(turnControl ? { turnControlVersion: 1 } : {}) }
      : projected;
  }
  return result;
}
