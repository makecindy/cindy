import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscordIM, DiscordOperationError, type DiscordIMOptions, type IMHost } from '@cindy/im';
import { createDiscordMcpServer } from '../discordMcpServer';
import { beginChannelToolScope, resetChannelToolScopeForTests } from '../../im/shared/channelToolScope';

// unit: actual MCP protocol -> DiscordIM -> narrow REST adapter. Previous IM tests have no ordinary-task
// discovery, companion fallback, expiring per-turn lease or file handoff coverage. Fake credentials/network only.
afterEach(() => resetChannelToolScopeForTests());
type DiscordGatewayFactory = NonNullable<DiscordIMOptions['gatewayFactory']>;
async function setup(scope: 'owner' | 'group' | 'companion' | 'missing' = 'owner', workingDir = os.tmpdir()) {
  let allowed = true;
  let originCurrent = true;
  let release = () => {};
  let afterFetch = () => {};
  const secrets = new Map([['discord-bot-token', 'fake-not-a-token'], ['discord-owner-user-id', '1'], ['discord-bot-lifecycle-announcement', 'false']]);
  const rest = { get: vi.fn(async () => []), post: vi.fn(async () => ({ id: '90' })), put: vi.fn(), delete: vi.fn(), patch: vi.fn() };
  const channel = { id: '30', guildId: '10', parentId: '20', parent: { id: '20', guildId: '10', type: 0 }, type: 11, name: 'thread', isTextBased: () => true, isSendable: () => true, messages: {}, permissionsFor: () => ({ has: () => true }), send: vi.fn(async () => ({ id: '91' })) };
  const sdk = { user: { id: '2' }, rest, channels: { fetch: vi.fn(async () => { afterFetch(); return channel; }), cache: new Map([['30', channel]]) } };
  const host: IMHost = {
    secrets: { read: key => secrets.get(key) ?? null, write: (key, value) => { secrets.set(key, value); return true; }, remove: key => { secrets.delete(key); }, isAvailable: () => true },
    ipc: { handle() {}, broadcast() {}, throwIpcError() { throw new Error('invalid'); } },
    paths: { feishuMediaDir: os.tmpdir() }, httpPostForm: async () => ({ status: 200, body: {} }),
  };
  const im = new DiscordIM(host, { gatewayFactory: (ev: Parameters<DiscordGatewayFactory>[0]) => ({
    appId: '2', botTag: 'fake', client: sdk, connect: async () => ev.onStatus({ kind: 'connected', appId: 'fake' }), destroy: async () => {},
  }) as unknown as ReturnType<DiscordGatewayFactory>, channelAccess: { read: () => ({ channels: [{ guildId: '10', channelId: '20', allowMembers: true }] }) } });
  await im.init();
  const personalAccess = vi.fn(async () => {
    if (scope !== 'owner') throw new DiscordOperationError('DISCORD_TRIGGER_TRANSPORT_REQUIRED');
    return { im, assertCurrent: () => { if (!allowed) throw new DiscordOperationError('DISCORD_CALLER_CHANGED'); } };
  });
  if (scope === 'group' || scope === 'companion') release = beginChannelToolScope({ sessionId: 's', sessionInstanceId: 'i', scope: {
    channel: 'discord', im, botId: '2', laneUserId: 'g/10/20/30', chatId: '30', chatKind: 'group', requesterIsOwner: scope === 'companion', companion: scope === 'companion', triggerMessageId: '8',
    assertCurrent: () => { if (!originCurrent) throw new DiscordOperationError('DISCORD_SCOPE_ACCOUNT_CHANGED'); },
  } });
  const authorizeFile = vi.fn(async () => true);
  const server = createDiscordMcpServer({ getSessionContext: () => ({ agentKind: 'codex', sessionId: 's', sessionInstanceId: 'i', workingDir }), personalAccess, authorizeFile });
  const client = new Client({ name: 'discord-test', version: '1' }); const [tx, sx] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(sx), client.connect(tx)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const output = await client.callTool({ name, arguments: args });
    return { error: output.isError, body: JSON.parse((output.content as Array<{ text: string }>)[0].text) };
  };
  return { call, rest, channel, personalAccess, authorizeFile, expire: () => release(), afterFetch: (fn: () => void) => { afterFetch = fn; }, revokeOrigin: () => { originCurrent = false; }, revokeAccount: () => { allowed = false; }, close: async () => { release(); await client.close(); await server.close(); await im.dispose(); } };
}
describe('Discord MCP host bridge', () => {
  it('lets an ordinary owner task discover schemas and actively send through the existing personal bot', async () => {
    const h = await setup();
    try {
      expect((await h.call('list_tools')).body.data.map((t: { name: string }) => t.name)).toContain('search');
      expect((await h.call('list_tools', { name: 'history' })).body.data.inputSchema.properties.limit.maximum).toBe(50);
      expect((await h.call('call_tool', { name: 'send_message', args: { lane: 'g/10/20/30', text: 'hello' } })).error).not.toBe(true);
      expect(h.rest.post).toHaveBeenCalledTimes(1);
      h.revokeAccount(); expect((await h.call('status')).error).toBe(true);
    } finally { await h.close(); }
  });
  it('keeps public/member turns inside their lane and prevents member edits/deletes', async () => {
    const h = await setup('group');
    try {
      expect((await h.call('call_tool', { name: 'history', args: { lane: '1' } })).body.errorCode).toBe('DISCORD_LANE_DENIED');
      expect((await h.call('call_tool', { name: 'edit_message', args: { message_id: '7', text: 'edit' } })).body.errorCode).toBe('DISCORD_OWNER_REQUIRED');
      expect((await h.call('call_tool', { name: 'send_message', args: { text: 'in lane' } })).error).not.toBe(true);
      expect(h.personalAccess).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });
  it('rejects a lease lost during fetch and never falls back from a companion to the personal bot', async () => {
    const h = await setup('companion');
    try {
      h.afterFetch(() => h.expire());
      expect((await h.call('call_tool', { name: 'send_message', args: { text: 'late' } })).body.errorCode).toBe('DISCORD_SCOPE_EXPIRED');
      expect(h.rest.post).not.toHaveBeenCalled();
      expect((await h.call('call_tool', { name: 'send_message', args: { lane: 'g/10/20/30', text: 'fallback' } })).body.errorCode).toBe('DISCORD_TRIGGER_TRANSPORT_REQUIRED');
      expect(h.rest.post).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });
  it('rejects an origin-account change even while the old scope object is still registered', async () => {
    const h = await setup('companion');
    try {
      h.afterFetch(() => h.revokeOrigin());
      expect((await h.call('call_tool', { name: 'send_message', args: { text: 'stale account' } })).body.errorCode).toBe('DISCORD_SCOPE_ACCOUNT_CHANGED');
      expect(h.rest.post).not.toHaveBeenCalled(); expect(h.personalAccess).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });
  it('sends current-workdir files through the existing attachment path; members cannot borrow an owner outside-path grant', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-discord-files-')); const work = path.join(root, 'work'); await fs.mkdir(work);
    const inside = path.join(work, 'answer.txt'); const outside = path.join(root, 'private.txt'); await fs.writeFile(inside, 'answer'); await fs.writeFile(outside, 'private');
    const h = await setup('group', work);
    try {
      expect((await h.call('call_tool', { name: 'send_file', args: { path: outside } })).body.errorCode).toBe('FILE_ACCESS_DENIED');
      expect(h.authorizeFile).not.toHaveBeenCalled(); expect(h.channel.send).not.toHaveBeenCalled();
      expect((await h.call('call_tool', { name: 'send_file', args: { path: inside } })).error).not.toBe(true); expect(h.channel.send).toHaveBeenCalledTimes(1);
    } finally { await h.close(); await fs.rm(root, { recursive: true, force: true }); }
  });

  // unit: real MCP -> DiscordIM file handoff. Missing local paths previously looked like an
  // uncertain Discord write; existing coverage only checked valid files/outside-workdir denial.
  // The smallest failure is realpath ENOENT. Mock only FS metadata; no new disk/network resources.
  describe('send_file local preflight', () => {
    const workingDir = path.join(os.tmpdir(), 'cindy-discord-preflight');
    const file = path.join(workingDir, 'answer.txt');
    const mockMetadata = () => ({
      realpath: vi.spyOn(fs, 'realpath').mockImplementation(async candidate => String(candidate)),
      stat: vi.spyOn(fs, 'stat').mockResolvedValue({ isFile: () => true, size: 6 } as Awaited<ReturnType<typeof fs.stat>>),
    });
    afterEach(() => vi.restoreAllMocks());

    it.each([
      { boundary: 'file', code: 'ENOENT', expected: 'FILE_NOT_FOUND' },
      { boundary: 'workingDir', code: 'ENOENT', expected: 'FILE_NOT_FOUND' },
      { boundary: 'stat', code: 'ENOENT', expected: 'FILE_NOT_FOUND' },
      { boundary: 'file', code: 'ENOTDIR', expected: 'FILE_NOT_FOUND' },
      { boundary: 'file', code: 'EACCES', expected: 'FILE_ACCESS_DENIED' },
      { boundary: 'workingDir', code: 'EPERM', expected: 'FILE_ACCESS_DENIED' },
      { boundary: 'stat', code: 'EIO', expected: 'FILE_READ_FAILED' },
    ])('returns $expected for $code at $boundary without sending', async ({ boundary, code, expected }) => {
      const h = await setup('owner', workingDir);
      const metadata = mockMetadata();
      const error = Object.assign(new Error(`private FS details: ${file}`), { code });
      if (boundary === 'stat') metadata.stat.mockRejectedValueOnce(error);
      else if (boundary === 'workingDir') metadata.realpath.mockResolvedValueOnce(file).mockRejectedValueOnce(error);
      else metadata.realpath.mockRejectedValueOnce(error);
      try {
        const output = await h.call('call_tool', { name: 'send_file', args: { lane: 'g/10/20/30', path: file } });
        expect(output.error).toBe(true);
        expect(output.body).toEqual({ ok: false, errorCode: expected });
        expect(h.channel.send).not.toHaveBeenCalled();
        expect(h.authorizeFile).not.toHaveBeenCalled();
      } finally { await h.close(); }
    });

    it('keeps an upload Abort unconfirmed and calls send only once', async () => {
      const h = await setup('owner', workingDir);
      mockMetadata();
      h.channel.send.mockRejectedValueOnce(Object.assign(new Error('private transport details'), { name: 'AbortError' }));
      try {
        const output = await h.call('call_tool', { name: 'send_file', args: { lane: 'g/10/20/30', path: file } });
        expect(output.body).toEqual({ ok: false, errorCode: 'DISCORD_OPERATION_UNCONFIRMED' });
        expect(h.channel.send).toHaveBeenCalledTimes(1);
      } finally { await h.close(); }
    });

    it.each([
      { scope: 'owner' as const, expected: 'DISCORD_CALLER_CHANGED' },
      { scope: 'companion' as const, expected: 'DISCORD_SCOPE_ACCOUNT_CHANGED' },
    ])('preserves the $scope identity error when FS rejects after revocation', async ({ scope, expected }) => {
      const h = await setup(scope, workingDir);
      const metadata = mockMetadata();
      metadata.realpath.mockImplementationOnce(async () => {
        if (scope === 'owner') h.revokeAccount(); else h.revokeOrigin();
        throw Object.assign(new Error(`private FS details: ${file}`), { code: 'ENOENT' });
      });
      try {
        const output = await h.call('call_tool', { name: 'send_file', args: { lane: 'g/10/20/30', path: file } });
        expect(output.body).toEqual({ ok: false, errorCode: expected });
        expect(h.channel.send).not.toHaveBeenCalled();
      } finally { await h.close(); }
    });
  });
});
