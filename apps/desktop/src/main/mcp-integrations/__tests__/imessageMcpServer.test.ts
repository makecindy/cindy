import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it, vi } from 'vitest';
import { createIMessageMcpServer } from '../imessageMcpServer';
import { beginChannelToolScope } from '../../im/shared/channelToolScope';

// Tier 1: real MCP calls must obey active-turn identity and guest file boundaries.
// The transport tests cannot observe these host-only authorization decisions.
it('rejects stale scopes, cross-chat guest sends and files outside the guest working directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-imessage-tools-'));
  const work = path.join(root, 'work'); await fs.mkdir(work);
  const outside = path.join(root, 'private.txt'); await fs.writeFile(outside, 'private');
  const inside = path.join(work, 'answer.txt'); await fs.writeFile(inside, 'answer');
  const im = { sendText: vi.fn(async () => ({ messageId: 'sent' })), sendFile: vi.fn(async () => ({ ok: true as const, messageId: 'file' })),
    readHistory: vi.fn(async () => []), listChats: () => [{ guid: 'current' }, { guid: 'other' }],
    health: () => ({ lastCatchUpAt: null, lastWebhookAt: null, uncertainInputs: 0, uncertainSends: 0 }) };
  const server = createIMessageMcpServer({ getSessionContext: () => ({ agentKind: 'codex', sessionId: 's', sessionInstanceId: 'i', workingDir: work }) });
  const client = new Client({ name: 'imessage-test', version: '1' });
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
  let release = () => {};
  try {
    expect((await client.callTool({ name: 'send_text', arguments: { text: 'no scope' } })).isError).toBe(true);
    release = beginChannelToolScope({ sessionId: 's', sessionInstanceId: 'i', scope: {
      channel: 'imessage', im, botId: 'b', laneUserId: 'current', chatId: 'current', chatKind: 'group', requesterIsOwner: false, companion: true,
    } });
    expect((await client.callTool({ name: 'send_text', arguments: { text: 'hello', chat_id: 'other' } })).isError).toBe(true);
    expect((await client.callTool({ name: 'send_file', arguments: { path: outside } })).isError).toBe(true);
    expect(im.sendText).not.toHaveBeenCalled();
    expect(im.sendFile).not.toHaveBeenCalled();
    expect((await client.callTool({ name: 'send_file', arguments: { path: inside } })).isError).not.toBe(true);
    expect(im.sendFile).toHaveBeenCalledWith('current', await fs.realpath(inside), undefined);
    release();
    expect((await client.callTool({ name: 'send_text', arguments: { text: 'late' } })).isError).toBe(true);
    expect(im.sendText).not.toHaveBeenCalled();
  } finally { release(); await client.close(); await server.close(); await fs.rm(root, { recursive: true, force: true }); }
});

// Regression (owner 2026-11-22): the owner typed in a teammate's iMessage private-chat lane in Cindy
// and every send returned NO_ACTIVE_IMESSAGE_SCOPE, so the finished sample never reached the phone.
// Without an inbound turn the host may supply the lane's own chat; an inbound turn still wins.
it('falls back to the lane scope only when no inbound turn is active', async () => {
  const im = { sendText: vi.fn(async () => ({ messageId: 'sent' })), sendFile: vi.fn(async () => ({ ok: true as const, messageId: 'file' })),
    readHistory: vi.fn(async () => []), listChats: () => [{ guid: 'lane' }, { guid: 'inbound' }],
    health: () => ({ lastCatchUpAt: null, lastWebhookAt: null, uncertainInputs: 0, uncertainSends: 0 }) };
  let lane: Parameters<typeof beginChannelToolScope>[0]['scope'] | null = null;
  const laneScope = vi.fn(async () => lane as never);
  const server = createIMessageMcpServer({ getSessionContext: () => ({ agentKind: 'codex', sessionId: 's', sessionInstanceId: 'i', workingDir: '' }), laneScope });
  const client = new Client({ name: 'imessage-lane-test', version: '1' });
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
  let release = () => {};
  try {
    expect((await client.callTool({ name: 'send_text', arguments: { text: 'nothing' } })).isError).toBe(true);
    lane = { channel: 'imessage', im, botId: 'b', laneUserId: 'lane', chatId: 'lane', chatKind: 'direct', requesterIsOwner: true, companion: true };
    expect((await client.callTool({ name: 'send_text', arguments: { text: 'sample ready' } })).isError).not.toBe(true);
    expect(im.sendText).toHaveBeenLastCalledWith('lane', 'sample ready');
    // A lane scope whose turn has changed sends nothing.
    lane = { ...lane, assertCurrent: () => { throw new Error('IMESSAGE_LANE_TURN_CHANGED'); } };
    expect((await client.callTool({ name: 'send_text', arguments: { text: 'stale' } })).isError).toBe(true);
    expect(im.sendText).not.toHaveBeenCalledWith('lane', 'stale');
    release = beginChannelToolScope({ sessionId: 's', sessionInstanceId: 'i', scope: {
      channel: 'imessage', im, botId: 'b', laneUserId: 'inbound', chatId: 'inbound', chatKind: 'group', requesterIsOwner: false, companion: true,
    } });
    laneScope.mockClear();
    await client.callTool({ name: 'send_text', arguments: { text: 'reply' } });
    expect(im.sendText).toHaveBeenLastCalledWith('inbound', 'reply');
    expect(laneScope).not.toHaveBeenCalled();
  } finally { release(); await client.close(); await server.close(); }
});
