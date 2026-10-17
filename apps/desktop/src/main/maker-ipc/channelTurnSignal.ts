import type { Session } from '@cindy/maker-core';
import { createLogger } from '../logger';

const log = createLogger('channel-turn');
export type ChannelTurnPhase = 'starting' | 'undispatched';
/**
 * Requester of the turn that is starting. `other-task`: main stamped another task's user-visible
 * message on the send. `provider-wake`: no send at all, the agent harness woke the session itself
 * (Claude Code background task notifications; see Session `onProviderInitiatedTurn`). Desktop input,
 * IM input and internal delegation coordination are not marked. Scheduler turns are recognised by
 * their own turnOrigin instead.
 */
export type ChannelTurnSource = 'other-task' | 'provider-wake';

/**
 * The one relay predicate shared by official hook background results and personal IM output:
 * a non-IM, non-scheduler turn returns to the task's channel only for these sources.
 */
export function isRelayedChannelTurnSource(source: ChannelTurnSource | undefined): boolean {
  return source === 'other-task' || source === 'provider-wake';
}
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
  await notifyListeners(session, phase, source);
}

/**
 * A turn the provider started without a send. Session calls this before the turn's first event fans
 * out, and every listener's synchronous part runs before this returns, so observers it attaches see
 * the whole turn. Listeners must decide synchronously; an awaited lookup would start mid-turn.
 */
export function publishProviderInitiatedTurn(session: Session): Promise<void> {
  return notifyListeners(session, 'starting', 'provider-wake');
}

async function notifyListeners(
  session: Session,
  phase: ChannelTurnPhase,
  source: ChannelTurnSource | undefined,
): Promise<void> {
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
