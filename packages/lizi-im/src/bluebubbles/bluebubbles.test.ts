import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IMHost, IMMessageEvent } from '../types.js';
import { LocalWebhookReceiver } from '../localWebhook.js';
import { BlueBubblesApi, type BlueBubblesMessage } from './api.js';
import { BlueBubblesIM } from './index.js';
import type { BlueBubblesState } from './state.js';

// Tier 1: exercise the real transport and HTTP receiver. Covers durable duplicate/restart
// handling and requester identity absent from other transports' tests; no real contacts.
const connections: BlueBubblesIM[] = [];
afterEach(async () => { await Promise.all(connections.splice(0).map(im => im.dispose())); });
async function fixture() {
  const secrets = new Map<string, string>();
  let saved: BlueBubblesState | null = null;
  let callbackUrl = '';
  let now = 1_000;
  const chat = { guid: 'any;-;owner@example.test', participants: [{ address: 'owner@example.test', service: 'iMessage' }] };
  const messages = new Map<string, BlueBubblesMessage>();
  const api = new BlueBubblesApi('http://127.0.0.1:1', 'test-only');
  vi.spyOn(api, 'info').mockResolvedValue({ server_version: '1.9.9' });
  vi.spyOn(api, 'chat').mockResolvedValue(chat);
  vi.spyOn(api, 'history').mockImplementation(async (_chat, after, before) => [...messages.values()].filter(row => row.dateCreated >= after && row.dateCreated <= before));
  vi.spyOn(api, 'message').mockImplementation(async guid => {
    const message = messages.get(guid); if (!message) throw new Error('missing'); return message;
  });
  vi.spyOn(api, 'registerWebhook').mockImplementation(async url => { callbackUrl = url; });
  const send = vi.spyOn(api, 'sendText').mockResolvedValue({ guid: 'outbound' });
  const host: IMHost = {
    secrets: { read: key => secrets.get(key) ?? null, write: (key, value) => { secrets.set(key, value); return true; },
      remove: key => { secrets.delete(key); }, isAvailable: () => true },
    ipc: { handle() {}, broadcast() {}, throwIpcError(_code, message): never { throw new Error(message); } },
    paths: { feishuMediaDir: 'unused' }, httpPostForm: async () => ({ status: 200, body: {} }),
  };
  const receiver = new LocalWebhookReceiver('127.0.0.1', 0);
  const im = new BlueBubblesIM(host, { secretPrefix: 'test-', api: () => api,
    receiver: () => receiver, resolvePeers: async () => ['127.0.0.1'], now: () => now,
    storage: { read: () => saved, write: state => { saved = structuredClone(state); } } });
  connections.push(im);
  const received: IMMessageEvent[] = [];
  im.onMessage(event => { received.push(event); });
  await im.saveCredentials({ serverUrl: api.origin, password: 'test-only', ownerAddress: 'owner@example.test',
    chatGuids: [chat.guid], listenHost: '127.0.0.1', listenPort: 18747 });
  const message = (guid: string, overrides: Partial<BlueBubblesMessage> = {}) => {
    now += 1;
    messages.set(guid, { guid, text: 'hello', isFromMe: false, dateCreated: now,
      chats: [chat], handle: { address: 'owner@example.test', service: 'iMessage' }, ...overrides });
  };
  const webhook = (guid: string, url = callbackUrl) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'new-message', data: { guid, text: 'forged payload', handle: { address: 'attacker' } } }) });
  return { im, api, received, message, webhook, send, chat, state: () => saved!, url: () => callbackUrl };
}

describe('BlueBubbles local ingress', () => {
  it('recognizes explicit group mentions without treating quotes or similar names as invocations', async () => {
    const f = await fixture();
    expect(f.im.isGroupInvocation('@Cindy help')).toBe(true);
    expect(f.im.getOwnerUserId()).toBe(f.chat.guid);
    expect(f.im.isGroup('any;+;real-format-group')).toBe(true);
    expect(f.im.isGroupInvocation('> @Cindy help')).toBe(false);
    expect(f.im.isGroupInvocation('“@Cindy”')).toBe(false);
    expect(f.im.isGroupInvocation('@Cindyness')).toBe(false);
  });
  it('re-fetches identity, deduplicates webhook/history and catches a missed message after restart', async () => {
    const f = await fixture();
    f.message('incoming-1');
    expect((await f.webhook('incoming-1')).status).toBe(202);
    await f.im.reconcile();
    await f.webhook('incoming-1');
    await f.im.reconcile();
    expect(f.received).toHaveLength(1);
    expect(f.received[0]).toMatchObject({ text: 'hello', speaker: { id: 'owner@example.test', isOwner: true } });
    await f.im.dispose();
    f.message('missed-2');
    await f.im.init();
    await f.im.reconcile();
    expect(f.received.map(row => row.messageId)).toEqual(['incoming-1', 'missed-2']);
    expect(f.state().inbox['incoming-1']?.state).toBe('accepted');
    expect(f.send).not.toHaveBeenCalled();
  });

  it('drops own echoes, unrelated chats, reactions and bad callback tokens', async () => {
    const f = await fixture();
    f.message('own', { isFromMe: true });
    f.message('other', { chats: [{ guid: 'unconfigured' }] });
    f.message('reaction', { associatedMessageType: 2001 });
    f.message('sms', { handle: { address: 'owner@example.test', service: 'SMS' } });
    for (const guid of ['own', 'other', 'reaction', 'sms']) await f.webhook(guid);
    await f.im.reconcile();
    expect(f.received).toHaveLength(0);
    expect((await f.webhook('other', f.url() + 'invalid')).status).toBe(404);
    await expect(f.im.sendText('unconfigured', 'no')).rejects.toThrow('CHAT_NOT_CONNECTED');
    expect(f.send).not.toHaveBeenCalled();
  });

  it('keeps receiving confirmation replies while a handler awaits them', async () => {
    const f = await fixture();
    let reply: string | undefined;
    f.im.onMessage(async event => {
      if (event.messageId === 'question') reply = await f.im.requestTextReply(f.chat.guid, 'Confirm?', text => text === 'yes' ? text : null);
    });
    f.message('question');
    await f.webhook('question');
    await f.im.reconcile();
    f.message('answer', { text: 'yes' });
    await f.webhook('answer');
    await f.im.reconcile();
    expect(reply).toBe('yes');
    expect(f.received.map(row => row.messageId)).toEqual(['question']);
  });

  it('delivers later messages when an earlier download fails, then recovers that pending receipt', async () => {
    const f = await fixture();
    f.message('broken', { attachments: [{ guid: 'unavailable', transferName: 'file.txt' }] });
    f.message('later');
    vi.spyOn(f.api, 'download').mockRejectedValue(new Error('temporarily unavailable'));
    await expect(f.im.reconcile()).rejects.toThrow('BLUEBUBBLES_RECEIVE_FAILED');
    expect(f.received.map(row => row.messageId)).toEqual(['later']);
    expect(f.state().inbox.broken?.state).toBe('pending');
    f.message('broken', { attachments: [] });
    await f.im.reconcile();
    expect(f.received.map(row => row.messageId)).toEqual(['later', 'broken']);
  });

  it('records unknown sends without retry and does not replay interrupted dispatches', async () => {
    const f = await fixture();
    f.send.mockRejectedValue(new Error('request failed with secret URL'));
    await expect(f.im.sendText(f.chat.guid, 'one send')).rejects.toThrow('BLUEBUBBLES_SEND_UNKNOWN');
    f.im.onMessage(async () => { throw new Error('interrupted dispatch'); });
    f.message('uncertain');
    await f.webhook('uncertain');
    await f.im.reconcile();
    await f.im.dispose();
    await f.im.init();
    expect(f.received).toHaveLength(1);
    expect(f.im.health()).toMatchObject({ uncertainInputs: 1, uncertainSends: 1 });
    expect(f.send).toHaveBeenCalledTimes(1);
  });
});

it('does not follow credential-bearing redirects or expose failed request URLs', async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('http://server?password=secret'));
  const api = new BlueBubblesApi('http://127.0.0.1:1234', 'secret', fetcher);
  await expect(api.info()).rejects.toThrow('BLUEBUBBLES_REQUEST_FAILED');
  expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('error');
});

// Tier 1: live 1.9.9 rejected uploads without the separate required `name` field.
// Serialize the production request: a multipart filename alone must not pass validation.
it('sends the required attachment name and preserves the uploaded bytes', async () => {
  const bytes = new Uint8Array([0, 137, 80, 78, 71, 255]);
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const form = await request.formData();
    if (!form.get('name')) return new Response('{}', { status: 400 });
    expect(form.get('name')).toBe('original.png');
    expect(form.get('chatGuid')).toBe('any;-;owner@example.test');
    expect(form.get('tempGuid')).toBe('upload-once');
    const attachment = form.get('attachment') as File;
    expect(attachment.name).toBe('original.png');
    expect(new Uint8Array(await attachment.arrayBuffer())).toEqual(bytes);
    return Response.json({ status: 200, data: { guid: 'sent-attachment' } });
  };
  const api = new BlueBubblesApi('http://127.0.0.1:1234', 'test-only', fetcher);
  await expect(api.sendFile('any;-;owner@example.test', bytes, 'original.png', 'upload-once'))
    .resolves.toEqual({ guid: 'sent-attachment' });
});

it('registers and removes only its exact callback while preserving an existing bridge', async () => {
  const rows = [{ id: 1, url: 'http://bridge.local/production', events: ['new-message'] }];
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const pathname = new URL(String(input)).pathname;
    if (init?.method === 'POST') rows.push({ id: 2, ...JSON.parse(String(init.body)) });
    if (init?.method === 'DELETE') {
      const index = rows.findIndex(row => pathname === `/api/v1/webhook/${row.id}`);
      expect(index).toBe(1);
      rows.splice(index, 1);
      return Response.json({ status: 200, message: 'deleted' });
    }
    return Response.json({ status: 200, data: rows });
  });
  const api = new BlueBubblesApi('http://127.0.0.1:1234', 'test-only', fetcher);
  const callback = 'http://127.0.0.1:18747/im/events/test';
  await api.registerWebhook(callback);
  await api.registerWebhook(callback);
  expect(rows).toHaveLength(2);
  await api.unregisterWebhook(callback);
  expect(rows.map(row => row.id)).toEqual([1]);
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});
