import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';
import { createDiscordOperations, discordOperationFailure, DiscordOperationError } from '../operations.js';

// unit: production REST adapter. First-phase send tests cannot observe REST history/search or lease expiry.
// Minimal failures: mismatched thread parent, revocation while fetch is pending, 202 search, other-author edit.
function harness(boundLane?: string) {
  let enabled = true;
  let current = true;
  let generation = 'grant-1';
  const rest = { get: vi.fn<(route: string, options?: { query: URLSearchParams }) => Promise<unknown>>(async () => []), post: vi.fn(async () => ({ id: '90' })), patch: vi.fn(), delete: vi.fn(), put: vi.fn() };
  const parent = { id: '20', guildId: '10', type: 0, name: 'parent', isTextBased: () => true, messages: {}, permissionsFor: () => ({ has: () => true }) };
  const thread = { ...parent, id: '30', type: 11, parentId: '20', name: 'thread' };
  const client = { user: { id: '2' }, rest, channels: { fetch: vi.fn(async (id: string) => id === '30' ? thread : parent), cache: new Map([['20', parent], ['30', thread]]) } } as unknown as Client;
  const tools = createDiscordOperations({ client: () => client, assertCurrent: () => { if (!current) throw new DiscordOperationError('EXPIRED'); }, laneEnabled: () => enabled, ownerId: '1', boundLane, authorizationStamp: () => generation });
  return { tools, rest, parent, thread, client, revoke: () => { enabled = false; }, regrant: () => { generation = 'grant-3'; }, expire: () => { current = false; } };
}
const raw = (id: string, channel_id = '30', author = '3') => ({ id, channel_id, author: { id: author, username: 'someone' }, content: `body-${id}`, timestamp: '2026-11-10T01:00:00Z', attachments: [] });

describe('Discord narrow operations', () => {
  it('reads thread-only recent history; filters unrelated REST objects and marks empty content', async () => {
    const h = harness('g/10/20/30');
    h.rest.get.mockResolvedValue([raw('8'), raw('9', '20'), { ...raw('7'), content: '' }]);
    const page = await h.tools.history('g/10/20/30', { before: '10' });
    expect(page.messages.map(m => m.id)).toEqual(['7', '8']);
    expect(page.messages[0].contentUnavailable).toBe(true);
    expect(h.rest.get.mock.calls[0][0]).toBe('/channels/30/messages');
    await expect(h.tools.history('g/10/20')).rejects.toMatchObject({ code: 'DISCORD_LANE_DENIED' });
    await expect(h.tools.history('1')).rejects.toMatchObject({ code: 'DISCORD_LANE_DENIED' });
  });
  it('rechecks whitelist and lease after channel fetch, before any POST', async () => {
    const h = harness('g/10/20/30');
    vi.mocked(h.client.channels.fetch).mockImplementationOnce(async () => { h.revoke(); return h.thread as never; });
    await expect(h.tools.send('g/10/20/30', 'private')).rejects.toMatchObject({ code: 'DISCORD_LANE_DENIED' });
    expect(h.rest.post).not.toHaveBeenCalled();
    const other = harness();
    vi.mocked(other.client.channels.fetch).mockImplementationOnce(async () => { other.expire(); return other.parent as never; });
    await expect(other.tools.send('g/10/20', 'private')).rejects.toMatchObject({ code: 'EXPIRED' });
    expect(other.rest.post).not.toHaveBeenCalled();
  });
  it('checks actual thread parent and platform permission', async () => {
    const h = harness(); h.thread.parentId = '99';
    await expect(h.tools.history('g/10/20/30')).rejects.toMatchObject({ code: 'DISCORD_LANE_DENIED' });
    h.parent.permissionsFor = () => ({ has: () => false });
    await expect(h.tools.history('g/10/20')).rejects.toMatchObject({ code: 'DISCORD_PERMISSION_DENIED' });
  });
  it.each([undefined, 'g/10/20/30'])('does not reuse a revoked-then-regranted target across an await (scope %s)', async bound => {
    const h = harness(bound);
    vi.mocked(h.client.channels.fetch).mockImplementationOnce(async () => { h.regrant(); return h.thread as never; });
    await expect(h.tools.send('g/10/20/30', 'old input')).rejects.toMatchObject({ code: 'DISCORD_AUTHORIZATION_CHANGED' });
    expect(h.rest.post).not.toHaveBeenCalled();
  });
  it('uses official guild search scoped to one thread and reports indexing/rate/permission failures', async () => {
    const h = harness('g/10/20/30');
    h.rest.get.mockResolvedValueOnce({ code: 110000, retry_after: 2 });
    await expect(h.tools.search('g/10/20/30', 'find')).rejects.toMatchObject({ code: 'DISCORD_SEARCH_INDEXING', retryAfter: 2 });
    h.rest.get.mockResolvedValueOnce({ messages: [[raw('7'), raw('8', '20')], [raw('7')]], total_results: 2 });
    expect((await h.tools.search('g/10/20/30', 'find')).messages.map(m => m.id)).toEqual(['7']);
    const options = h.rest.get.mock.calls.at(-1)![1] as { query: URLSearchParams };
    expect(options.query.get('channel_id')).toBe('30');
    expect(discordOperationFailure({ status: 429, retry_after: 4 })).toEqual({ ok: false, errorCode: 'DISCORD_RATE_LIMITED', retryAfter: 4 });
    expect(discordOperationFailure({ status: 403 })).toMatchObject({ errorCode: 'DISCORD_PERMISSION_DENIED' });
  });
  it('allows only own-message edits/deletes and prevents automatic mentions on send', async () => {
    const h = harness(); h.rest.get.mockResolvedValueOnce(raw('7', '30', '3'));
    await expect(h.tools.changeOwnMessage('g/10/20/30', '7', 'edit')).rejects.toMatchObject({ code: 'DISCORD_NOT_OWN_MESSAGE' });
    expect(h.rest.patch).not.toHaveBeenCalled();
    h.rest.get.mockResolvedValueOnce(raw('7', '30', '2'));
    await h.tools.changeOwnMessage('g/10/20/30', '7'); expect(h.rest.delete).toHaveBeenCalledWith('/channels/30/messages/7');
    await h.tools.send('g/10/20/30', '@everyone', '7');
    expect(h.rest.post).toHaveBeenCalledWith('/channels/30/messages', expect.objectContaining({ body: expect.objectContaining({ allowed_mentions: { parse: [] }, message_reference: { message_id: '7', channel_id: '30', fail_if_not_exists: true } }) }));
  });
});
