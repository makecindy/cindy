import {
  shouldRefreshLatestMessageWindowOnReopen,
  type MessagePageRetryResult,
} from '@/session/messagePaging';
import type { RemoteSession } from '@/session/types';

interface SessionMessageWindowSync {
  isReopen: boolean;
  storedSession: RemoteSession | null;
  readMetadata(): Promise<RemoteSession>;
  readLatest(): Promise<MessagePageRetryResult>;
  isCurrent(): boolean;
  isWindowSynced(session: RemoteSession): boolean;
  commit(session: RemoteSession, page: MessagePageRetryResult | null): void;
}

/**
 * History owns its read/commit independently of pending-interaction and input
 * snapshots. A failed projection must not discard a fetched page or prevent a
 * reopened task from checking its history. Full sync/dispatch readiness is
 * still decided by the caller after all resources succeed.
 */
export async function syncSessionMessageWindow(input: SessionMessageWindowSync): Promise<void> {
  let session: RemoteSession;
  let page: MessagePageRetryResult | null = null;
  if (!input.isReopen) {
    // Keep cold-open metadata and history parallel; neither depends on projection.
    [session, page] = await Promise.all([input.readMetadata(), input.readLatest()]);
  } else {
    session = await input.readMetadata();
    if (!input.isCurrent()) return;
    if (shouldRefreshLatestMessageWindowOnReopen({
      freshSession: session,
      storedSession: input.storedSession,
      messageWindowSynced: input.isWindowSynced(session),
    })) {
      page = await input.readLatest();
    }
  }
  if (input.isCurrent()) input.commit(session, page);
}
