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
  content: Array<{ type: string; text?: string; fallback?: string; caption?: string }>;
}
export interface TeammateGroupHistoryResult {
  groups?: Array<{ id: string; name: string }>;
  messages?: Array<{ id: string; sequence: string; author: string; authorKind: string; createdAt: string; threadRootId: string | null; text: string; attachments: string[] }>;
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
    const snapshot = await deps.api<{ room: { kind?: string }; members: Array<{ id: string; kind: string; state: string }> }>(`/conversations/${roomId}/snapshot`, actorId);
    deps.assertCurrent();
    if (snapshot.room.kind !== 'group' || !snapshot.members.some(member => member.id === actorId && member.kind === 'bot' && member.state === 'joined')) throw new Error('PERMISSION_DENIED');
    const page = await deps.api<Message[]>(`/conversations/${roomId}/messages?all=true&limit=${limit}${input.before ? `&before=${encodeURIComponent(input.before)}` : ''}`, actorId);
    deps.assertCurrent();
    const ordered = [...page].sort((a, b) => BigInt(a.seq) > BigInt(b.seq) ? -1 : BigInt(a.seq) < BigInt(b.seq) ? 1 : 0);
    const messages: NonNullable<TeammateGroupHistoryResult['messages']> = [];
    const query = input.query?.toLocaleLowerCase();
    let budget = 16000;
    let scanned: string | null = null;
    for (const message of ordered) {
      const text = message.content.filter(block => block.type !== 'media').map(block => block.text ?? block.fallback ?? '').join('\n');
      if (!message.deleted && (!query || text.toLocaleLowerCase().includes(query))) {
        // Stop before a whole record, so pagination never skips or silently truncates it.
        if (messages.length && text.length > budget) break;
        messages.push({ id: message.id, sequence: message.seq, author: message.author.name, authorKind: message.author.kind,
          createdAt: message.createdAt, threadRootId: message.threadRootId, text,
          attachments: message.content.filter(block => block.type === 'media').map(block => block.caption ?? '') });
        budget -= text.length;
      }
      scanned = message.seq;
    }
    await joined();
    const hasMore = scanned !== (ordered.at(-1)?.seq ?? null) || page.length === limit;
    return { messages, nextCursor: hasMore ? scanned : null, hasMore };
  };
}
