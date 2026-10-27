import { z } from 'zod';
import { companionMessageHash, type CompanionReceiptStore } from './chatCompanionMessageReceipts.js';

const room = z.object({ id: z.string().uuid(), name: z.string(), kind: z.string(), state: z.string(),
  archived: z.boolean(), dissolved_at: z.string().nullable().optional() });
const member = z.object({ id: z.string(), kind: z.string(), state: z.string(), ownerActorId: z.string() });
const target = z.object({ botId: z.string().min(1), groupId: z.string().uuid(),
  idempotencyKey: z.string().regex(/^[\w-]{8,100}$/) });
export type CompanionGroupRequest = z.infer<typeof target>;
type Failure = { ok: false; errorCode: string; message: string };
export type CompanionGroupReceipt = { ok: true; groupId: string; status: 'confirmed' | 'unknown' | 'not_recorded';
  messageId?: string; read: null; mayTriggerReplies: true };
export interface CompanionGroupMessages {
  list(botId: string, assertCurrent: () => Promise<void>): Promise<{ ok: true; groups: Array<{ id: string; name: string }> } | Failure>;
  send(input: CompanionGroupRequest & { message: string }, assertCurrent: () => Promise<void>): Promise<CompanionGroupReceipt | Failure>;
  check(input: CompanionGroupRequest, assertCurrent: () => Promise<void>): Promise<CompanionGroupReceipt | Failure>;
}

/** Host-only surface: botId and the guard come from the owning private Session, not model arguments. */
export function createCompanionGroupMessages(deps: {
  identity(botId: string): Promise<{ actorId: string; ownerId: string }>;
  api<T>(route: string, method?: string, body?: unknown, actorId?: string): Promise<T>;
  receipts(ownerId: string): CompanionReceiptStore;
  changed(groupId: string): void;
}): CompanionGroupMessages {
  const failure = (error: unknown): Failure => {
    const code = error instanceof z.ZodError ? 'INVALID_ARGS'
      : error instanceof Error && ['GROUP_UNAVAILABLE', 'MEMBER_UNAVAILABLE', 'BOT_UNAVAILABLE',
        'OWNER_CHANGED', 'IDEMPOTENCY_CONFLICT', 'GROUP_MESSAGE_REJECTED', 'TASK_ACTION_AUTHORIZATION_EXPIRED'].includes(error.message)
        ? error.message : 'GROUP_MESSAGE_UNAVAILABLE';
    return { ok: false, errorCode: code, message: code };
  };
  async function rooms(actorId: string, guard: () => Promise<void>) {
    const result: Array<z.infer<typeof room>> = [];
    let after: string | undefined;
    const cursors = new Set<string>();
    do {
      await guard();
      const page = z.array(room).parse(await deps.api(`/conversations?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`, 'GET', undefined, actorId));
      await guard();
      result.push(...page.filter(r => r.kind === 'group' && r.state === 'joined' && !r.archived && !r.dissolved_at));
      after = page.length === 100 ? page.at(-1)!.id : undefined;
      if (after && cursors.has(after)) throw new Error('GROUP_MESSAGE_UNAVAILABLE');
      if (after) cursors.add(after);
    } while (after);
    return result;
  }
  async function access(botId: string, groupId: string | undefined, guard: () => Promise<void>) {
    await guard();
    const identity = await deps.identity(botId);
    await guard();
    const groups = await rooms(identity.actorId, guard);
    if (groupId) {
      if (!groups.some(r => r.id === groupId)) throw new Error('GROUP_UNAVAILABLE');
      const members = z.array(member).parse(await deps.api(`/conversations/${groupId}/members`, 'GET', undefined, identity.actorId));
      await guard();
      if (!members.some(m => m.id === identity.actorId && m.kind === 'bot' && m.state === 'joined' && m.ownerActorId === identity.ownerId))
        throw new Error('MEMBER_UNAVAILABLE');
    }
    return { ...identity, groups };
  }
  const keyFor = (actorId: string, input: CompanionGroupRequest) => companionMessageHash(JSON.stringify([actorId, input.groupId, input.idempotencyKey]));
  const receipt = (groupId: string, messageId?: string, absent = false): CompanionGroupReceipt => ({
    ok: true, groupId, status: messageId ? 'confirmed' : absent ? 'not_recorded' : 'unknown',
    ...(messageId ? { messageId } : {}), read: null, mayTriggerReplies: true,
  });
  return {
    async list(botId, guard) {
      try {
        const { groups } = await access(botId, undefined, guard);
        return { ok: true, groups: groups.map(({ id, name }) => ({ id, name })) };
      } catch (error) { return failure(error); }
    },
    async check(input, guard) {
      try {
        const i = target.parse(input);
        const { actorId, ownerId } = await access(i.botId, i.groupId, guard);
        const saved = deps.receipts(ownerId).read(keyFor(actorId, i));
        if (saved?.rejected) throw new Error('GROUP_MESSAGE_REJECTED');
        // No server operation-ID lookup exists in the current client contract. Absence is not proof of non-delivery.
        return receipt(i.groupId, saved?.messageId, !saved);
      } catch (error) { return failure(error); }
    },
    async send(input, guard) {
      try {
        const i = target.extend({ message: z.string().min(1).max(8000).refine(text => !!text.trim()) }).parse(input);
        const { actorId, ownerId } = await access(i.botId, i.groupId, guard);
        const store = deps.receipts(ownerId);
        const key = keyFor(actorId, i);
        const fingerprint = companionMessageHash(i.message);
        const saved = store.read(key);
        if (saved && saved.fingerprint !== fingerprint) throw new Error('IDEMPOTENCY_CONFLICT');
        if (saved?.rejected) throw new Error('GROUP_MESSAGE_REJECTED');
        if (saved) return receipt(i.groupId, saved.messageId);
        await guard();
        if (!store.reserve(key, fingerprint)) {
          const winner = store.read(key);
          if (!winner || winner.fingerprint !== fingerprint) throw new Error('IDEMPOTENCY_CONFLICT');
          if (winner.rejected) throw new Error('GROUP_MESSAGE_REJECTED');
          return receipt(i.groupId, winner.messageId);
        }
        // Once reserved, even a process crash before POST is conservatively unknown. Never manufacture a fresh ID.
        try {
          await guard();
          const posted = z.object({ id: z.string().uuid() }).parse(await deps.api(`/conversations/${i.groupId}/messages`, 'POST', {
            operationId: `companion-group:${key}`, content: [{ type: 'text', text: i.message }], mentions: [],
          }, actorId));
          await guard();
          store.confirm(key, { fingerprint, messageId: posted.id });
          deps.changed(i.groupId);
          return receipt(i.groupId, posted.id);
        } catch (error) {
          // Recheck the owner before returning any information from the prior account.
          await guard();
          const status = (error as { status?: number } | null)?.status;
          if (status && status >= 400 && status < 500 && status !== 408) {
            store.confirm(key, { fingerprint, rejected: true });
            return failure(new Error('GROUP_MESSAGE_REJECTED'));
          }
          return receipt(i.groupId);
        }
      } catch (error) { return failure(error); }
    },
  };
}
