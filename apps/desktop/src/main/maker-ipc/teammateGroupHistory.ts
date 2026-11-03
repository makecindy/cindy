import { readBotGroupThreadShareCard, readBotGroupQuoteCard, readBotGroupQuote,
  botGroupQuoteExcerpt, botGroupQuoteAttachmentName, type BotGroupMessageView } from '../../shared/botGroupChat.js';

/** Read as the companion actor, never as its owner. No local history cache or read receipts. */
export interface TeammateGroupHistoryQuery {
  botId: string;
  groupId?: string;
  query?: string;
  before?: string;
  limit?: number;
}
interface Room { id: string; name: string; kind?: string; state: string }
interface Message {
  id: string; seq: string; deleted: boolean; createdAt: string; threadRootId: string | null;
  author: { name: string; kind: string };
  maskAttribution?: BotGroupMessageView['maskAttribution'];
  content: Array<{ type: string; text?: string; fallback?: string; caption?: string }>;
}
type HistoryQuote = { messageId: string; deleted: true } | {
  messageId: string; from: string; text: string; attachmentCount: number;
  attachmentName: string | null; snapshot?: true;
};
// Match the execution context: recognized references never contribute their fallback
// to the author's own words. Unknown card revisions remain ordinary readable content.
const historyText = (message: Message) => readBotGroupThreadShareCard(message) ? ''
  : message.content.filter(block => block.type !== 'media' && !readBotGroupQuoteCard(block))
    .map(block => block.text ?? block.fallback ?? '').join('\n');
function historyQuote(message: Message, known: ReadonlyMap<string, Message>): HistoryQuote | undefined {
  const quote = readBotGroupQuote(message.content);
  if (!quote) return;
  const candidate = known.get(quote.messageId);
  const original = candidate?.threadRootId === null ? candidate : undefined;
  if (original?.deleted) return { messageId: quote.messageId, deleted: true };
  if (!original) return { messageId: quote.messageId, from: quote.authorName, text: quote.excerpt,
    attachmentCount: quote.attachmentCount, attachmentName: quote.attachmentName, snapshot: true };
  const files = original.content.filter(block => block.type === 'media').map(block => ({ name: block.caption ?? '' }));
  return { messageId: quote.messageId, from: original.author.name, text: botGroupQuoteExcerpt(historyText(original)),
    attachmentCount: files.length, attachmentName: botGroupQuoteAttachmentName(files) };
}
export interface TeammateGroupHistoryResult {
  groups?: Array<{ id: string; name: string }>;
  messages?: Array<{ id: string; sequence: string; author: string; authorKind: string; createdAt: string; threadRootId: string | null; text: string; attachments: string[]; maskAttribution?: BotGroupMessageView['maskAttribution']; sharedReplyId?: string; quote?: HistoryQuote }>;
  nextCursor: string | null;
  hasMore: boolean;
}
export function createTeammateGroupHistoryReader(deps: {
  api<T>(route: string, actorId: string): Promise<T>;
  assertCurrent(): void;
}) {
  return async (actorId: string, input: Omit<TeammateGroupHistoryQuery, 'botId'>): Promise<TeammateGroupHistoryResult> => {
    const limit = Math.max(1, Math.min(50, Math.floor(input.limit ?? 20)));
    deps.assertCurrent();
    if (!input.groupId) {
      const page = await deps.api<Room[]>(`/conversations?limit=${limit}${input.before ? `&after=${encodeURIComponent(input.before)}` : ''}`, actorId);
      deps.assertCurrent();
      return { groups: page.filter(room => room.state === 'joined' && room.kind === 'group').map(({ id, name }) => ({ id, name })),
        hasMore: page.length === limit, nextCursor: page.length === limit ? page.at(-1)!.id : null };
    }
    const roomId = encodeURIComponent(input.groupId);
    // The server checks this actor's live membership and its history visibility window.
    // Read again after fetching content: a revocation during the read must not return content.
    const joined = async () => {
      const members = await deps.api<Array<{ id: string; kind: string; state: string }>>(`/conversations/${roomId}/members`, actorId);
      deps.assertCurrent();
      if (!members.some(member => member.id === actorId && member.kind === 'bot' && member.state === 'joined')) throw new Error('PERMISSION_DENIED');
    };
    const snapshot = await deps.api<{ room: { kind?: string }; messages?: Message[]; members: Array<{ id: string; kind: string; state: string }> }>(`/conversations/${roomId}/snapshot`, actorId);
    deps.assertCurrent();
    if (snapshot.room.kind !== 'group' || !snapshot.members.some(member => member.id === actorId && member.kind === 'bot' && member.state === 'joined')) throw new Error('PERMISSION_DENIED');
    const page = await deps.api<Message[]>(`/conversations/${roomId}/messages?all=true&limit=${limit}${input.before ? `&before=${encodeURIComponent(input.before)}` : ''}`, actorId);
    deps.assertCurrent();
    // Only this authorized request's reads inform reference state. No cross-page
    // cache or extra fetches; the later page takes precedence over the snapshot.
    const known = new Map([...(snapshot.messages ?? []), ...page].map(message => [message.id, message]));
    const ordered = [...page].sort((a, b) => BigInt(a.seq) > BigInt(b.seq) ? -1 : BigInt(a.seq) < BigInt(b.seq) ? 1 : 0);
    const messages: NonNullable<TeammateGroupHistoryResult['messages']> = [];
    const query = input.query?.toLocaleLowerCase();
    let budget = 16_000;
    let scanned: string | null = null;
    for (const message of ordered) {
      const shared = readBotGroupThreadShareCard(message);
      // As in the execution context, a share is a reference: its fallback may
      // outlive edits/deletion of the original and is never authoritative text.
      const text = historyText(message);
      const quote = historyQuote(message, known);
      const searchable = [text, quote && !('deleted' in quote) ? quote.text : ''].join('\n');
      if (!message.deleted && (!query || searchable.toLocaleLowerCase().includes(query))) {
        const record = { id: message.id, sequence: message.seq, author: message.author.name, authorKind: message.author.kind,
          createdAt: message.createdAt, threadRootId: message.threadRootId, text,
          ...(shared ? { sharedReplyId: shared.messageId } : {}),
          ...(quote ? { quote } : {}),
          ...(message.maskAttribution ? { maskAttribution: message.maskAttribution } : {}),
          attachments: message.content.filter(block => block.type === 'media').map(block => block.caption ?? '') };
        // Budget the actual serialized record, including captions, metadata and
        // escaping. Return an oversized first record whole so the cursor advances.
        const size = Buffer.byteLength(JSON.stringify(record), 'utf8');
        if (messages.length && size > budget) break;
        messages.push(record);
        budget -= size;
      }
      scanned = message.seq;
    }
    await joined();
    const hasMore = scanned !== (ordered.at(-1)?.seq ?? null) || page.length === limit;
    return { messages, nextCursor: hasMore ? scanned : null, hasMore };
  };
}
