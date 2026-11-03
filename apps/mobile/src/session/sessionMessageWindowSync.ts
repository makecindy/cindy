import {
  shouldRefreshLatestMessageWindowOnReopen,
  type MessagePageRetryResult,
} from '@/session/messagePaging';
import type { RemoteSession } from '@/session/types';
import type { MessageHistoryRead } from '@/session/sessionEmptyState';
import { readProgressiveMessageWindow } from '@/device-link/sessionSnapshotSingleFlight';

interface SessionMessageWindowSync {
  isReopen: boolean;
  eager?: boolean;
  storedSession: RemoteSession | null;
  readMetadata(): Promise<RemoteSession>;
  readLatest(): Promise<MessagePageRetryResult>;
  isCurrent(): boolean;
  isWindowSynced(session: RemoteSession): boolean;
  commitMessages?(page: MessagePageRetryResult): void;
  commit(session: RemoteSession, page: MessagePageRetryResult | null): void;
  /** 历史读取独立确认成功；generation 为启动时快照，ref 为当前访问代次。 */
  historyConfirmation?: {
    key: string;
    generation: number;
    generationRef: { current: number };
    commit(read: MessageHistoryRead): void;
  };
}

/**
 * History owns its read/commit independently of pending-interaction and input
 * snapshots. A failed projection must not discard a fetched page or prevent a
 * reopened task from checking its history. Full sync/dispatch readiness is
 * still decided by the caller after all resources succeed.
 */
export async function syncSessionMessageWindow(input: SessionMessageWindowSync): Promise<void> {
  const markHistorySynced = () => {
    const confirmation = input.historyConfirmation;
    if (confirmation && input.isCurrent()
      && confirmation.generationRef.current === confirmation.generation) {
      confirmation.commit({ key: confirmation.key, synced: true });
    }
  };
  const { metadata: session, history: page } = await readProgressiveMessageWindow({
    readMetadata: input.readMetadata,
    readMessages: input.readLatest,
    eager: input.eager ?? !input.isReopen,
    isCurrent: input.isCurrent,
    shouldReadMessages: (metadata) => shouldRefreshLatestMessageWindowOnReopen({
      freshSession: metadata,
      storedSession: input.storedSession,
      messageWindowSynced: input.isWindowSynced(metadata),
    }),
    commitMessages: (history) => {
      input.commitMessages?.(history);
      markHistorySynced();
    },
  });
  if (input.isCurrent()) {
    input.commit(session, page);
    if (page === null) markHistorySynced();
  }
}
