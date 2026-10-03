import { makeMessageOpResult, parseHookMessage, serializeHookMessage, type MessageOpResultPayload } from '@cindy/slack-hook-protocol';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTelegramDeliveryBridge, selectTelegramDeliveryTarget, type TelegramDeliveryInput } from '../telegramDelivery';

const binding = { bindingId: 'bound', principalId: 'owner', principalName: 'Owner', scopeId: 'bot', scopeName: 'test_bot' };
const target = selectTelegramDeliveryTarget(binding, ['telegram:dm:bot:owner:g1'])!;
const input: TelegramDeliveryInput = {
  idempotencyKey: 'sample:part:1', target, text: '<b>新版日报测试 📮</b>', tier: 'html',
  sourceSha256: 'a'.repeat(64), presentationSha256: 'b'.repeat(64),
};
const directories: string[] = [];
afterEach(() => { for (const p of directories.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });
function sent(opId: string, messageId = '123'): MessageOpResultPayload {
  return { opId, ok: true, deliveryState: 'sent', messageId,
    sentMessage: { chatId: target.principalId, text: '新版日报测试 📮', entities: [{ type: 'bold', offset: 0, length: '新版日报测试 📮'.length }], tier: 'html' } };
}
function harness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-telegram-delivery-'));
  directories.push(directory);
  const status = vi.fn(() => ({ connected: true, supported: true, sendEpoch: 'epoch', target }));
  const send = vi.fn(async (payload: { opId: string }): Promise<MessageOpResultPayload | null> => sent(payload.opId));
  return { directory, status, send, bridge: createTelegramDeliveryBridge({ directory, status, send }) };
}
describe('official Telegram delivery', () => {
  it('selects only an existing DM for the live principal and bot, using latest generation', () => {
    expect(selectTelegramDeliveryTarget(binding, [
      'telegram:dm:bot:other:g90', 'telegram:group:bot:-10:owner:g9',
      'telegram:dm:bot:owner:g2', 'telegram:dm:bot:owner:g10', 'telegram:dm:other:owner:g99',
    ])?.externalKey).toBe('telegram:dm:bot:owner:g10');
    expect(selectTelegramDeliveryTarget(binding, ['telegram:dm:bot:other:g1'])).toBeNull();
    expect(selectTelegramDeliveryTarget(binding, ['telegram:dm:owner:g1'])).toBeNull();
  });
  it('persists started before sending and preserves real receipt across restarts', async () => {
    const h = harness();
    h.send.mockImplementation(async payload => {
      expect(h.bridge.receipt(input.idempotencyKey)?.state).toBe('started');
      return sent(payload.opId);
    });
    const receipt = await h.bridge.send(input);
    expect(receipt).toMatchObject({ state: 'sent', target, formatVerified: false, result: { messageId: '123' } });
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({
      scope: { externalKey: target.externalKey }, action: expect.objectContaining({ kind: 'send', text: input.text, tier: 'html', delivery: expect.objectContaining({ bindingId: 'bound', epoch: 'epoch' }) }),
    }));
    const restarted = createTelegramDeliveryBridge(h);
    expect(await restarted.send(input)).toEqual(receipt);
    expect(h.send).toHaveBeenCalledTimes(1);
    await expect(restarted.send({ ...input, text: 'changed' })).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  });
  it.each(['timeout', 'negative', 'missing-id', 'wrong-op'])('never resends %s outcomes', async kind => {
    const h = harness();
    const send = vi.fn(async (payload: { opId: string }) => {
      if (kind === 'timeout') throw new Error('secret transport detail');
      if (kind === 'negative') return { opId: payload.opId, ok: false, error: 'upstream unavailable' };
      if (kind === 'wrong-op') return { opId: 'another-operation', ok: true, messageId: '123' };
      return { opId: payload.opId, ok: true };
    });
    const bridge = createTelegramDeliveryBridge({ ...h, send });
    expect((await bridge.send(input)).state).toBe('unknown');
    expect((await bridge.send(input)).state).toBe('unknown');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('excludes a concurrent bridge instance while the first send is still in flight', async () => {
    const h = harness();
    let finish!: (v: MessageOpResultPayload) => void;
    let opId = '';
    const send = vi.fn((p: { opId: string }) => { opId = p.opId; return new Promise<MessageOpResultPayload>(r => { finish = r; }); });
    const a = createTelegramDeliveryBridge({ ...h, send });
    const b = createTelegramDeliveryBridge({ ...h, send });
    const pending = a.send(input);
    expect((await b.send(input)).state).toBe('started');
    finish(sent(opId, '7'));
    expect((await pending).state).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('does not create claims for old servers, disconnected accounts or changed targets', async () => {
    const h = harness();
    h.status.mockReturnValue({ connected: true, supported: false, sendEpoch: 'epoch', target });
    await expect(h.bridge.send(input)).rejects.toThrow();
    h.status.mockReturnValue({ connected: false, supported: true, sendEpoch: 'epoch', target });
    await expect(h.bridge.send(input)).rejects.toThrow();
    h.status.mockReturnValue({ connected: true, supported: true, sendEpoch: 'epoch', target: { ...target, principalId: 'new-owner' } });
    await expect(h.bridge.send(input)).rejects.toThrow();
    expect(h.send).not.toHaveBeenCalled();
    expect(fs.readdirSync(h.directory)).toEqual([]);
  });
  it('accepts a matching late receipt after timeout without sending again', async () => {
    const h = harness();
    const send = vi.fn(async () => null);
    const bridge = createTelegramDeliveryBridge({ ...h, send });
    const unknown = await bridge.send(input);
    expect(unknown.state).toBe('unknown');
    bridge.onResult(sent(unknown.opId, '42'));
    expect(bridge.receipt(input.idempotencyKey)).toMatchObject({ state: 'sent', result: { messageId: '42' } });
    expect((await bridge.send(input)).state).toBe('sent');
    expect(bridge.receipt(input.idempotencyKey)?.code).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('records explicit refusal without automatically creating another operation', async () => {
    const h = harness();
    h.send.mockImplementation(async p => ({ opId: p.opId, ok: false, deliveryState: 'not_sent', error: 'telegram 429' }));
    expect((await h.bridge.send(input)).state).toBe('not_sent');
    expect((await h.bridge.send(input)).state).toBe('not_sent');
    expect(h.send).toHaveBeenCalledOnce();
  });
  it('keeps a wrong-recipient or ID-only acknowledgement unknown', async () => {
    const h = harness();
    h.send.mockImplementation(async p => ({ ...sent(p.opId), sentMessage: { ...sent(p.opId).sentMessage!, chatId: 'other' } }));
    expect((await h.bridge.send(input)).state).toBe('unknown');
    const another = harness();
    another.send.mockImplementation(async p => ({ opId: p.opId, ok: true, messageId: '123' }));
    expect((await another.bridge.send(input)).state).toBe('unknown');
  });
  it('reconciles a wire-validated UTF-16 receipt after restart and never downgrades sent', async () => {
    const h = harness();
    const send = vi.fn(async () => null);
    const original = createTelegramDeliveryBridge({ ...h, send });
    const row = await original.send(input);
    const restarted = createTelegramDeliveryBridge({ ...h, send });
    const text = '📮 新版日报测试';
    const result: MessageOpResultPayload = { ...sent(row.opId),
      sentMessage: { chatId: target.principalId, text, tier: 'html',
        entities: [{ type: 'bold', offset: 3, length: 6 }] } };
    const parsed = parseHookMessage(serializeHookMessage(makeMessageOpResult(result)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.message.type !== 'msg.op.result') throw new Error('invalid fixture');
    restarted.onResult(parsed.message.payload);
    // A stale timeout/rejection must not erase proof of a successful delivery.
    restarted.onResult({ opId: row.opId, ok: false, deliveryState: 'not_sent' });
    expect(await restarted.send(input)).toMatchObject({ state: 'sent', result });
    expect(send).toHaveBeenCalledOnce();
  });
  it('preserves a receipt that arrives while the original send is settling', async () => {
    const h = harness();
    const bridge = createTelegramDeliveryBridge({ ...h, send: async payload => {
      h.bridge.onResult(sent(payload.opId));
      return null;
    } });
    expect(await bridge.send(input)).toMatchObject({ state: 'sent', result: { messageId: '123' } });
    expect(bridge.receipt(input.idempotencyKey)?.state).toBe('sent');
  });
  it('does not send after a torn journal write' , async () => {
    const h = harness();
    fs.writeFileSync(path.join(h.directory, createHash('sha256').update(input.idempotencyKey).digest('hex') + '.json'), '{');
    await expect(h.bridge.send(input)).rejects.toThrow('DELIVERY_JOURNAL_UNREADABLE');
    expect(h.send).not.toHaveBeenCalled();
  });
});

it('preserves a sent receipt published between a stale read and its write', async () => {
  const h = harness();
  const bridge = createTelegramDeliveryBridge({ ...h, send: async () => null });
  const row = await bridge.send(input);
  const rename = fs.renameSync.bind(fs);
  const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    spy.mockRestore();
    h.bridge.onResult(sent(row.opId, '999'));
    rename(from, to);
  });
  try {
    bridge.onResult({ opId: row.opId, ok: false, deliveryState: 'not_sent' });
    expect(bridge.receipt(input.idempotencyKey)).toMatchObject({ state: 'sent', result: { messageId: '999' } });
  } finally { spy.mockRestore(); }
});
it('keeps a confirmed plain presentation sent for an HTML request', async () => {
  const h = harness();
  h.send.mockImplementation(async p => ({ ...sent(p.opId), sentMessage: { ...sent(p.opId).sentMessage!, tier: 'plain' } }));
  expect(await h.bridge.send(input)).toMatchObject({ state: 'sent', requestedTier: 'html', formatVerified: false, result: { sentMessage: { tier: 'plain' } } });
});

it('retains type-specific wire entities in a durable late receipt', async () => {
  const h = harness();
  const bridge = createTelegramDeliveryBridge({ ...h, send: async () => null });
  const row = await bridge.send(input);
  const entities = [
    { type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: '123456789' },
    { type: 'text_mention', offset: 3, length: 3, user: { id: 101, is_bot: false, first_name: 'Ada' } },
    { type: 'date_time', offset: 7, length: 4, unix_time: 1789000000, date_time_format: 'r' },
  ];
  const result = { ...sent(row.opId), sentMessage: { chatId: target.principalId, text: '📮 Ada time', tier: 'html' as const, entities } };
  const parsed = parseHookMessage(serializeHookMessage(makeMessageOpResult(result)));
  if (!parsed.ok || parsed.message.type !== 'msg.op.result') throw new Error('invalid fixture');
  bridge.onResult(parsed.message.payload);
  expect(createTelegramDeliveryBridge(h).receipt(input.idempotencyKey)).toMatchObject({ state: 'sent', result: { sentMessage: { entities } } });
});


it.each(['write', 'fsync'] as const)('removes only its own unsent claim after %s fails', async operation => {
  const h = harness();
  const error = Object.assign(new Error('fixture disk failure'), { code: 'ENOSPC' });
  const realWrite = fs.writeFileSync.bind(fs);
  const spy = operation === 'write'
    ? vi.spyOn(fs, 'writeFileSync').mockImplementationOnce((file) => { realWrite(file, '{'); throw error; })
    : vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw error; });
  try {
    await expect(h.bridge.send(input)).rejects.toThrow('fixture disk failure');
    expect(h.send).not.toHaveBeenCalled();
    expect(fs.readdirSync(h.directory)).toEqual([]);
  } finally { spy.mockRestore(); }
  // Explicit retry after a proven pre-network failure may create a new claim.
  expect(await createTelegramDeliveryBridge(h).send(input)).toMatchObject({ state: 'sent' });
  expect(h.send).toHaveBeenCalledOnce();
});

it('preserves the claim when result persistence fails after the network attempt', async () => {
  const h = harness();
  h.send.mockImplementation(async () => null);
  const realSync = fs.fsyncSync.bind(fs);
  let fileSyncs = 0;
  const spy = vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    if (fs.fstatSync(fd).isFile() && ++fileSyncs === 2) throw new Error('fixture result fsync failure');
    realSync(fd);
  });
  try { await expect(h.bridge.send(input)).rejects.toThrow('fixture result fsync failure'); }
  finally { spy.mockRestore(); }
  expect(await createTelegramDeliveryBridge(h).send(input)).toMatchObject({ state: 'started' });
  expect(h.send).toHaveBeenCalledOnce();
});


it('keeps an unsent claim fail-closed when cleanup itself fails', async () => {
  const h = harness();
  const realWrite = fs.writeFileSync.bind(fs);
  const write = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(file => { realWrite(file, '{'); throw new Error('fixture disk failure'); });
  const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => { throw new Error('fixture cleanup failure'); });
  try { await expect(h.bridge.send(input)).rejects.toThrow('fixture disk failure'); }
  finally { write.mockRestore(); unlink.mockRestore(); }
  await expect(createTelegramDeliveryBridge(h).send(input)).rejects.toThrow('DELIVERY_JOURNAL_UNREADABLE');
  expect(h.send).not.toHaveBeenCalled();
});


it.skipIf(process.platform === 'win32')('syncs the claim directory and new ancestors before any network attempt', async () => {
  const h = harness();
  const nested = path.join(h.directory, 'new-owner', 'receipts');
  const opened = new Map<number, string>();
  const synced: string[] = [];
  const realOpen = fs.openSync.bind(fs), realSync = fs.fsyncSync.bind(fs);
  const open = vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
    const fd = realOpen(file, flags, mode); opened.set(fd, String(file)); return fd;
  });
  const sync = vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    if (fs.fstatSync(fd).isDirectory()) synced.push(opened.get(fd)!);
    realSync(fd);
  });
  const send = vi.fn(async (payload: { opId: string }) => {
    expect(synced).toContain(fs.realpathSync(nested));
    expect(synced).toContain(fs.realpathSync(path.dirname(nested)));
    expect(synced).toContain(fs.realpathSync(h.directory));
    return sent(payload.opId);
  });
  try {
    expect(await createTelegramDeliveryBridge({ ...h, directory: nested, send }).send(input)).toMatchObject({ state: 'sent' });
  } finally { open.mockRestore(); sync.mockRestore(); }
});

it.skipIf(process.platform === 'win32')('does not send when the claim directory cannot be synced', async () => {
  const h = harness();
  const realSync = fs.fsyncSync.bind(fs);
  const sync = vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    if (fs.fstatSync(fd).isDirectory()) throw new Error('fixture directory sync failed');
    realSync(fd);
  });
  try {
    await expect(h.bridge.send(input)).rejects.toThrow('fixture directory sync failed');
    expect(h.send).not.toHaveBeenCalled();
  } finally { sync.mockRestore(); }
  expect(await h.bridge.send(input)).toMatchObject({ state: 'sent' });
  expect(h.send).toHaveBeenCalledOnce();
});


it.skipIf(process.platform === 'win32').each(['sent', 'unknown', 'late'] as const)(
  'syncs the published %s receipt after removing temporary names', async outcome => {
    const h = harness();
    if (outcome !== 'sent') h.send.mockImplementation(async () => null);
    const realSync = fs.fsyncSync.bind(fs);
    const publications: string[][] = [];
    const sync = vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      const stat = fs.fstatSync(fd);
      const directory = fs.statSync(h.directory);
      if (stat.isDirectory() && stat.dev === directory.dev && stat.ino === directory.ino) {
        publications.push(fs.readdirSync(h.directory));
      }
      realSync(fd);
    });
    try {
      const row = await h.bridge.send(input);
      if (outcome === 'late') {
        publications.length = 0;
        h.bridge.onResult(sent(row.opId));
      }
      const suffix = outcome === 'unknown' ? '.result' : '.sent';
      expect(publications.some(files => files.some(file => file.endsWith(suffix)) &&
        files.every(file => !file.endsWith('.tmp')))).toBe(true);
      expect(createTelegramDeliveryBridge(h).receipt(input.idempotencyKey)?.state)
        .toBe(outcome === 'unknown' ? 'unknown' : 'sent');
      expect(h.send).toHaveBeenCalledOnce();
    } finally { sync.mockRestore(); }
  },
);

it.skipIf(process.platform === 'win32')('retains the claim when the published receipt directory cannot be synced', async () => {
  const h = harness();
  const realSync = fs.fsyncSync.bind(fs);
  const sync = vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    if (fs.fstatSync(fd).isDirectory() && h.send.mock.calls.length > 0) {
      throw new Error('fixture receipt directory sync failed');
    }
    realSync(fd);
  });
  try {
    await expect(h.bridge.send(input)).rejects.toThrow('fixture receipt directory sync failed');
  } finally { sync.mockRestore(); }
  const files = fs.readdirSync(h.directory);
  expect(files.some(file => file.endsWith('.json'))).toBe(true);
  expect(files.every(file => !file.endsWith('.tmp'))).toBe(true);
  await createTelegramDeliveryBridge(h).send(input);
  expect(h.send).toHaveBeenCalledOnce();
});

it.each(['plain', 'html'] as const)('rejects oversized %s before claiming and accepts a corrected same-key message', async (tier) => {
  const h = harness();
  for (const text of ['a'.repeat(4097), '📮'.repeat(2048) + 'a', 'a'.repeat(16000)]) {
    await expect(h.bridge.send({ ...input, tier, text })).rejects.toThrow('INVALID_DELIVERY_INPUT');
    expect(h.bridge.receipt(input.idempotencyKey)).toBeNull();
  }
  expect(fs.readdirSync(h.directory)).toEqual([]);
  expect(h.send).not.toHaveBeenCalled();
  await expect(h.bridge.send({ ...input, tier, text: '📮'.repeat(2048) })).resolves.toMatchObject({ state: 'sent' });
  expect(h.send).toHaveBeenCalledTimes(1);
});

it('bounds HTML source conservatively before claiming without truncating markup', async () => {
  const h = harness();
  for (const text of ['<b>' + 'a'.repeat(4097) + '</b>', '&amp;'.repeat(3000)]) {
    await expect(h.bridge.send({ ...input, text })).rejects.toThrow('INVALID_DELIVERY_INPUT');
    expect(h.bridge.receipt(input.idempotencyKey)).toBeNull();
  }
  expect(h.send).not.toHaveBeenCalled();
  expect(fs.readdirSync(h.directory)).toEqual([]);
  const text = '<b>' + '&amp;'.repeat(817) + 'abcd</b>';
  expect(text.length).toBe(4096);
  await expect(h.bridge.send({ ...input, text })).resolves.toMatchObject({ state: 'sent' });
  expect(h.send).toHaveBeenCalledOnce();
});
