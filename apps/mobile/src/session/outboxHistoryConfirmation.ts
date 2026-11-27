import {
  HISTORY_VIEW_VERSION,
  historyViewLeaves,
  type HistoryViewPage,
} from '@cindy/maker-shared/message-window';
import type { RemoteInvoke } from '../device-link/mobileMakerTransport';
import type { DurableOutboxRecord } from './durableOutbox';
import type { RemoteMessage } from './types';

/** The pre-capability Host serves this bounded history page on the existing IPC channel. */
export async function readLegacyOutboxHistory(
  record: Pick<DurableOutboxRecord, 'deviceId' | 'item'>,
  invoke: RemoteInvoke,
): Promise<RemoteMessage | undefined> {
  const { sessionId, clientId } = record.item;
  const page = await invoke<HistoryViewPage<RemoteMessage>>(
    record.deviceId, 'local-db:messages:view', [sessionId, { lazyDetails: true }],
  );
  if (page?.version !== HISTORY_VIEW_VERSION || !Array.isArray(page.items)) return undefined;
  for (const item of historyViewLeaves(page.items)) {
    if (item.type !== 'messages') continue;
    // A live or projected row without its database insertion identity cannot prove delivery.
    const row = item.messages.find((message) => message.sessionId === sessionId
      && message.role === 'user' && message.clientId === clientId && Number.isSafeInteger(message.rowid));
    if (row) return row;
  }
  // Do not follow the cursor or treat a partial page as proof of non-delivery.
  return undefined;
}
