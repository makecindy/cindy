import type { Session } from '@cindy/maker-core';
import { createLogger } from '../logger';

const log = createLogger('channel-turn');
export type ChannelTurnPhase = 'starting' | 'undispatched';
/**
 * Main-stamped requester of the turn that is starting. Only another task's user-visible message is
 * marked; desktop input, IM input and internal delegation coordination are not. Scheduler turns are
 * recognised by their own turnOrigin instead.
 */
export type ChannelTurnSource = 'other-task';
type ChannelTurnListener = (
  session: Session,
  phase: ChannelTurnPhase,
  source: ChannelTurnSource | undefined,
) => void | Promise<void>;
const listeners = new Set<ChannelTurnListener>();
/** Lives only for one Session.send call: the signal fires inside it, before provider output. */
const pendingSources = new Map<string, { source: ChannelTurnSource }>();

/** Runs before provider output, including scheduler and cross-session direct sends. */
export function onChannelTurn(listener: ChannelTurnListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export async function publishChannelTurn(session: Session, phase: ChannelTurnPhase): Promise<void> {
  const source = pendingSources.get(session.id)?.source;
  pendingSources.delete(session.id);
  await Promise.all([...listeners].map(async (listener) => {
    try { await listener(session, phase, source); }
    catch { log.warn('channel output observer could not be updated'); }
  }));
}

/** Classify a host-stamped user message origin (see AgentInputQueuedMessage['origin']). */
export function channelTurnSourceFor(
  origin: unknown,
  internalCoordination: boolean,
): ChannelTurnSource | undefined {
  const typed = origin as { kind?: unknown; senderSessionId?: unknown } | null | undefined;
  return !internalCoordination &&
    typed?.kind === 'session' &&
    typeof typed.senderSessionId === 'string' &&
    typed.senderSessionId !== ''
    ? 'other-task'
    : undefined;
}

/** Mark the Session.send about to run; call the returned release once that send returns. */
export function noteChannelTurnSource(
  sessionId: string,
  source: ChannelTurnSource | undefined,
): () => void {
  if (!source) return () => undefined;
  const entry = { source };
  pendingSources.set(sessionId, entry);
  return () => {
    if (pendingSources.get(sessionId) === entry) pendingSources.delete(sessionId);
  };
}

/** Wrap the Session.send that dispatches a message from `source`. */
export async function withChannelTurnSource<T>(
  sessionId: string,
  source: ChannelTurnSource | undefined,
  send: () => Promise<T>,
): Promise<T> {
  const release = noteChannelTurnSource(sessionId, source);
  try {
    return await send();
  } finally {
    release();
  }
}
