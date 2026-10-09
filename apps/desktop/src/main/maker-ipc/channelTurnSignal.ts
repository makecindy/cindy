import type { Session } from '@cindy/maker-core';
import { createLogger } from '../logger';

const log = createLogger('channel-turn');
export type ChannelTurnPhase = 'starting' | 'undispatched';
const listeners = new Set<(session: Session, phase: ChannelTurnPhase) => void | Promise<void>>();

/** Runs before provider output, including scheduler and cross-session direct sends. */
export function onChannelTurn(listener: (session: Session, phase: ChannelTurnPhase) => void | Promise<void>): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export async function publishChannelTurn(session: Session, phase: ChannelTurnPhase): Promise<void> {
  await Promise.all([...listeners].map(async (listener) => {
    try { await listener(session, phase); }
    catch { log.warn('channel output observer could not be updated'); }
  }));
}
