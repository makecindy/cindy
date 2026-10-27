import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCompanionGroupMessages } from '../chatCompanionMessages.js';
import { companionMessageReceiptFiles } from '../chatCompanionMessageReceipts.js';

// #6800: real send/receipt entry and filesystem, only the remote HTTP boundary is injected.
// Existing task-card tests cannot cover plain bot text or durable unknown deliveries. Unit tier.
describe('private teammate group delivery', () => {
  let root: string;
  const groupId = '10000000-0000-4000-8000-000000000001';
  const other = '10000000-0000-4000-8000-000000000002';
  const messageId = '20000000-0000-4000-8000-000000000001';
  const input = { botId: 'bot', groupId, message: '  Only this text\n@everyone stays plain text  ', idempotencyKey: 'request-123' };
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'cindy-group-send-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  function harness() {
    let current = true;
    let joined = true;
    let owner = 'owner';
    let archived = false;
    const posts: unknown[] = [];
    const reads: string[] = [];
    const post = vi.fn(async () => ({ id: messageId }));
    const guard = async () => { if (!current) throw new Error('OWNER_CHANGED'); };
    const api = async <T>(route: string, method?: string, body?: unknown, actorId?: string): Promise<T> => {
      expect(actorId).toBe('actor');
      if (method === 'POST') { posts.push({ route, body, actorId }); return await post() as T; }
      reads.push(route);
      if (route.startsWith('/conversations?')) return [groupId, other].map(id => ({ id, name: 'Same name', kind: 'group', state: 'joined', archived })) as T;
      if (route.endsWith('/members')) return [{ id: 'actor', kind: 'bot', state: joined ? 'joined' : 'left', ownerActorId: owner }] as T;
      throw new Error('Unexpected read of private history');
    };
    const make = () => createCompanionGroupMessages({
      identity: async () => ({ actorId: 'actor', ownerId: 'owner' }), api,
      receipts: () => companionMessageReceiptFiles(root, () => current), changed: vi.fn(),
    });
    return { service: make(), make, post, posts, reads, guard, setCurrent: (v: boolean) => { current = v; },
      leave: () => { joined = false; }, wrongOwner: () => { owner = 'other-owner'; }, archive: () => { archived = true; } };
  }
  it('preserves namesakes and exact text, uses the bot author, and confirms only server acceptance', async () => {
    const h = harness();
    expect(await h.service.list('bot', h.guard)).toEqual({ ok: true, groups: [groupId, other].map(id => ({ id, name: 'Same name' })) });
    expect(h.reads).toHaveLength(1);
    expect(await h.service.send(input, h.guard)).toMatchObject({ ok: true, status: 'confirmed', groupId, messageId, read: null, mayTriggerReplies: true });
    expect(h.posts).toEqual([{ route: `/conversations/${groupId}/messages`, actorId: 'actor', body: {
      operationId: expect.stringMatching(/^companion-group:[a-f0-9]{64}$/), content: [{ type: 'text', text: input.message }], mentions: [],
    } }]);
    expect(readFileSync(path.join(root, readdirSync(root)[0]), 'utf8')).not.toContain('Only this text');
    expect(await h.make().send(input, h.guard)).toMatchObject({ status: 'confirmed', messageId });
    expect(await h.make().check(input, h.guard)).toMatchObject({ status: 'confirmed', messageId });
    expect(h.posts).toHaveLength(1);
    expect(await h.service.send({ ...input, message: 'changed' }, h.guard)).toMatchObject({ ok: false, errorCode: 'IDEMPOTENCY_CONFLICT' });
  });
  it.each(['left', 'wrong-owner', 'archived', 'account-change', 'wrong-id'] as const)('rejects %s before sending', async kind => {
    const h = harness();
    if (kind === 'left') h.leave();
    if (kind === 'wrong-owner') h.wrongOwner();
    if (kind === 'archived') h.archive();
    if (kind === 'account-change') h.setCurrent(false);
    expect(await h.service.send({ ...input, ...(kind === 'wrong-id' ? { groupId: messageId } : {}) }, h.guard)).toMatchObject({ ok: false });
    expect(h.posts).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
  });
  it('reserves once across concurrent calls and does not replay a lost response after restart', async () => {
    const h = harness();
    h.post.mockRejectedValue(new Error('lost response'));
    const results = await Promise.all([h.service.send(input, h.guard), h.make().send(input, h.guard)]);
    expect(results).toEqual([expect.objectContaining({ status: 'unknown' }), expect.objectContaining({ status: 'unknown' })]);
    expect(await h.make().check(input, h.guard)).toMatchObject({ status: 'unknown' });
    expect(await h.make().send(input, h.guard)).toMatchObject({ status: 'unknown' });
    expect(h.posts).toHaveLength(1);
    expect(await h.service.check({ ...input, idempotencyKey: 'unseen-request' }, h.guard)).toMatchObject({ status: 'not_recorded' });
    expect(h.posts).toHaveLength(1);
  });
  it('retains definite refusal separately from ambiguous delivery', async () => {
    const h = harness();
    h.post.mockRejectedValue(Object.assign(new Error('private server details'), { status: 403 }));
    expect(await h.service.send(input, h.guard)).toEqual({ ok: false, errorCode: 'GROUP_MESSAGE_REJECTED', message: 'GROUP_MESSAGE_REJECTED' });
    expect(await h.make().check(input, h.guard)).toMatchObject({ ok: false, errorCode: 'GROUP_MESSAGE_REJECTED' });
    expect(await h.make().send(input, h.guard)).toMatchObject({ ok: false });
    expect(h.posts).toHaveLength(1);
  });
  it('rejects authority lost during the HTTP call without returning or saving prior-account confirmation', async () => {
    const h = harness();
    h.post.mockImplementation(async () => { h.setCurrent(false); return { id: messageId }; });
    expect(await h.service.send(input, h.guard)).toMatchObject({ ok: false, errorCode: 'OWNER_CHANGED' });
    h.setCurrent(true);
    expect(await h.make().check(input, h.guard)).toMatchObject({ status: 'unknown' });
  });
  it('does not treat a damaged reservation as absent or overwrite it', async () => {
    const h = harness();
    await h.service.send(input, h.guard);
    const file = path.join(root, readdirSync(root)[0]);
    writeFileSync(file, '{');
    expect(await h.make().send(input, h.guard)).toMatchObject({ ok: false });
    expect(h.posts).toHaveLength(1);
    expect(readFileSync(file, 'utf8')).toBe('{');
  });
});
