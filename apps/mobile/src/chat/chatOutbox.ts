import type { BotGroupMessageView, BotGroupQuoteView } from '@cindy/maker-shared/botGroupChat';
import type { DurableOutboxRecord, DurableOutboxStore } from '@/session/durableOutbox';
import { buildOutboxItem } from '@/session/sessionOutbox';
import { chatAccessLost, type ChatSendInput, type createChatServerClient } from './chatServerClient';
import { cacheChatMessages, peekChatMessages } from './chatMessageCache';

export async function enqueueChatMessage(store: DurableOutboxStore, accountId: string, roomId: string,
  input: ChatSendInput, after: number, quote?: BotGroupQuoteView, afterServerSequence?: string): Promise<void> {
  if (!accountId || store.getAccountId() !== accountId) throw new Error('OUTBOX_OWNER_CHANGED');
  await store.add({ version: 1, accountId, deviceId: '', createdAt: Date.now(), state: 'queued', uploads: [],
    enqueueStarted: false, chat: { roomId, input, after, afterServerSequence, ...(quote ? { quote } : {}) },
    item: buildOutboxItem({ clientId: input.clientId, sessionId: roomId, text: input.text,
      permissionModeAtSend: 'default', readyAttachments: [], claimedUploads: [] }) });
}

export function pendingChatMessage(record: DurableOutboxRecord): BotGroupMessageView {
  return { id: `local:${record.item.clientId}`, sequence: record.chat!.after, kind: 'message',
    authorKind: 'user', authorBotId: null, authorName: '', isSelf: true,
    content: record.chat!.input.text, mentions: record.chat!.input.mentions,
    quote: record.chat!.quote, threadRootId: record.chat!.input.threadRootId,
    noticeCode: null, planId: null, files: [], attachments: [], createdAt: record.createdAt };
}

/** Remove a receipt only after its canonical message is durable on this phone. */
export async function settleChatOutbox(store: DurableOutboxStore, roomId: string, messageIds: ReadonlySet<string>) {
  for (const row of store.getSnapshot()) {
    if (row.chat?.roomId === roomId && row.chat.messageId && messageIds.has(row.chat.messageId)) await store.remove(row);
  }
}

/** A later rejoin must not silently send drafts written before access was removed. */
export async function suspendChatOutbox(store: DurableOutboxStore, roomId: string) {
  for (const row of store.getSnapshot()) {
    if (row.chat?.roomId === roomId && !row.suspended) {
      await store.update(row, { state: 'failed', suspended: true, error: 'CONVERSATION_NOT_FOUND' });
    }
  }
}

/** One account runner; uses the existing durable ledger, never the computer/session transport. */
export function createChatOutboxDelivery(deps: {
  store: DurableOutboxStore; client: ReturnType<typeof createChatServerClient>;
  current(): boolean; canRun(): boolean; accessLost(roomId: string): Promise<void>;
}) {
  let running: Promise<void> | undefined;
  const { store, client } = deps;
  const current = (row: DurableOutboxRecord) => deps.current() && store.getAccountId() === row.accountId
    && store.getSnapshot().includes(row);
  const run = async () => {
    const blocked = new Set<string>();
    for (let row of store.getSnapshot()) {
      if (!deps.canRun() || !deps.current()) return;
      if (!row.chat || !current(row)) continue;
      const room = row.chat.roomId;
      // A later rejection cannot disprove a previous POST whose outcome was lost.
      const previouslyStarted = row.enqueueStarted === true;
      if (blocked.has(room)) continue;
      if (row.suspended || row.state === 'failed') { blocked.add(room); continue; }
      const guard = () => {
        if (!current(row) || !deps.canRun()) throw new Error('OUTBOX_OWNER_CHANGED');
        if (client.personalList.hidden(room)) throw Object.assign(new Error('CONVERSATION_NOT_FOUND'), { status: 404 });
      };
      try {
        await client.syncListState(); guard();
        if (client.personalList.hidden(room)) {
          row = await store.update(row, { state: 'failed', suspended: true, error: 'CONVERSATION_NOT_FOUND' });
          blocked.add(room); await deps.accessLost(room); continue;
        }
        if (row.chat!.messageId) {
          const previous = peekChatMessages(room, row.chat!.input.threadRootId);
          const oldest = previous?.page.messages.reduce<string | undefined>((seq, message) => !seq || BigInt(message.seq) < BigInt(seq) ? message.seq : seq, undefined)
            ?? row.chat!.afterServerSequence;
          const [page, self, actors] = await Promise.all([client.load(room, oldest, row.chat!.input.threadRootId), client.me(), client.actors().catch(() => [])]);
          guard();
          if (await cacheChatMessages(room, { version: 1, page, self, actors })) {
            guard(); await settleChatOutbox(store, room, new Set(page.messages.map(message => message.id)));
          }
          continue;
        }
        let input = row.chat!.input;
        if (!row.chat!.body) {
          const [members, self] = await Promise.all([client.members(room), client.me()]); guard();
          const joined = members.filter(member => member.state === 'joined');
          if (input.mentions.botIds.some(id => !joined.some(member => member.id === id))) throw new Error('MENTION_UNAVAILABLE');
          const recipients = input.mentions.all ? joined.map(member => member.id) : input.mentions.botIds;
          input = { ...input, mentions: { all: false, botIds: [...new Set(recipients.filter(id => id !== self))] } };
        }
        row = await store.update(row, { state: 'sending', error: undefined,
          ...(row.chat!.body ? { enqueueStarted: true } : {}) }); guard();
        const receipt = await client.send(room, input, { body: row.chat!.body, save: async body => {
          guard(); row = await store.update(row, { chat: { ...row.chat!, body }, enqueueStarted: true }); guard();
        } });
        guard();
        if (!receipt || typeof receipt.id !== 'string' || !receipt.id) throw new Error('INVALID_CHAT_RECEIPT');
        // Keep the receipt until a durable history page contains the actual message.
        // This closes the restart gap between POST success and the next history read.
        await store.update(row, { state: 'confirming', chat: { ...row.chat!, messageId: receipt.id } });
      } catch (error) {
        if (!current(row) || !deps.current()) return;
        const status = (error as { status?: number })?.status;
        const message = error instanceof Error ? error.message : 'CHAT_SEND_FAILED';
        const refused = (status !== undefined && status >= 400 && status < 500 && ![401, 408, 429].includes(status))
          || ['MENTION_UNAVAILABLE', 'QUOTE_UNAVAILABLE'].includes(message);
        blocked.add(room);
        try {
          await store.update(row, { state: refused ? 'failed' : 'queued', error: message,
            // Only a definitive refusal with no earlier uncertain attempt releases the
            // intent for cancellation/recomposition. Never release a known receipt.
            ...(refused && !previouslyStarted && !row.chat!.messageId
              ? { enqueueStarted: false, chat: { ...row.chat!, body: undefined } } : {}),
            ...(chatAccessLost(error) ? { suspended: true } : {}) });
          if (chatAccessLost(error)) {
            await suspendChatOutbox(store, room);
            await deps.accessLost(room);
          }
        } catch { /* A failed disk write retains the last committed intent for the next foreground retry. */ }
      }
    }
  };
  return { run: () => {
    if (!running) running = run().finally(() => { running = undefined; });
    return running;
  } };
}
