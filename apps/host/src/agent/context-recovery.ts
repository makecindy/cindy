import type { AgentEvent, Session } from '@cindy/maker-core';
import type { AgentMeta } from '../../../desktop/src/renderer/lib/ccAgent.types.ts';
import {
  claimContextRecoveryTerminal,
  deferContextRecoveryTerminal,
  settleContextRecoveryTerminal,
  type ContextRecoveryTerminalPorts,
} from '../../../desktop/src/main/maker-ipc/contextRecoveryTerminal.ts';
import {
  isContextOverflowErrorData,
  isOversizedHistoryErrorData,
  isUnsupportedRequestOptionErrorData,
  type createContextOverflowRollover,
  type OverflowClaimResult,
} from '../../../desktop/src/main/maker-ipc/contextOverflowRollover.ts';
import { isTerminalTurnErrorEvent } from '../../../desktop/src/main/maker-ipc/sessionTurnActivityTracker.ts';

/**
 * How long a Host shutdown waits, in total, for the context recoveries still in flight to end
 * (as failures, writing their error rows) before it stops the tasks. As the repository's other
 * close drains (remote-agent runClient.ts CLOSE_DRAIN_MS).
 */
export const RECOVERY_SHUTDOWN_WAIT_MS = 5_000;

type Rollover = Pick<ReturnType<typeof createContextOverflowRollover>, 'claim' | 'tryRecover'>;

/** The error-row persistence of one task, as the Host's event persistence provides it. */
export interface RecoveryHistory {
  reserveTurnErrorPersistId: ContextRecoveryTerminalPorts['reserveTurnErrorPersistId'];
  releaseReservedTurnErrorPersistId: ContextRecoveryTerminalPorts['releaseReservedTurnErrorPersistId'];
  onTurnErrorEvent: ContextRecoveryTerminalPorts['onTurnErrorEvent'];
  /** Writes everything queued to the database. */
  drain(): Promise<void>;
}

/** A claimed terminal whose recovery has not ended yet. */
interface Recovering {
  terminal: RecoveryTerminal;
  done: Promise<void>;
  /** The shutdown wrote its error row; the recovery's own failure path must not write another. */
  surfacedAtShutdown: boolean;
}

interface HeldBroadcast {
  sessionId: string;
  event: AgentEvent;
  persistId?: string;
  resolvedContent?: unknown;
  /** The fields the Host publishes the event with (stream fields and the input's client id). */
  fields: Record<string, unknown>;
}

/** What the turn executor tells recovery about one terminal error, synchronously. */
export interface RecoveryTerminal {
  session: Session;
  event: AgentEvent;
  history: RecoveryHistory;
  fields: Record<string, unknown>;
  /** The Host is stopping: as the desktop's planned upgrade close, recovery does not claim. */
  isStopping: boolean;
  isGatewayProxyTokenRecovery: boolean;
}

export type HostContextRecovery = ReturnType<typeof createHostContextRecovery>;

/** The three kinds of context recovery, each opened on the Host after its real-engine test. */
export type ContextRecoveryKind = 'context-overflow' | 'oversized-history' | 'unsupported-request-option';

/** Which kind of context recovery a terminal error's data asks for, if any. */
export function contextRecoveryKind(data: unknown): ContextRecoveryKind | null {
  if (isContextOverflowErrorData(data)) return 'context-overflow';
  if (isOversizedHistoryErrorData(data)) return 'oversized-history';
  if (isUnsupportedRequestOptionErrorData(data)) return 'unsupported-request-option';
  return null;
}

/**
 * The terminal errors whose broadcast is held for recovery: an overflow-class terminal error of a
 * local task, as the desktop's delivery holds them (sessionEventDelivery.ts). Desktop parity is
 * checked by sessionEventPipeline.test.ts.
 */
export function holdsOverflowBroadcast(session: Pick<Session, 'remoteHostId'>, event: AgentEvent): boolean {
  return !session.remoteHostId && event.type === 'error' && isTerminalTurnErrorEvent(event)
    && (isContextOverflowErrorData(event.data) || isOversizedHistoryErrorData(event.data)
      || isUnsupportedRequestOptionErrorData(event.data));
}

/**
 * The desktop's claim, defer and settle of a context recovery terminal (contextRecoveryTerminal.ts)
 * on the Host's ports. The Host has no automatic resume, remote auth retry or product-turn
 * follow-up owner, so those inputs are constant (release table, context recovery).
 */
export function createHostContextRecovery(deps: {
  getRollover(): Rollover | null;
  /**
   * Whether recovery is open for this kind of terminal error (overflow, oversized history,
   * unsupported request option). A kind that is closed takes the normal error path, unclaimed.
   */
  isRecoverable?(data: unknown): boolean;
  publish(sessionId: string, event: AgentEvent, fields: Record<string, unknown>): void;
  log: { warn(message: string, fields?: Record<string, unknown>): void };
}) {
  const held = new Map<string, HeldBroadcast>();
  // By task: the factory recovers one claimed terminal per task at a time.
  const recovering = new Map<string, Recovering>();
  const ended = (sessionId: string, entry: Recovering) => {
    if (recovering.get(sessionId) === entry) recovering.delete(sessionId);
  };

  function ports(history: RecoveryHistory, rollover: () => Rollover | null): ContextRecoveryTerminalPorts {
    return {
      getRollover: rollover,
      getSuppressedBroadcasts: () => held as unknown as ReturnType<ContextRecoveryTerminalPorts['getSuppressedBroadcasts']>,
      isTerminalTurnErrorEvent: event => isTerminalTurnErrorEvent(event),
      isContextOverflowErrorData: data => isContextOverflowErrorData(data),
      isOversizedHistoryErrorData: data => isOversizedHistoryErrorData(data),
      isUnsupportedRequestOptionErrorData: data => isUnsupportedRequestOptionErrorData(data),
      reserveTurnErrorPersistId: (...args) => history.reserveTurnErrorPersistId(...args),
      releaseReservedTurnErrorPersistId: (...args) => history.releaseReservedTurnErrorPersistId(...args),
      onTurnErrorEvent: (...args) => history.onTurnErrorEvent(...args),
      broadcastToAllWindows: (_channel, payload) => {
        const broadcast = payload as HeldBroadcast;
        deps.publish(broadcast.sessionId, broadcast.event, {
          ...broadcast.fields, ...(broadcast.persistId ? { persistId: broadcast.persistId } : {}),
        });
      },
      // The desktop's agent island has no Host counterpart.
      handleAgentIslandEventAfterBroadcast: () => {},
      eventChannel: () => 'agent-event',
      log: deps.log,
    };
  }

  function input(terminal: RecoveryTerminal) {
    const eventAgentMeta = (terminal.event.agentMeta as AgentMeta | null | undefined) ?? null;
    return {
      session: terminal.session,
      event: terminal.event,
      attributedEvent: terminal.event,
      broadcastEvent: terminal.event,
      eventAgentMeta,
      isPlannedUpgradeClose: terminal.isStopping,
      isRemoteAuthRetry: false,
      isGatewayProxyTokenRecovery: terminal.isGatewayProxyTokenRecovery,
      autoResumeSuppressesPersist: false,
      // A held terminal reserves no row id, as on the desktop (sessionEventDelivery.ts).
      persistId: undefined,
    };
  }

  return {
    /**
     * At delivery, synchronously, for a terminal error of a turn: holds the broadcast of an
     * overflow-class error of a local task (the desktop's delivery holds the same ones) and claims
     * it for recovery. 'idle': nothing owns it, the caller publishes it and writes its row as
     * before. 'claimed' or 'in-flight': recovery owns its broadcast and row.
     */
    claim(terminal: RecoveryTerminal): OverflowClaimResult {
      const { session, event } = terminal;
      const holds = holdsOverflowBroadcast(session, event);
      if (holds && deps.isRecoverable && !deps.isRecoverable(event.data)) return 'idle';
      if (holds) held.set(session.id, { sessionId: session.id, event, fields: terminal.fields });
      const result = claimContextRecoveryTerminal(ports(terminal.history, deps.getRollover), input(terminal));
      // The Host has no product-turn follow-up to defer (release table).
      deferContextRecoveryTerminal(ports(terminal.history, deps.getRollover), input(terminal), result, () => {});
      if (holds && result === 'idle' && held.get(session.id)?.event === event) held.delete(session.id);
      return result;
    },

    /**
     * After the turn's finish has begun: starts recovery of a claimed terminal (or settles a
     * duplicate of one in flight). Recovery waits for `settled` first, so the coordinator has the
     * claimed input's error before any recovery path clears it.
     */
    settle(terminal: RecoveryTerminal, result: OverflowClaimResult, settled: () => Promise<unknown>): void {
      const rollover = deps.getRollover();
      const sessionId = terminal.session.id;
      const waiting: Rollover | null = rollover && {
        claim: (...args) => rollover.claim(...args),
        tryRecover: (...args) => {
          const entry = { terminal, surfacedAtShutdown: false } as Recovering;
          recovering.set(sessionId, entry);
          // A row the shutdown already wrote is the failure's row: report recovered so the
          // settlement neither shows the error again nor writes a second row.
          const recovery = settled().catch(() => undefined).then(() => rollover.tryRecover(...args)).then(
            recovered => { ended(sessionId, entry); return entry.surfacedAtShutdown || recovered; },
            error => { ended(sessionId, entry); if (entry.surfacedAtShutdown) return true; throw error; });
          entry.done = recovery.then(() => undefined, () => undefined);
          return recovery;
        },
      };
      settleContextRecoveryTerminal(ports(terminal.history, () => waiting), input(terminal), result, () => {});
    },

    /**
     * The replay of a recovery was accepted (the factory's onRebuilt): the recovery has succeeded,
     * whatever it still awaits, so a shutdown neither waits for it nor writes its error row.
     */
    noteRebuilt(sessionId: string): void {
      recovering.delete(sessionId);
    },

    /**
     * The client id of the input whose terminal error the task's running recovery claimed, for its
     * replay to stamp its events and receipts with (the Host's /api/chat ends a message's stream on a
     * terminal of its own client id). Only while that recovery runs: it ends, fails, throws, is
     * rebuilt or is drained at shutdown, and the entry goes. A replay outside a recovery gets none.
     */
    replayClientId(sessionId: string): string | undefined {
      const clientId = recovering.get(sessionId)?.terminal.fields.inputClientId;
      return typeof clientId === 'string' ? clientId : undefined;
    },

    /**
     * On shutdown, before the tasks are stopped: waits for the recoveries in flight to end, all
     * together for at most RECOVERY_SHUTDOWN_WAIT_MS. Recovery's own checks fail once the runtime
     * is closing, so a recovery normally ends as a failure and writes its error row. For one still
     * running at the limit the Host writes that same row itself (the queue snapshot keeps only
     * queued input, so it would otherwise be lost) and waits until it is on disk; it is not shown,
     * as the Host is closing. A failed write is logged and the shutdown goes on.
     */
    async drainForShutdown(): Promise<void> {
      if (recovering.size === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<void>(resolve => { timer = setTimeout(resolve, RECOVERY_SHUTDOWN_WAIT_MS); });
      try {
        await Promise.race([Promise.allSettled([...recovering.values()].map(entry => entry.done)), limit]);
      } finally { clearTimeout(timer); }
      // The failure path writes its row in the settlement callback that follows the recovery.
      await new Promise(resolve => setImmediate(resolve));
      for (const [sessionId, entry] of [...recovering]) {
        recovering.delete(sessionId);
        entry.surfacedAtShutdown = true;
        if (held.get(sessionId)?.event === entry.terminal.event) held.delete(sessionId);
        const { history, event } = entry.terminal;
        const payload = event.data as Parameters<RecoveryHistory['onTurnErrorEvent']>[1];
        const agentMeta = (event.agentMeta as AgentMeta | null | undefined) ?? null;
        try {
          // As the desktop's failure path (contextRecoveryTerminal.ts surfaceOverflowFailure).
          const persistId = history.reserveTurnErrorPersistId(sessionId, payload, agentMeta);
          history.onTurnErrorEvent(sessionId, payload, agentMeta, persistId);
          await history.drain();
        } catch (error) {
          deps.log.warn('context recovery error row was not written at shutdown', {
            sessionId, error: error instanceof Error ? error.message : String(error) });
        }
      }
    },
  };
}
