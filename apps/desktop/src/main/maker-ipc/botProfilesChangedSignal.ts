/**
 * Zero-dependency signal for teammate profile / lifecycle changes. Teammate IPC (bots.ts), the
 * lifecycle and delegation services send it; readers such as the Chat Server companion sync
 * re-read without waiting for their own timers. This file imports nothing, so senders do not load
 * any reader's dependencies.
 */
const subscribers = new Set<() => void>();

export function subscribeBotProfilesChanged(next: () => void): () => void {
  subscribers.add(next);
  return () => { subscribers.delete(next); };
}

export function signalBotProfilesChanged(): void {
  for (const next of subscribers) {
    try { next(); } catch { /* A reader cannot block a committed profile change. */ }
  }
}
