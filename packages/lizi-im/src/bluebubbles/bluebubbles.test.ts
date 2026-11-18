import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IMHost, IMMessageEvent } from '../types.js';
import { LocalWebhookReceiver } from '../localWebhook.js';
import { BlueBubblesApi, BLUEBUBBLES_MAX_BYTES, type BlueBubblesMessage } from './api.js';
import { BLUEBUBBLES_SECRET_KEYS, BlueBubblesIM } from './index.js';
import { UnsupportedInboundMediaError } from '../inboundKind.js';
import { BlueBubblesReceipts, type BlueBubblesState } from './state.js';

// Tier 1: exercise the real transport and HTTP receiver. Covers durable duplicate/restart
// handling and requester identity absent from other transports' tests; no real contacts.
const connections: BlueBubblesIM[] = [];
afterEach(async () => { await Promise.all(connections.splice(0).map(im => im.dispose())); });
async function fixture(initialState: BlueBubblesState | null = null, media?: IMHost['media'], extraChat = false, files?: IMHost['files']) {
  const secrets = new Map<string, string>();
  let saved: BlueBubblesState | null = initialState;
  let callbackUrl = '';
  let now = 1_000;
  const chat = { guid: 'any;-;owner@example.test', participants: [{ address: 'owner@example.test', service: 'iMessage' }] };
  const otherChat = { guid: 'any;-;other@example.test', participants: [{ address: 'other@example.test', service: 'iMessage' }] };
  const messages = new Map<string, BlueBubblesMessage>();
  const api = new BlueBubblesApi('http://127.0.0.1:1', 'test-only');
  vi.spyOn(api, 'info').mockResolvedValue({ server_version: '1.9.9' });
  vi.spyOn(api, 'chat').mockImplementation(async guid => guid === otherChat.guid ? otherChat : chat);
  vi.spyOn(api, 'history').mockImplementation(async (_chat, after, before) => [...messages.values()].filter(row => row.dateCreated >= after && row.dateCreated <= before));
  vi.spyOn(api, 'message').mockImplementation(async guid => {
    const message = messages.get(guid); if (!message) throw new Error('missing'); return message;
  });
  vi.spyOn(api, 'unregisterWebhook').mockResolvedValue(undefined);
  vi.spyOn(api, 'registerWebhook').mockImplementation(async url => { callbackUrl = url; });
  const send = vi.spyOn(api, 'sendText').mockResolvedValue({ guid: 'outbound' });
  const host: IMHost = {
    ...(media ? { media } : {}),
    ...(files ? { files } : {}),
    secrets: { read: key => secrets.get(key) ?? null, write: (key, value) => { secrets.set(key, value); return true; },
      readResult: key => secrets.has(key) ? { kind: 'value', value: secrets.get(key)! } : { kind: 'missing' },
      remove: key => { secrets.delete(key); }, isAvailable: () => true },
    ipc: { handle() {}, broadcast() {}, throwIpcError(_code, message): never { throw new Error(message); } },
    paths: { feishuMediaDir: 'unused' }, httpPostForm: async () => ({ status: 200, body: {} }),
  };
  const receiver = new LocalWebhookReceiver('127.0.0.1', 0);
  const storage = { read: () => saved, write: (state: BlueBubblesState) => { saved = structuredClone(state); } };
  const im = new BlueBubblesIM(host, { secretPrefix: 'test-', api: () => api,
    receiver: () => receiver, resolvePeers: async () => ['127.0.0.1'], now: () => now,
    storage });
  connections.push(im);
  const received: IMMessageEvent[] = [];
  im.onMessage(event => { received.push(event); });
  await im.saveCredentials({ serverUrl: api.origin, password: 'test-only', ownerAddress: 'owner@example.test',
    chatGuids: [chat.guid, ...(extraChat ? [otherChat.guid] : [])], listenHost: '127.0.0.1', listenPort: 18747 });
  const message = (guid: string, overrides: Partial<BlueBubblesMessage> = {}) => {
    now += 1;
    messages.set(guid, { guid, text: 'hello', isFromMe: false, dateCreated: now,
      chats: [chat], handle: { address: 'owner@example.test', service: 'iMessage' }, ...overrides });
  };
  const webhook = (guid: string, url = callbackUrl) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'new-message', data: { guid, text: 'forged payload', handle: { address: 'attacker' } } }) });
  return { im, api, host, storage, secrets, received, message, webhook, send, chat, otherChat, advance: (ms: number) => { now += ms; }, state: () => saved!, url: () => callbackUrl };
}

describe('BlueBubbles local ingress', () => {
  // Tier 1, PR #10241/r4556881876: a failed candidate edit used to permanently
  // ignore excluded pending inputs before restoring the old chat allowlist.
  it.each([false, true])('finalizes excluded pending receipts only after the edit commits (write fails: %s)', async failWrite => {
    const f = await fixture(null, undefined, true);
    const original = f.im.getEditableConfig();
    const originalCursor = f.state().cursors[f.chat.guid];
    f.message('excluded-pending', { chats: [f.otherChat], dateCreated: 1001 });
    f.message('included-pending', { dateCreated: 1002 });
    f.advance(100);
    f.state().inbox['excluded-pending'] = { receivedAt: 1001, state: 'pending' };
    f.state().inbox['included-pending'] = { receivedAt: 1002, state: 'pending' };
    const write = f.storage.write;
    let failed = false;
    vi.spyOn(f.storage, 'write').mockImplementation(state => {
      if (failWrite && !failed && state.cursors[f.chat.guid] > originalCursor) {
        failed = true;
        throw new Error('receipt disk failure');
      }
      write(state);
    });
    const update = f.im.updateCredentials({ ...original, chatGuids: [f.chat.guid] });
    if (failWrite) await expect(update).rejects.toThrow('BLUEBUBBLES_UPDATE_FAILED');
    else await update;
    await f.im.reconcile();
    expect(failed).toBe(failWrite);
    expect(f.im.getStatus().kind).toBe('connected');
    expect(f.im.getEditableConfig().chatGuids).toEqual(failWrite ? original.chatGuids : [f.chat.guid]);
    expect(f.state().inbox['excluded-pending'].state).toBe(failWrite ? 'accepted' : 'ignored');
    expect(f.received.map(event => event.messageId)).toEqual(failWrite ? ['excluded-pending', 'included-pending'] : ['included-pending']);
    await f.im.dispose(); await f.im.init();
    expect(f.received).toHaveLength(failWrite ? 2 : 1);
  });

  // Tier 1, PR #10241/r4557073972: owner reclassification must not consume a
  // command until the candidate is committed, even with an unchanged allowlist.
  it.each([false, true])('dispatches owner commands only after the edit settles (recovery write fails: %s)', async failWrite => {
    const f = await fixture();
    const original = f.im.getEditableConfig();
    const originalCursor = f.state().cursors[f.chat.guid];
    for (const [id, time] of [['owner-new', 1001], ['owner-stop', 1002]] as const) {
      f.message(id, { text: id === 'owner-new' ? '/new' : '/stop', dateCreated: time });
      f.state().inbox[id] = { receivedAt: time, state: 'pending' };
    }
    f.advance(100);
    let inCandidate = false, failed = false;
    const candidateDeliveries: IMMessageEvent[] = [];
    f.im.onMessage(event => { if (inCandidate) candidateDeliveries.push(event); });
    const save = f.im.saveCredentials.bind(f.im);
    vi.spyOn(f.im, 'saveCredentials').mockImplementation(async input => {
      inCandidate = true;
      try { await save(input); } finally { inCandidate = false; }
    });
    const write = f.storage.write;
    vi.spyOn(f.storage, 'write').mockImplementation(state => {
      if (failWrite && !failed && state.cursors[f.chat.guid] > originalCursor) {
        failed = true; throw new Error('receipt disk failure');
      }
      write(state);
    });
    const update = f.im.updateCredentials({ ...original, ownerAddress: 'replacement@example.test' });
    if (failWrite) await expect(update).rejects.toThrow('BLUEBUBBLES_UPDATE_FAILED');
    else await update;
    await f.im.reconcile();
    expect(candidateDeliveries).toEqual([]);
    expect(failed).toBe(failWrite);
    expect(f.im.getStatus().kind).toBe('connected');
    expect(f.im.getEditableConfig().ownerAddress).toBe(failWrite ? original.ownerAddress : 'replacement@example.test');
    expect(f.received.map(event => [event.messageId, event.speaker?.isOwner])).toEqual([
      ['owner-new', failWrite], ['owner-stop', failWrite],
    ]);
    await f.im.dispose(); await f.im.init();
    expect(f.received).toHaveLength(2);
  });

  // Tier 1, PR #10241/r4552494796: adding a chat must not execute its old
  // requests, while existing chats still recover missed messages and receipts.
  it('persists a new chat activation boundary without resetting existing history', async () => {
    const f = await fixture();
    const original = f.im.getEditableConfig();
    const oldCursor = f.state().cursors[f.chat.guid];
    f.message('existing-missed', { dateCreated: 2000 });
    f.message('new-chat-old-command', { chats: [f.otherChat], dateCreated: 2000, text: '/new' });
    f.advance(10_000);
    const history = vi.mocked(f.api.history).getMockImplementation()!;
    vi.mocked(f.api.history).mockImplementation(async (chat, after, before, offset) =>
      (await history(chat, after, before, offset)).filter(message => message.chats?.some(row => row.guid === chat)));
    await f.im.updateCredentials({ ...original, chatGuids: [...original.chatGuids, f.otherChat.guid] });
    expect(f.state().activatedAt).toBe(1000);
    expect(f.state().chatActivatedAt?.[f.otherChat.guid]).toBeGreaterThan(2000);
    expect(f.state().chatActivatedAt?.[f.chat.guid]).toBeUndefined();
    expect(f.state().cursors[f.chat.guid]).toBeGreaterThanOrEqual(oldCursor);
    expect(f.received.map(event => event.messageId)).toEqual(['existing-missed']);
    // Delayed webhook delivery must obey the same boundary as history recovery.
    await f.webhook('new-chat-old-command');
    await f.im.reconcile();
    expect(f.state().inbox['new-chat-old-command'].state).toBe('ignored');
    const accepted = structuredClone(f.state().inbox['existing-missed']);
    const boundary = f.state().chatActivatedAt![f.otherChat.guid];
    await f.im.dispose(); await f.im.init();
    expect(f.state().chatActivatedAt![f.otherChat.guid]).toBe(boundary);
    expect(f.state().inbox['existing-missed']).toEqual(accepted);
    f.message('new-chat-current', { chats: [f.otherChat] });
    await f.webhook('new-chat-current'); await f.im.reconcile();
    expect(f.received.map(event => event.messageId)).toEqual(['existing-missed', 'new-chat-current']);
  });

  // Tier 1, PR #10241/r4552243405: an unreadable saved key must not become a
  // missing-key rollback entry. Abort through the production edit entry point.
  it.each([...BLUEBUBBLES_SECRET_KEYS, 'unsupported-host'])('keeps the live connection and secrets intact when snapshotting %s fails', async key => {
    const f = await fixture();
    const previous = new Map(f.secrets);
    const config = f.im.getEditableConfig();
    const dispose = vi.spyOn(f.im, 'dispose');
    const write = vi.spyOn(f.host.secrets, 'write');
    const remove = vi.spyOn(f.host.secrets, 'remove');
    if (key === 'unsupported-host') delete f.host.secrets.readResult;
    else {
      const read = f.host.secrets.readResult!;
      f.host.secrets.readResult = name => name === `test-${key}` ? { kind: 'error' } : read(name);
    }
    await expect(f.im.updateCredentials({ ...config, password: 'replacement-test-only' })).rejects.toThrow('BLUEBUBBLES_SECRET_UNAVAILABLE');
    expect(dispose).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(f.api.unregisterWebhook).not.toHaveBeenCalled();
    expect(f.secrets).toEqual(previous);
    expect(f.im.getStatus().kind).toBe('connected');
  });

  // Tier 1: editing an existing connection must retain secrets/receipts and recover a failed reconnect.
  it('updates settings without resetting credentials or receipts, and restores settings on failure', async () => {
    const f = await fixture();
    const original = f.im.getEditableConfig();
    const receipt = structuredClone(f.state());
    await f.im.updateCredentials({ ...original, listenPort: 18748 });
    expect(f.im.getEditableConfig().listenPort).toBe(18748);
    expect(f.secrets.get('test-bluebubbles-password')).toBe('test-only');
    expect(f.state()).toEqual(receipt);
    expect(f.api.unregisterWebhook).toHaveBeenCalledTimes(1);
    vi.mocked(f.api.info).mockRejectedValueOnce(new Error('unreachable'));
    await expect(f.im.updateCredentials({ ...original, password: 'replacement-test-only' })).rejects.toThrow('BLUEBUBBLES_UPDATE_FAILED');
    expect(f.im.getEditableConfig().listenPort).toBe(18748);
    expect(f.secrets.get('test-bluebubbles-password')).toBe('test-only');
    expect(f.im.getStatus().kind).toBe('connected');
    expect(f.state()).toEqual(receipt);
    await f.im.updateCredentials({ ...original, password: 'replacement-test-only' });
    expect(f.secrets.get('test-bluebubbles-password')).toBe('replacement-test-only');
  });

  it('does not restore removed credentials when an edit is interrupted by disconnect', async () => {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(f.api.info).mockImplementationOnce(async () => {
      entered();
      await new Promise<void>(resolve => { release = resolve; });
      return { server_version: '1.9.9' };
    });
    const updating = f.im.updateCredentials({ ...f.im.getEditableConfig(), listenPort: 18748 });
    const rejected = expect(updating).rejects.toThrow('BLUEBUBBLES_CONNECTION_CHANGED');
    await started;
    await f.im.clearCredentials();
    release();
    await rejected;
    expect(f.secrets.size).toBe(0);
  });

  // Tier 1, #9250/r4506476913: two waiting attachments used to refetch one
  // another indefinitely. The guard only bounds the old-code failure path.
  it('retains verified metadata for multiple attachments waiting behind a slow preparation', async () => {
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const preparing = new Promise<void>(resolve => { entered = resolve; });
    const f = await fixture(null, undefined, false, { stage: async ({ fileName }) => ({
      absPath: `/synthetic/${fileName}`, discard: async () => {},
    }) });
    const original = vi.mocked(f.api.message).getMockImplementation()!;
    const counts = new Map<string, number>();
    vi.mocked(f.api.message).mockImplementation(async guid => {
      const count = (counts.get(guid) ?? 0) + 1; counts.set(guid, count);
      if (count > 4) await held;
      return original(guid);
    });
    const download = vi.spyOn(f.api, 'download').mockImplementation(async guid => {
      if (guid === 'slot-first-file') { entered(); await held; }
      return new Uint8Array([1]);
    });
    try {
      f.message('slot-first', { attachments: [{ guid: 'slot-first-file', transferName: 'first.txt' }] });
      await f.webhook('slot-first'); await preparing;
      for (const id of ['slot-second', 'slot-third']) {
        f.message(id, { attachments: [{ guid: `${id}-file`, transferName: `${id}.txt` }] });
        await f.webhook(id);
      }
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(counts.get('slot-second')).toBe(1);
      expect(counts.get('slot-third')).toBe(1);
      expect(download.mock.calls.map(([guid]) => guid)).toEqual(['slot-first-file']);
      expect(f.received).toEqual([]);
    } finally { release(); await f.im.reconcile(); }
    expect(f.received.map(event => event.messageId)).toEqual(['slot-first', 'slot-second', 'slot-third']);
    for (const id of ['slot-first', 'slot-second', 'slot-third']) expect(f.state().inbox[id].state).toBe('accepted');
    expect(download).toHaveBeenCalledTimes(3);
  });

  // Tier 1, #9250/r4506476916: equal API timestamps cannot use lookup
  // completion order as a substitute for stable first receipt order.
  it('preserves receipt order for equal-time inputs when the first lookup finishes last', async () => {
    const f = await fixture();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const original = vi.mocked(f.api.message).getMockImplementation()!;
    vi.mocked(f.api.message).mockImplementation(async guid => {
      if (guid === 'equal-old') { entered(); await held; }
      return original(guid);
    });
    try {
      f.message('equal-old', { dateCreated: 1001 });
      await f.webhook('equal-old'); await waiting;
      f.message('equal-new', { dateCreated: 1001 }); await f.webhook('equal-new');
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(f.received).toEqual([]);
    } finally { release(); await f.im.reconcile(); }
    // Resume the input deferred behind the first one's persistence boundary.
    await f.im.reconcile();
    expect(f.received.map(event => event.messageId)).toEqual(['equal-old', 'equal-new']);
    for (const id of ['equal-old', 'equal-new']) expect(f.state().inbox[id].state).toBe('accepted');
  });

  // Tier 1, #9250/r4506424107: a still-pending retry is active, not terminal.
  // Its expired deadline must not flood host status broadcasts during slow I/O.
  it.each(['lookup', 'download'])('does not repeatedly wake an in-flight %s retry at its expired deadline', async phase => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const retryStarted = new Promise<void>(resolve => { entered = resolve; });
    let f: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      f = await fixture(null, undefined, false, { stage: async () => ({ absPath: '/synthetic/retry.txt', discard: async () => {} }) });
      const original = vi.mocked(f.api.message).getMockImplementation()!;
      let attempts = 0;
      const retry = async () => {
        if (++attempts === 1) throw new Error('temporary 503');
        entered(); await held;
      };
      vi.mocked(f.api.message).mockImplementation(async guid => {
        if (phase === 'lookup') await retry();
        return original(guid);
      });
      vi.spyOn(f.api, 'download').mockImplementation(async () => {
        if (phase === 'download') await retry();
        return new Uint8Array([1]);
      });
      f.message('active-retry', { attachments: phase === 'download' ? [{ guid: 'retry-file', transferName: 'retry.txt' }] : [] });
      await expect(f.im.reconcile()).rejects.toThrow('BLUEBUBBLES_RECEIVE_FAILED');
      const statuses = vi.fn(); f.im.onStatusChange(statuses);
      f.advance(30_000);
      await vi.advanceTimersByTimeAsync(30_000);
      await retryStarted;
      const before = statuses.mock.calls.length;
      await vi.advanceTimersByTimeAsync(25);
      expect(statuses).toHaveBeenCalledTimes(before);
      expect(attempts).toBe(2);
      expect(f.state().inbox['active-retry'].state).toBe('pending');
      release();
      // Completion itself must wake ingress, without another webhook/reconcile.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(f.state().inbox['active-retry'].state).toBe('accepted');
      expect(f.im.getStatus().kind).toBe('connected');
    } finally {
      release();
      await f?.im.dispose();
      vi.useRealTimers();
    }
  });

  // Tier 1, #9250/r4506349655: hold identity lookup rather than attachment I/O.
  // Controls must proceed, while ordinary work cannot overtake an unknown input.
  it('answers and stops another chat while an older identity lookup remains unresolved', async () => {
    const f = await fixture(null, undefined, true);
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const original = vi.mocked(f.api.message).getMockImplementation()!;
    vi.mocked(f.api.message).mockImplementation(async guid => {
      if (guid === 'lookup-held') { entered(); await held; }
      return original(guid);
    });
    let answer: string | undefined;
    void f.im.requestTextReply(f.chat.guid, 'Confirm?', text => text === 'yes' ? text : null)
      .then(value => { answer = value; }, () => {});
    f.im.onMessage(event => {
      event.delivery!.awaitPersistence();
      if (event.text === '/stop') expect(event.delivery!.cancelPending!()).toBe(0);
      event.delivery!.accept();
    });
    try {
      f.message('lookup-held', { chats: [f.otherChat] });
      await f.webhook('lookup-held'); await waiting;
      f.message('after-unknown', { chats: [f.otherChat] }); await f.webhook('after-unknown');
      f.message('lookup-answer', { text: 'yes' }); await f.webhook('lookup-answer');
      f.message('lookup-stop', { text: '/stop' }); await f.webhook('lookup-stop');
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(answer).toBe('yes');
      expect(f.state().inbox['lookup-stop'].state).toBe('accepted');
      expect(f.state().inbox['after-unknown'].state).toBe('pending');
    } finally { release(); await f.im.reconcile(); }
    expect(f.received.filter(event => event.chatId === f.otherChat.guid).map(event => event.messageId))
      .toEqual(['lookup-held', 'after-unknown']);
    expect(vi.mocked(f.api.message).mock.calls.filter(([guid]) => guid === 'lookup-held')).toHaveLength(1);
  });

  // Tier 1, #9250/r4506349664: each completed lookup admits another webhook.
  // The finite producer is a failure guard; stop must run before it becomes quiet.
  it('releases recovery at a finite watermark despite continued live GUID arrivals', async () => {
    const f = await fixture();
    const original = vi.mocked(f.api.message).getMockImplementation()!;
    const limit = 12;
    let produced = 0, producedWhenStopped = -1;
    vi.mocked(f.api.message).mockImplementation(async guid => {
      if (produced < limit) {
        const next = `continuous-${++produced}`;
        f.message(next);
        expect((await f.webhook(next)).status).toBe(202);
      }
      return original(guid);
    });
    f.im.onMessage(event => {
      if (event.text !== '/stop') return;
      producedWhenStopped = produced;
      event.delivery!.cancelPending!();
      event.delivery!.accept();
    });
    f.message('watermark-stop', { text: '/stop' });
    await f.im.reconcile();
    expect(producedWhenStopped).toBeGreaterThanOrEqual(1);
    expect(producedWhenStopped).toBeLessThan(limit);
    expect(f.state().inbox['watermark-stop'].state).toBe('accepted');
    expect(f.received.filter(event => event.messageId === 'watermark-stop')).toHaveLength(1);
  });

  // Tier 1, #9250/r4506280350: an unresolved download/stage must not hold
  // another chat, a confirmation or stop; ordinary same-chat work stays ordered.
  it.each(['download', 'stage'])('handles controls and other chats while %s is still in flight', async phase => {
    let started!: () => void, release!: () => void;
    const preparing = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture(null, undefined, true, { stage: async () => {
      if (phase === 'stage') { started(); await held; }
      return { absPath: '/synthetic/held.txt', discard: async () => {} };
    } });
    vi.spyOn(f.api, 'download').mockImplementation(async () => {
      if (phase === 'download') { started(); await held; }
      return new Uint8Array([1]);
    });
    let answer: string | undefined;
    void f.im.requestTextReply(f.chat.guid, 'Confirm?', text => text === 'yes' ? text : null)
      .then(value => { answer = value; }, () => {});
    f.im.onMessage(event => {
      event.delivery!.awaitPersistence();
      if (event.text === '/stop') expect(event.delivery!.cancelPending!()).toBe(2);
      event.delivery!.accept();
    });
    try {
      f.message('slow-preparation', { attachments: [{ guid: 'held', transferName: 'held.txt' }] });
      await f.webhook('slow-preparation'); await preparing;
      f.message('same-chat-queued'); await f.webhook('same-chat-queued');
      f.message('other-chat-free', { chats: [f.otherChat] }); await f.webhook('other-chat-free');
      f.message('control-answer', { text: 'yes' }); await f.webhook('control-answer');
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(answer).toBe('yes');
      expect(f.state().inbox['other-chat-free'].state).toBe('accepted');
      expect(f.state().inbox['same-chat-queued'].state).toBe('pending');
      // Stop cancels both earlier ordinary inputs, including the in-flight one.
      f.message('control-stop', { text: '/stop' });
      await f.webhook('control-stop');
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(f.state().inbox['control-stop'].state).toBe('accepted');
      expect(f.state().inbox['slow-preparation'].state).toBe('ignored');
      expect(f.state().inbox['same-chat-queued'].state).toBe('ignored');
      f.message('after-stop'); await f.webhook('after-stop');
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(f.state().inbox['after-stop'].state).toBe('accepted');
    } finally { release(); await f.im.reconcile(); }
    expect(f.received.some(event => ['slow-preparation', 'same-chat-queued'].includes(event.messageId!))).toBe(false);
    expect(f.api.download).toHaveBeenCalledTimes(1);
  });

  // The new preparation slots must also preserve the successful file path:
  // a later file waits in the same chat and both are dispatched once, in order.
  it('serializes same-chat attachments and resumes their original order after a slow download', async () => {
    let started!: () => void, release!: () => void;
    const preparing = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const stage = vi.fn(async ({ fileName }: { fileName: string }) => ({ absPath: `/synthetic/${fileName}`, discard: async () => {} }));
    const f = await fixture(null, undefined, false, { stage });
    const download = vi.spyOn(f.api, 'download').mockImplementation(async guid => {
      if (guid === 'first-file') { started(); await held; }
      return new Uint8Array([1]);
    });
    try {
      f.message('slow-first', { attachments: [{ guid: 'first-file', transferName: 'first.txt' }] });
      await f.webhook('slow-first'); await preparing;
      f.message('queued-second', { attachments: [{ guid: 'second-file', transferName: 'second.txt' }] });
      await f.webhook('queued-second');
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(download.mock.calls.map(([guid]) => guid)).toEqual(['first-file']);
      expect(f.received).toEqual([]);
    } finally { release(); await f.im.reconcile(); }
    expect(f.received.map(event => event.messageId)).toEqual(['slow-first', 'queued-second']);
    expect(f.received.map(event => event.attachments[0].absPath)).toEqual(['/synthetic/first.txt', '/synthetic/second.txt']);
    expect(download.mock.calls.map(([guid]) => guid)).toEqual(['first-file', 'second-file']);
    expect(stage).toHaveBeenCalledTimes(2);
    for (const guid of ['slow-first', 'queued-second']) expect(f.state().inbox[guid].state).toBe('accepted');
  });

  // Tier 1, #9250/r4506188535: stop may cancel a still-running preparation
  // before its download/staging rejects; the terminal GUID must not gain a retry.
  it.each(['download', 'stage'])('does not retry a cancelled input whose in-flight %s fails later', async phase => {
    let started!: () => void, rejectPreparation!: (error: Error) => void;
    const preparing = new Promise<void>(resolve => { started = resolve; });
    const failed = new Promise<never>((_resolve, reject) => { rejectPreparation = reject; });
    const f = await fixture(null, undefined, false, phase === 'stage' ? {
      stage: async () => { started(); return failed; },
    } : undefined);
    vi.spyOn(f.api, 'download').mockImplementation(async () => {
      if (phase === 'download') { started(); return failed; }
      return new Uint8Array([1]);
    });
    let stop!: () => void, stopped!: () => void;
    const stopGate = new Promise<void>(resolve => { stop = resolve; });
    const stopDone = new Promise<void>(resolve => { stopped = resolve; });
    f.im.onMessage(async event => {
      if (event.text !== '/stop') return;
      event.delivery!.awaitPersistence();
      await stopGate;
      expect(event.delivery!.cancelPending!()).toBe(1);
      event.delivery!.accept();
      stopped();
    });
    f.advance(500);
    f.message('in-flight-old', { dateCreated: 1100, attachments: [{ guid: 'held-file', transferName: 'file.txt' }] });
    f.message('delayed-handler-stop', { dateCreated: 1200, text: '/stop' });
    await f.webhook('delayed-handler-stop');
    await f.webhook('in-flight-old');
    await preparing;
    stop(); await stopDone;
    expect(f.state().inbox['in-flight-old'].state).toBe('ignored');
    rejectPreparation(new Error('late preparation 503'));
    await new Promise<void>(resolve => setImmediate(resolve));
    await expect(f.im.reconcile()).resolves.toBeUndefined();
    f.advance(30_001);
    await expect(f.im.reconcile()).resolves.toBeUndefined();
    expect(f.im.getStatus().kind).toBe('connected');
    expect(f.api.download).toHaveBeenCalledTimes(1);
    expect(f.received.some(event => event.messageId === 'in-flight-old')).toBe(false);
  });

  // Tier 1, #9250/r4506126025: a failed history page must not strand a durable
  // stop/reply until another webhook or the five-minute sweep wakes the pump.
  it.each(['stop', 'reply'])('resumes a gated %s after history fails without another ingress event', async kind => {
    const f = await fixture();
    let answer: string | undefined;
    if (kind === 'reply') void f.im.requestTextReply(f.chat.guid, 'Confirm?', value => value === 'yes' ? value : null)
      .then(value => { answer = value; }, () => {});
    let release!: () => void, started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(f.api.history).mockImplementationOnce(async () => { started(); await gate; throw new Error('history 503'); });
    f.im.onMessage(event => {
      if (event.text === '/stop') { event.delivery!.awaitPersistence(); event.delivery!.cancelPending!(); event.delivery!.accept(); }
    });
    const recovering = f.im.reconcile();
    const failure = expect(recovering).rejects.toThrow('history 503');
    try {
      await waiting;
      f.message('gated-control', { text: kind === 'stop' ? '/stop' : 'yes' });
      expect((await f.webhook('gated-control')).status).toBe(202);
      expect(f.state().inbox['gated-control'].state).toBe('pending');
    } finally { release(); await failure; }
    // Flush the current I/O turn only: no clock advance, retry, reconcile or webhook.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.state().inbox['gated-control'].state).toBe('accepted');
    if (kind === 'reply') expect(answer).toBe('yes');
    else expect(f.received.map(event => event.messageId)).toEqual(['gated-control']);
    expect(f.im.getStatus().kind).toBe('error'); // History is still unavailable.
  });

  // Tier 1, #9250/r4506126028: a pre-existing prepared barrier must follow
  // verified send order when recovery discovers older work behind it.
  it('runs recovered older work before a newer input already in the busy barrier', async () => {
    const f = await fixture();
    f.advance(500);
    let busy = true;
    const accepted: string[] = [];
    f.im.onMessage(event => {
      event.delivery!.awaitPersistence();
      if (busy) event.delivery!.defer();
      else { accepted.push(event.messageId!); event.delivery!.accept(); }
    });
    f.message('newer-prepared', { dateCreated: 1300 });
    await f.webhook('newer-prepared');
    await f.im.reconcile();
    expect(f.state().inbox['newer-prepared'].state).toBe('pending');
    f.message('older-recovered', { dateCreated: 1200 });
    await f.im.reconcile();
    expect(f.state().inbox['older-recovered'].state).toBe('pending');
    busy = false;
    await f.im.reconcile();
    expect(accepted).toEqual(['older-recovered', 'newer-prepared']);
    expect(f.state().inbox['older-recovered'].state).toBe('accepted');
    expect(f.state().inbox['newer-prepared'].state).toBe('accepted');
  });

  // Tier 1, #9250/r4506059629: verified send time must override webhook arrival
  // order, including a newer input whose identity cannot yet be looked up.
  it('preserves later-sent work when its webhook arrives before a delayed stop', async () => {
    const f = await fixture();
    f.advance(500);
    let busy = true, unavailable = true;
    const original = vi.mocked(f.api.message).getMockImplementation()!;
    vi.mocked(f.api.message).mockImplementation(async guid => {
      if (guid === 'newer-unverified' && unavailable) throw new Error('lookup 503');
      return original(guid);
    });
    f.im.onMessage(event => {
      event.delivery!.awaitPersistence();
      if (event.text === '/stop') { event.delivery!.cancelPending!(); event.delivery!.accept(); }
      else if (busy) event.delivery!.defer();
      else event.delivery!.accept();
    });
    f.message('newer-known', { dateCreated: 1300 });
    await f.webhook('newer-known');
    await f.im.reconcile();
    f.message('newer-unverified', { dateCreated: 1301 });
    await expect(f.im.reconcile()).rejects.toThrow('BLUEBUBBLES_RECEIVE_FAILED');
    f.message('delayed-stop', { text: '/stop', dateCreated: 1200 });
    await f.webhook('delayed-stop');
    await expect(f.im.reconcile()).rejects.toThrow('BLUEBUBBLES_RECEIVE_FAILED');
    expect(f.state().inbox['delayed-stop'].state).toBe('accepted');
    expect(f.state().inbox['newer-known'].state).toBe('pending');
    expect(f.state().inbox['newer-unverified'].state).toBe('pending');
    await f.im.dispose();
    busy = false; unavailable = false;
    await f.im.init();
    expect(f.state().inbox['newer-known'].state).toBe('accepted');
    expect(f.state().inbox['newer-unverified'].state).toBe('accepted');
  });

  // Tier 1, #9250/r4506059631: the existing held-history test does not cover
  // live ingress added while recovery awaits a later identity lookup.
  it('includes receipts arriving during recovery metadata lookup in dispatch ordering', async () => {
    const f = await fixture();
    f.message('old-in-lookup');
    let release!: () => void, started!: () => void, busy = true;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const original = vi.mocked(f.api.message).getMockImplementation()!;
    vi.mocked(f.api.message).mockImplementationOnce(async guid => { started(); await gate; return original(guid); });
    const accepted: string[] = [];
    f.im.onMessage(event => {
      event.delivery!.awaitPersistence();
      if (busy) event.delivery!.defer();
      else { accepted.push(event.messageId!); event.delivery!.accept(); }
    });
    const recovering = f.im.reconcile();
    try {
      await waiting;
      f.message('new-during-lookup');
      expect((await f.webhook('new-during-lookup')).status).toBe(202);
    } finally { release(); await recovering; }
    // Only the oldest input should reach the busy handler.
    expect(f.received.map(event => event.messageId)).toEqual(['old-in-lookup']);
    expect(f.state().inbox['new-during-lookup'].state).toBe('pending');
    busy = false;
    await f.im.reconcile();
    expect(accepted).toEqual(['old-in-lookup', 'new-during-lookup']);
  });

  // Tier 1, #9250/r4506059633: recovery via a webhook/local pump must restore
  // transport availability without waiting for history, but not hide handler faults.
  it('restores connected after local retry without clearing unrelated delivery faults', async () => {
    const f = await fixture();
    const original = vi.mocked(f.api.message).getMockImplementation()!;
    vi.mocked(f.api.message).mockRejectedValueOnce(new Error('lookup 503'));
    f.message('local-retry');
    await f.webhook('local-retry');
    await expect(f.im.reconcile()).rejects.toThrow('BLUEBUBBLES_RECEIVE_FAILED');
    expect(f.im.getStatus().kind).toBe('error');
    f.advance(30_000);
    vi.mocked(f.api.message).mockImplementation(original);
    const histories = vi.mocked(f.api.history).mock.calls.length;
    await f.webhook('local-retry');
    expect(f.state().inbox['local-retry'].state).toBe('accepted');
    expect(f.im.getStatus().kind).toBe('connected');
    expect(f.api.history).toHaveBeenCalledTimes(histories);
    f.im.onMessage(event => { if (event.messageId === 'handler-fault') throw new Error('delivery persistence failed'); });
    f.message('handler-fault'); await f.webhook('handler-fault');
    expect(f.im.getStatus().kind).toBe('error');
    f.message('healthy-after-handler-fault'); await f.webhook('healthy-after-handler-fault');
    expect(f.state().inbox['healthy-after-handler-fault'].state).toBe('accepted');
    expect(f.im.getStatus().kind).toBe('error');
  });

  // Tier 1, #9250/r4505897286: a live stop arriving during startup history
  // must wait for older offline inputs to enter its ordered cancellation boundary.
  it.each([true, false])('orders missed input before a live stop while history is blocked (startup=%s)', async startup => {
    const f = await fixture();
    if (startup) await f.im.dispose();
    f.message('offline-before-stop');
    const history = vi.mocked(f.api.history), original = history.getMockImplementation()!;
    let release!: () => void, started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    history.mockImplementationOnce(async (...args) => { started(); await gate; return original(...args); });
    let cancelled = -1;
    f.im.onMessage(event => {
      event.delivery!.awaitPersistence();
      if (event.text === '/stop') { cancelled = event.delivery!.cancelPending!(); event.delivery!.accept(); }
      else event.delivery!.defer();
    });
    const initializing = startup ? f.im.init() : f.im.reconcile();
    try {
      await waiting;
      f.message('live-stop', { text: '/stop' });
      expect((await f.webhook('live-stop')).status).toBe(202);
      expect(f.state().inbox['live-stop'].state).toBe('pending');
      expect(f.received).toEqual([]);
    } finally { release(); await initializing; }
    await f.im.reconcile();
    expect(f.received.map(event => event.messageId)).toEqual(['offline-before-stop', 'live-stop']);
    expect(cancelled).toBe(1);
    expect(f.state().inbox['offline-before-stop'].state).toBe('ignored');
    expect(f.state().inbox['live-stop'].state).toBe('accepted');
    await f.im.dispose();
    const before = f.received.length;
    await f.im.init();
    expect(f.received).toHaveLength(before);
  });

  // Tier 1, #9250/r4505966570: unrelated ingress and busy retry must not bypass
  // the failed GUID's cooldown, for both lookup and download failures.
  it.each(['lookup', 'download'])('keeps %s retries on their own deadline while other chats proceed', async failure => {
    const f = await fixture(null, undefined, true);
    const original = vi.mocked(f.api.message).getMockImplementation()!;
    let attempts = 0;
    if (failure === 'lookup') vi.mocked(f.api.message).mockImplementation(async guid => {
      if (guid === 'failed-guid') { attempts++; throw new Error('lookup 503'); }
      return original(guid);
    });
    else vi.spyOn(f.api, 'download').mockImplementation(async () => { attempts++; throw new Error('download 503'); });
    f.im.onMessage(event => {
      if (event.messageId === 'busy') { event.delivery!.awaitPersistence(); event.delivery!.defer(); }
    });
    f.message('failed-guid', { attachments: failure === 'download' ? [{ guid: 'failed-file' }] : [] });
    await expect(f.im.reconcile()).rejects.toThrow('BLUEBUBBLES_RECEIVE_FAILED');
    expect(attempts).toBe(1);
    f.message('busy');
    for (let i = 0; i < 3; i++) {
      f.message(`other-${i}`, { chats: [f.otherChat] });
      expect((await f.webhook(`other-${i}`)).status).toBe(202);
      f.advance(1001);
      await expect(f.im.reconcile()).rejects.toThrow('BLUEBUBBLES_RECEIVE_FAILED');
    }
    expect(f.received.filter(event => event.chatId === f.otherChat.guid)).toHaveLength(3);
    expect(attempts).toBe(1);
    f.advance(30_000);
    await expect(f.im.reconcile()).rejects.toThrow('BLUEBUBBLES_RECEIVE_FAILED');
    expect(attempts).toBe(2);
  });

  // Tier 1, #9250/r4505966562: stop must survive restart before an unresolved
  // receipt's chat can be verified, without cancelling other/later inputs.
  it('applies a persisted stop boundary after failed identity lookup recovers', async () => {
    const f = await fixture(null, undefined, true);
    const original = vi.mocked(f.api.message).getMockImplementation()!;
    let unavailable = true;
    vi.mocked(f.api.message).mockImplementation(async guid => {
      if (unavailable && ['unknown-owner', 'unknown-other'].includes(guid)) throw new Error('lookup 503');
      return original(guid);
    });
    f.im.onMessage(event => {
      if (event.text === '/stop') { event.delivery!.awaitPersistence(); event.delivery!.cancelPending!(); event.delivery!.accept(); }
    });
    f.message('unknown-owner');
    f.message('unknown-other', { chats: [f.otherChat] });
    await expect(f.im.reconcile()).rejects.toThrow('BLUEBUBBLES_RECEIVE_FAILED');
    f.message('stop-unknown', { text: '/stop' });
    f.message('work-after-unknown-stop', { dateCreated: 1003 }); // Same send millisecond as stop, later receipt.
    await f.webhook('stop-unknown');
    await expect(f.im.reconcile()).rejects.toThrow('BLUEBUBBLES_RECEIVE_FAILED');
    expect(f.state().inbox['stop-unknown'].state).toBe('accepted');
    await f.im.dispose();
    unavailable = false;
    await f.im.init();
    expect(f.state().inbox['unknown-owner'].state).toBe('ignored');
    expect(f.state().inbox['unknown-other'].state).toBe('accepted');
    expect(f.state().inbox['work-after-unknown-stop'].state).toBe('accepted');
    expect(f.received.some(event => event.messageId === 'unknown-owner')).toBe(false);
  });

  // Tier 1, #9250/r4505966565: a successful prefix cannot create another disk
  // copy on each retry when a later attachment fails. Inspect actual files.
  it('discards partially staged files before retries and retains only the successful attachments', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-bb-partial-'));
    let sequence = 0, available = false;
    try {
      const f = await fixture(null, undefined, false, { stage: async ({ buffer, fileName }) => {
        const absPath = path.join(directory, `${++sequence}-${fileName}`);
        await fs.writeFile(absPath, buffer);
        return { absPath, discard: async () => { await fs.rm(absPath, { force: true }); } };
      } });
      vi.spyOn(f.api, 'download').mockImplementation(async guid => {
        if (guid === 'second' && !available) throw new Error('second download 503');
        return new Uint8Array([1, 2, 3]);
      });
      f.message('multi-file', { attachments: [{ guid: 'first', transferName: 'first.txt' }, { guid: 'second', transferName: 'second.txt' }] });
      for (let i = 0; i < 2; i++) {
        await expect(f.im.reconcile()).rejects.toThrow('BLUEBUBBLES_RECEIVE_FAILED');
        expect(await fs.readdir(directory)).toEqual([]);
        f.advance(30_000);
      }
      available = true;
      await f.im.reconcile();
      expect(f.state().inbox['multi-file'].state).toBe('accepted');
      expect(f.received.at(-1)!.attachments).toHaveLength(2);
      expect(await fs.readdir(directory)).toHaveLength(2);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });

  // Tier 1, #9250/r4505897287: one transient attachment failure during startup
  // must not close a registered HTTP receiver used by other chats and replies.
  it('keeps the startup receiver reachable while a failed pending attachment awaits retry', async () => {
    const f = await fixture(null, undefined, true);
    const download = vi.spyOn(f.api, 'download').mockRejectedValue(new Error('temporary download 503'));
    f.message('startup-broken', { attachments: [{ guid: 'unavailable', transferName: 'file.txt' }] });
    await expect(f.im.reconcile()).rejects.toThrow('BLUEBUBBLES_RECEIVE_FAILED');
    await f.im.dispose();
    await f.im.init();
    expect(f.state().inbox['startup-broken'].state).toBe('pending');
    f.message('other-chat-live', { chats: [f.otherChat] });
    expect((await f.webhook('other-chat-live')).status).toBe(202);
    await expect(f.im.reconcile()).rejects.toThrow('BLUEBUBBLES_RECEIVE_FAILED');
    expect(f.received.map(event => event.messageId)).toContain('other-chat-live');
    const answer = f.im.requestTextReply(f.chat.guid, 'Reply while download is down?', value => value === 'yes' ? value : null);
    f.message('reply-during-failure', { text: 'yes' });
    expect((await f.webhook('reply-during-failure')).status).toBe(202);
    await expect(answer).resolves.toBe('yes');
    download.mockResolvedValue(new Uint8Array([1]));
    f.advance(30_000);
    await f.im.reconcile();
    expect(f.state().inbox['startup-broken'].state).toBe('accepted');
    expect(f.im.getStatus().kind).toBe('connected');
    expect(f.api.registerWebhook).toHaveBeenCalledTimes(2);
    expect(f.received.filter(event => event.messageId === 'startup-broken')).toHaveLength(1);
  });

  // Tier 1, #9250/r4505831913: absent/zero size metadata must not turn the
  // production downloader's permanent byte limit into startup/retry failure.
  it('keeps text and the listener after the real downloader rejects oversized bytes', async () => {
    const f = await fixture();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(BLUEBUBBLES_MAX_BYTES));
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    })));
    const downloader = new BlueBubblesApi(f.api.origin, 'test-only', fetcher);
    vi.spyOn(f.api, 'download').mockImplementation(guid => downloader.download(guid));
    for (const [guid, size] of [['missing-size', undefined], ['zero-size', 0]] as const) {
      f.message(guid, { text: guid, attachments: [{ guid, transferName: 'large.bin', totalBytes: size }] });
      expect((await f.webhook(guid)).status).toBe(202);
    }
    await f.im.reconcile();
    expect(f.received.map(event => [event.text, event.unsupported])).toEqual([
      ['missing-size', [{ type: 'oversize', label: 'large.bin' }]],
      ['zero-size', [{ type: 'oversize', label: 'large.bin' }]],
    ]);
    expect(f.state().inbox['missing-size'].state).toBe('accepted');
    expect(f.state().inbox['zero-size'].state).toBe('accepted');
    await f.im.dispose();
    await f.im.init();
    expect(f.im.getStatus().kind).toBe('connected');
    expect(fetcher).toHaveBeenCalledTimes(2);
    f.message('after-oversize');
    expect((await f.webhook('after-oversize')).status).toBe(202);
    await f.im.reconcile();
    expect(f.received.map(event => event.messageId)).toEqual(['missing-size', 'zero-size', 'after-oversize']);
  });

  // Tier 1, #9250/r4505831911: failed download/staging has not entered the
  // prepared queue. Stop must still cancel it durably, not later/other-chat work.
  it('withdraws old failed preparation on stop and preserves later and other-chat inputs on restart', async () => {
    const cacheImage = vi.fn(async (): Promise<{ absPath: string; url: string }> => { throw new Error('temporary staging failure'); });
    const f = await fixture(null, { cacheImage, getCachedImage: async () => null, resolveMediaUrl: () => null }, true);
    const download = vi.spyOn(f.api, 'download').mockImplementation(async guid => {
      if (guid !== 'staging') throw new Error('temporary download failure');
      return new Uint8Array([1]);
    });
    let cancelled = -1;
    f.im.onMessage(event => {
      if (event.text === '/stop') { cancelled = event.delivery!.cancelPending!(); event.delivery!.accept(); }
    });
    f.message('old-download', { attachments: [{ guid: 'download', transferName: 'old.bin' }] });
    f.message('old-staging', { attachments: [{ guid: 'staging', transferName: 'old.png' }] });
    await expect(f.im.reconcile()).rejects.toThrow('BLUEBUBBLES_RECEIVE_FAILED');
    f.message('stop-preparation', { text: '/stop' });
    f.message('later-preparation', { attachments: [{ guid: 'later', transferName: 'later.bin' }] });
    f.message('other-preparation', { chats: [f.otherChat], attachments: [{ guid: 'other', transferName: 'other.bin' }] });
    expect((await f.webhook('stop-preparation')).status).toBe(202);
    await expect(f.im.reconcile()).rejects.toThrow('BLUEBUBBLES_RECEIVE_FAILED');
    expect(cancelled).toBe(2);
    for (const guid of ['old-download', 'old-staging']) expect(f.state().inbox[guid].state).toBe('ignored');
    for (const guid of ['later-preparation', 'other-preparation']) expect(f.state().inbox[guid].state).toBe('pending');
    await f.im.dispose();
    download.mockClear().mockResolvedValue(new Uint8Array([1]));
    cacheImage.mockResolvedValue({ absPath: '/staging/image.png', url: 'cindy-media://image' });
    const before = f.received.length;
    await f.im.init();
    expect(f.im.getStatus().kind).toBe('connected');
    expect(f.received.slice(before).map(event => event.messageId)).toEqual(['later-preparation', 'other-preparation']);
    expect(download.mock.calls.map(([guid]) => guid)).toEqual(['later', 'other']);
  });

  // Tier 1, #9250: permanent format rejection must not poison startup catch-up.
  // Existing transient-download regression must keep its pending/retry behavior.
  it('dispatches accompanying text after permanent media rejection and restarts without redownloading it', async () => {
    const cacheImage = vi.fn(async () => { throw new UnsupportedInboundMediaError('image'); });
    const f = await fixture(null, { cacheImage, getCachedImage: async () => null, resolveMediaUrl: () => null });
    const download = vi.spyOn(f.api, 'download').mockResolvedValue(new Uint8Array([1]));
    f.message('heic', { text: 'keep this text', attachments: [{ guid: 'photo', transferName: 'photo.heic', mimeType: 'image/heic' }] });
    await f.im.reconcile();
    expect(f.received[0]).toMatchObject({ text: 'keep this text', attachments: [],
      unsupported: [{ type: 'unsupported', label: 'photo.heic' }] });
    expect(f.state().inbox.heic.state).toBe('accepted');
    await f.im.dispose();
    await f.im.init();
    expect(f.im.getStatus().kind).toBe('connected');
    expect(download).toHaveBeenCalledTimes(1);
    expect(f.received).toHaveLength(1);
    cacheImage.mockRejectedValueOnce(new Error('temporary storage failure'));
    f.message('retryable-media', { attachments: [{ guid: 'second-photo', transferName: 'second.heic', mimeType: 'image/heic' }] });
    await expect(f.im.reconcile()).rejects.toThrow('BLUEBUBBLES_RECEIVE_FAILED');
    expect(f.state().inbox['retryable-media'].state).toBe('pending');
    f.advance(30_000);
    await f.im.reconcile();
    expect(f.state().inbox['retryable-media'].state).toBe('accepted');
  });

  // Tier 1, #9250: an external runner's busy result must survive a process restart;
  // returning from an in-memory queue is not a durable user-message acceptance.
  it('retains busy inputs for restart and only acknowledges actual persistence', async () => {
    const f = await fixture();
    let busy = true;
    let persisted = true;
    let executions = 0;
    f.im.onMessage(event => {
      event.delivery?.awaitPersistence();
      if (busy) { event.delivery?.defer(); return; }
      executions++;
      if (persisted) f.im.acknowledgeIncoming(event.messageId);
    });
    f.message('queued');
    await f.webhook('queued');
    await f.im.reconcile();
    expect(f.state().inbox.queued.state).toBe('pending');
    expect(executions).toBe(0);
    await f.im.dispose();
    busy = false;
    await f.im.init();
    expect(f.state().inbox.queued.state).toBe('accepted');
    expect(executions).toBe(1);
    await f.im.reconcile();
    expect(executions).toBe(1);
    persisted = false;
    f.message('not-persisted');
    await f.webhook('not-persisted');
    await f.im.reconcile();
    expect(f.state().inbox['not-persisted'].state).toBe('dispatching');
    expect(f.im.health().uncertainInputs).toBe(1);
  });
  // Tier 1, #9250: a stop must persistently withdraw only its own chat's pending work.
  // Existing busy/restart regression covers recovery, not cancellation or a late queued callback.
  it('cancels deferred chat inputs durably without resurrecting late retries or stopping another chat', async () => {
    const f = await fixture(null, undefined, true);
    let busy = true;
    let stopped = 0;
    const queued: IMMessageEvent[] = [];
    f.im.onMessage(event => {
      event.delivery!.awaitPersistence();
      if (event.text === '/stop') { stopped = event.delivery!.cancelPending!(); event.delivery!.accept(); return; }
      if (busy) { queued.push(event); event.delivery!.defer(); }
      else f.im.acknowledgeIncoming(event.messageId);
    });
    f.message('queued-before-stop');
    f.message('other-chat', { chats: [f.otherChat] });
    await f.im.reconcile();
    expect(f.state().inbox['queued-before-stop'].state).toBe('pending');
    f.message('stop', { text: '/stop' });
    await f.im.reconcile();
    expect(stopped).toBe(1);
    expect(f.state().inbox['queued-before-stop'].state).toBe('ignored');
    expect(f.state().inbox['other-chat'].state).toBe('pending');
    const late = queued.find(event => event.messageId === 'queued-before-stop')!;
    expect(late.delivery!.isCancelled!()).toBe(true);
    late.delivery!.defer();
    late.delivery!.accept();
    expect(f.state().inbox['queued-before-stop'].state).toBe('ignored');
    await f.im.dispose();
    busy = false;
    const before = f.received.length;
    await f.im.init();
    expect(f.received.slice(before).map(event => event.messageId)).toEqual(['other-chat']);
    expect(f.state().inbox['other-chat'].state).toBe('accepted');
  });

  // Tier 1, review #9250: each health broadcast copied the permanent ledger.
  // Existing restart cases only used tiny ledgers; restored unresolved counts must
  // stay correct without snapshotting 10,000 completed receipts on every message.
  it('reports restored uncertain receipts without copying completed history', async () => {
    const initial: BlueBubblesState = { version: 1, activatedAt: 1000, cursors: {},
      inbox: { interrupted: { receivedAt: 1000, state: 'dispatching' } },
      outbox: { interrupted: { chatId: 'any;-;owner@example.test', state: 'sending' },
        unknown: { chatId: 'any;-;owner@example.test', state: 'unknown' } } };
    for (let i = 0; i < 10_000; i++) {
      initial.inbox[`old-${i}`] = { receivedAt: 1000, state: 'accepted' };
      initial.outbox[`old-${i}`] = { chatId: 'any;-;owner@example.test', state: 'sent' };
    }
    const f = await fixture(initial);
    const snapshot = vi.spyOn(BlueBubblesReceipts.prototype, 'snapshot').mockImplementation(() => {
      throw new Error('health must not copy permanent history');
    });
    try { expect(f.im.health()).toMatchObject({ uncertainInputs: 1, uncertainSends: 2 }); }
    finally { snapshot.mockRestore(); }
    f.send.mockImplementation(async () => {
      expect(f.im.health()).toMatchObject({ uncertainInputs: 1, uncertainSends: 2 });
      return { guid: 'completed-send' };
    });
    await f.im.sendText(f.chat.guid, 'new send');
    f.im.onMessage(() => {
      expect(f.im.health()).toMatchObject({ uncertainInputs: 1, uncertainSends: 2 });
    });
    f.message('new-input');
    await f.webhook('new-input');
    await f.im.reconcile();
    expect(f.im.health()).toMatchObject({ uncertainInputs: 1, uncertainSends: 2 });
  });
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

  // Tier 1, #9250/r4501143428/r4501238066: delivery can precede the prompt's
  // HTTP response or timeout. Immediate sends cannot expose lost accepted answers.
  it.each([[false, false], [true, false], [false, true]])('preserves an answered waiter before its prompt HTTP response (shared=%s, sendFails=%s)', async (useShared, sendFails) => {
    const f = await fixture();
    let finishSend!: (value: { guid: string }) => void;
    let failSend!: (error: Error) => void;
    f.send.mockImplementationOnce(() => new Promise((resolve, reject) => { finishSend = resolve; failSend = reject; }));
    const parse = vi.fn((text: string) => text.trim() || null);
    let finishShared!: (value: string) => void;
    const shared = useShared ? { result: new Promise<string>(resolve => { finishShared = resolve; }),
      decide: (value: string) => { finishShared(value); return true; } } : undefined;
    const reply = f.im.requestTextReply(f.chat.guid, 'What should I do?', parse, undefined, shared);
    try {
      f.message('first-answer', { text: 'answer' });
      await f.webhook('first-answer');
      await f.im.reconcile();
      f.message('new-work', { text: 'do another task' });
      await f.webhook('new-work');
      await f.im.reconcile();
      expect(f.received.map(event => event.messageId)).toEqual(['new-work']);
      expect(f.state().inbox['new-work'].state).toBe('accepted');
      expect(parse).toHaveBeenCalledTimes(1);
    } finally {
      if (sendFails) failSend(new Error('response timed out after delivery'));
      else finishSend({ guid: 'delivered-prompt' });
      await expect(reply).resolves.toBe('answer');
      expect(f.state().inbox['first-answer'].state).toBe('accepted');
      if (sendFails) expect(f.im.health().uncertainSends).toBe(1);
    }
  });

  // Tier 1, #9250/r4501238061: async preparation holds the per-chat handler lock
  // while stop and later work arrive. Existing stop cases only queue work before stop.
  it('cancels work preceding stop without losing a later request after restart', async () => {
    const f = await fixture();
    let finishPreparation!: () => void;
    const preparing = new Promise<void>(resolve => { finishPreparation = resolve; });
    let tail = Promise.resolve(), dropped = 0;
    const executed: string[] = [];
    f.im.onMessage(event => {
      event.delivery!.awaitPersistence();
      tail = tail.then(async () => {
        if (event.messageId === 'old-work') {
          await preparing;
          event.delivery!.defer();
        } else if (event.text === '/stop') {
          dropped = event.delivery!.cancelPending!();
          event.delivery!.accept();
        } else {
          executed.push(event.messageId);
          f.im.acknowledgeIncoming(event.messageId);
        }
      });
      return tail;
    });
    f.message('old-work');
    f.message('stop-boundary', { text: '/stop' });
    f.message('work-after-stop');
    try { await f.im.reconcile(); }
    finally { finishPreparation(); await tail; }
    expect(dropped).toBe(1);
    expect(f.state().inbox['old-work'].state).toBe('ignored');
    expect(f.state().inbox['work-after-stop'].state).toBe('pending');
    await f.im.dispose();
    await f.im.init();
    await tail;
    expect(executed).toEqual(['work-after-stop']);
    expect(f.state().inbox['work-after-stop'].state).toBe('accepted');
  });

  // Tier 1, #9250/r4501143430: a busy result followed by a free session in one
  // catch-up batch must not let a newer instruction overtake the durable pending input.
  it.each([false, true])('keeps newer chat inputs behind a deferred input (restart=%s)', async restart => {
    const f = await fixture(null, undefined, true);
    let busy = true;
    const executed: string[] = [];
    f.im.onMessage(event => {
      event.delivery!.awaitPersistence();
      if (event.messageId === 'older' && busy) {
        event.delivery!.defer();
        busy = false; // The preceding model turn finishes before the next dispatch.
        return;
      }
      executed.push(event.messageId);
      f.im.acknowledgeIncoming(event.messageId);
    });
    f.message('older');
    f.message('newer');
    f.message('other-chat-progress', { chats: [f.otherChat] });
    await f.im.reconcile();
    expect(executed).toEqual(['other-chat-progress']);
    expect(f.state().inbox.older.state).toBe('pending');
    expect(f.state().inbox.newer.state).toBe('pending');
    if (restart) { await f.im.dispose(); await f.im.init(); }
    else await f.im.reconcile();
    await f.im.reconcile();
    expect(executed).toEqual(['other-chat-progress', 'older', 'newer']);
    expect(f.state().inbox.older.state).toBe('accepted');
    expect(f.state().inbox.newer.state).toBe('accepted');
  });

  // Tier 1, #9250: queued text cannot authorize a question created after its arrival.
  // Existing confirmation test only covers a new reply following the prompt.
  it('does not consume a deferred yes as permission for a later request', async () => {
    const f = await fixture();
    f.im.onMessage(event => { event.delivery!.awaitPersistence(); event.delivery!.defer(); });
    f.message('old-yes', { text: 'yes' });
    await f.webhook('old-yes');
    await f.im.reconcile();
    expect(f.state().inbox['old-yes'].state).toBe('pending');
    let resolve!: (answer: string) => void;
    const shared = { result: new Promise<string>(done => { resolve = done; }),
      decide: vi.fn((answer: string) => { resolve(answer); return true; }) };
    const reply = f.im.requestTextReply(f.chat.guid, 'Allow this new action?', text => text === 'yes' ? text : null, undefined, shared);
    await f.im.reconcile();
    expect(shared.decide).not.toHaveBeenCalled();
    expect(f.state().inbox['old-yes'].state).toBe('pending');
    // Even a late first delivery of a historical message is not a new answer.
    f.message('delayed-yes', { text: 'yes', dateCreated: 1000 });
    await f.webhook('delayed-yes');
    await f.im.reconcile();
    expect(shared.decide).not.toHaveBeenCalled();
    f.message('new-yes', { text: 'yes' });
    await f.webhook('new-yes');
    await expect(reply).resolves.toBe('yes');
    expect(shared.decide).toHaveBeenCalledOnce();
    expect(f.state().inbox['new-yes'].state).toBe('accepted');
  });

  // Tier 1, #9250: arbitrary-text question parsers must not swallow control commands.
  it.each(['/stop', '!stop'])('passes owner %s to the handler and cancels its waiting question', async text => {
    const f = await fixture();
    const parse = vi.fn((value: string) => value.trim() || null);
    const reply = f.im.requestTextReply(f.chat.guid, 'What should I do?', parse);
    const rejected = expect(reply).rejects.toThrow('BLUEBUBBLES_INTERACTION_CANCELLED');
    f.message('stop-question', { text });
    await f.webhook('stop-question');
    await f.im.reconcile();
    await rejected;
    expect(parse).not.toHaveBeenCalled();
    expect(f.received.map(event => event.messageId)).toContain('stop-question');
    const next = f.im.requestTextReply(f.chat.guid, 'Next question?', value => value === 'fresh' ? value : null);
    f.message('fresh-answer', { text: 'fresh' });
    await f.webhook('fresh-answer');
    await expect(next).resolves.toBe('fresh');
  });

  // Tier 1, #9250: host cancellation must release only its correlated text slot.
  it('releases a cancelled request before the next HTTP message without cancelling another request', async () => {
    const f = await fixture();
    const abandoned = f.im.requestTextReply(f.chat.guid, 'Old question?', text => text, undefined, undefined, 'old-request');
    const cancelled = expect(abandoned).rejects.toThrow('BLUEBUBBLES_INTERACTION_CANCELLED');
    expect(f.im.cancelTextReply('different-request')).toBe(false);
    expect(f.im.cancelTextReply('old-request')).toBe(true);
    await cancelled;
    f.message('ordinary-after-cancel', { text: 'new work' });
    await f.webhook('ordinary-after-cancel');
    await f.im.reconcile();
    expect(f.received.map(event => event.messageId)).toContain('ordinary-after-cancel');
    const fresh = f.im.requestTextReply(f.chat.guid, 'New question?', text => text, undefined, undefined, 'new-request');
    expect(f.im.cancelTextReply('old-request')).toBe(false);
    f.message('fresh-reply', { text: 'new answer' });
    await f.webhook('fresh-reply');
    await expect(fresh).resolves.toBe('new answer');
  });

  // Tier 1, #9250: two group confirmations share an owner chat but retain independent decisions.
  it('keeps an occupied owner slot on its original request while a second permission waits for Desktop', async () => {
    const f = await fixture();
    let finishFirst!: (value: string) => void, finishSecond!: (value: string) => void;
    const firstShared = { result: new Promise<string>(resolve => { finishFirst = resolve; }),
      decide: vi.fn((value: string) => { finishFirst(value); return true; }) };
    const secondShared = { result: new Promise<string>(resolve => { finishSecond = resolve; }),
      decide: vi.fn((value: string) => { finishSecond(value); return true; }) };
    const first = f.im.requestTextReply(f.chat.guid, 'First permission?', text => text, undefined, firstShared, 'first');
    const second = f.im.requestTextReply(f.chat.guid, 'Second permission?', text => text, undefined, secondShared, 'second');
    const secondDecision = expect(second).resolves.toBe('desktop allowed');
    expect(f.im.cancelTextReply('second')).toBe(false);
    finishSecond('desktop allowed');
    await secondDecision;
    f.message('first-reply', { text: 'first allowed' });
    await f.webhook('first-reply');
    await expect(first).resolves.toBe('first allowed');
    expect(firstShared.decide).toHaveBeenCalledOnce();
    expect(secondShared.decide).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledTimes(1);
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
    f.advance(30_000);
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
