import type { AgentInputQueuedMessage } from './agentInputQueue.js';

/** Only the public inputs used to construct an editable draft participate. */
export function dagQueueRecallContent(item: Pick<AgentInputQueuedMessage, 'clientId' | 'text' | 'chatMessage' | 'files' | 'mentions' | 'agentReferences'>): string {
  const message = item.chatMessage;
  return JSON.stringify([item.clientId, item.text, message.content, message.quotesEncoded, message.pastedTextRanges,
    message.slashCommandRanges, message.agentReferences, item.agentReferences, item.mentions, item.files,
    'retryFiles' in message ? message.retryFiles : null]);
}
export type DagQueueRecallApi = (id: string, clientId: string, digest: string, stamp: import('./dataOwnerPush.js').DataOwnerPushStamp) => Promise<DagQueueRecallResult>;
export type DagQueueRecallResult = { ok: true; sessionId: string; clientId: string } | { ok: false; reason: string };
