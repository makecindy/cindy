import type { ChannelTurnSource } from './channelTurnSource';
export { type ChannelTurnSource, isRelayedChannelTurnSource } from './channelTurnSource';
import type { Session } from '@cindy/maker-core';

export type ChannelTurnPhase = 'starting' | 'undispatched';
type ChannelTurnListener = (
  session: Session,
  phase: ChannelTurnPhase,
  source: ChannelTurnSource | undefined,
) => void | Promise<void>;
export function createChannelTurnSignals(log: { warn(message: string): void }) {
const listeners = new Set<ChannelTurnListener>();
/** Lives only for one Session.send call: the signal fires inside it, before provider output. */
const pendingSources = new Map<string, { source: ChannelTurnSource }>();

/** Runs before provider output, including scheduler and cross-session direct sends. */
function onChannelTurn(listener: ChannelTurnListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

async function publishChannelTurn(session: Session, phase: ChannelTurnPhase): Promise<void> {
  const source = pendingSources.get(session.id)?.source;
  pendingSources.delete(session.id);
  await notifyListeners(session, phase, source);
}

/**
 * A turn the provider started without a send. Session calls this before the turn's first event fans
 * out, and every listener's synchronous part runs before this returns, so observers it attaches see
 * the whole turn. Listeners must decide synchronously; an awaited lookup would start mid-turn.
 */
function publishProviderInitiatedTurn(session: Session): Promise<void> {
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
function channelTurnSourceFor(
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
function noteChannelTurnSource(
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
async function withChannelTurnSource<T>(
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

return { onChannelTurn, publishChannelTurn, publishProviderInitiatedTurn, channelTurnSourceFor, noteChannelTurnSource, withChannelTurnSource };
}
