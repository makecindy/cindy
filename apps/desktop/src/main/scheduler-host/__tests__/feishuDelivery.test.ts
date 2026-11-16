import { describe, expect, it, vi } from 'vitest';
import type { Schedule, ScheduleRun } from '@cindy/maker-scheduler';
import { FeishuScheduleDelivery, renderFeishuDeliveryCard, type FeishuDeliveryState,
  type FeishuDeliveryTransport, type FeishuDeliveryDeps } from '../feishuDelivery.js';

// Value: exercise the real publish/configure/flush entry, not temporary IM scopes.
// Regression: scheduled/cross-task turns have NO_ACTIVE_FEISHU_SCOPE. No existing
// notifier tests covered authorized background groups, restart, or partial receipts.
// Minimum input: one successful report and two chats, with one API rejection.
// Tier: unit, injected atomic store/transport and clock; no user files or network.
const schedule = { id: 'daily', name: 'Daily report', targetSessionId: 'task', status: 'active' } as Schedule;
const run = { id: 'run-1', scheduleId: 'daily', status: 'success',
  resultText: 'Report\n\n| Metric | Value | Change |\n| --- | --- | --- |\n| Issues | 42 | +2 |\n\n- Detail' } as ScheduleRun;

function harness() {
  let state: FeishuDeliveryState = { bindings: {}, receipts: {} };
  let now = 1_000_000;
  let generation = 0;
  const send = vi.fn<FeishuDeliveryTransport['send']>(async chatId => ({ code: 0, messageId: `om_${chatId}` }));
  const checkChat = vi.fn(async () => {});
  const transport: FeishuDeliveryTransport = { identity: { appId: 'app_hihi', ownerOpenId: 'owner', service: 'feishu' },
    assertCurrent: () => {}, send, checkChat };
  const resolve = vi.fn(async () => transport);
  const getSchedule = vi.fn<FeishuDeliveryDeps['getSchedule']>(async () => schedule);
  const store = { read: () => structuredClone(state), update: async (fn: (s: FeishuDeliveryState) => FeishuDeliveryState) => {
    state = structuredClone(fn(structuredClone(state)));
  } };
  const create = (extra: Partial<FeishuDeliveryDeps> = {}) => new FeishuScheduleDelivery({ store, resolve, getSchedule, now: () => now,
    captureGuard: () => { const captured = generation; return () => { if (captured !== generation) throw new Error('account changed'); }; }, ...extra });
  return { service: create(), create, send, resolve, transport, checkChat, getSchedule, store,
    advance: (ms: number) => { now += ms; }, switchAccount: () => { generation++; } };
}

describe('scheduled Feishu group delivery', () => {
  it('allows revocation after the target or schedule is unavailable and clears pending content', async () => {
    const h = harness();
    await h.service.configure('daily', ['oc_a']);
    h.send.mockRejectedValue(new Error('offline'));
    await h.service.publish(schedule, run);
    h.getSchedule.mockResolvedValue(null);
    await expect(h.service.configure('daily', [])).resolves.toBeNull();
    expect(h.service.status('daily')).toMatchObject({ binding: null,
      receipts: [expect.objectContaining({ state: 'failed', error: 'DELIVERY_REVOKED' })] });
    expect(Object.values(h.store.read().receipts)[0].card).toBeUndefined();
  });

  it('refuses a configuration whose call authorization expires while waiting for the store lock', async () => {
    const h = harness();
    let active = true;
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const locked = new Promise<void>(resolve => { release = resolve; });
    const service = h.create({
      captureConfigurationGuard: () => () => { if (!active) throw new Error('call revoked'); },
      store: { ...h.store, update: async fn => { entered(); await locked; await h.store.update(fn); } },
    });
    const pending = service.configure('daily', ['oc_a']);
    await waiting; active = false; release();
    await expect(pending).rejects.toThrow('call revoked');
    expect(service.status('daily').binding).toBeNull();
  });

  it('verifies targets, pins identity, and exposes receipts without the report body', async () => {
    const h = harness();
    const binding = await h.service.configure('daily', ['oc_a', 'oc_b', 'oc_a']);
    expect(binding).toMatchObject({ sessionId: 'task', identity: { appId: 'app_hihi', ownerOpenId: 'owner' }, chatIds: ['oc_a', 'oc_b'] });
    expect(h.checkChat.mock.calls).toEqual([['oc_a'], ['oc_b']]);
    await h.service.publish(schedule, run);
    expect(h.service.status('daily').receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ chatId: 'oc_a', state: 'sent', code: 0, messageId: 'om_oc_a' }),
      expect.objectContaining({ chatId: 'oc_b', state: 'sent', code: 0, messageId: 'om_oc_b' }),
    ]));
    expect(JSON.stringify(h.service.status('daily'))).not.toContain('Issues');
    const card = h.send.mock.calls[0][1] as { schema: string; body: { elements: unknown[] } };
    expect(card.schema).toBe('2.0');
    expect(card.body.elements).toContainEqual(expect.objectContaining({ tag: 'table',
      rows: [{ c0: 'Issues', c1: '42', c2: '+2' }] }));
  });

  it('retries only the rejected chat across service restart; duplicate runs do not resend', async () => {
    const h = harness();
    await h.service.configure('daily', ['oc_a', 'oc_b']);
    h.send.mockImplementation(async chatId => chatId === 'oc_b' ? { code: 230002 } : { code: 0, messageId: 'om_a' });
    await h.service.publish(schedule, run);
    const failedUuid = h.send.mock.calls[1][2];
    expect(h.service.status('daily').receipts.find(r => r.chatId === 'oc_b')).toMatchObject({ state: 'pending', code: 230002, attempts: 1 });
    h.advance(60_000);
    h.send.mockResolvedValue({ code: 0, messageId: 'om_b' });
    const restored = h.create();
    await restored.publish(schedule, run);
    expect(h.send.mock.calls.map(c => c[0])).toEqual(['oc_a', 'oc_b', 'oc_b']);
    expect(h.send.mock.calls[2][2]).toBe(failedUuid);
    await restored.publish(schedule, run);
    expect(h.send).toHaveBeenCalledTimes(3);
  });

  it('recovers an expired send lease with the same uuid, but never blindly replays after the dedup horizon', async () => {
    const h = harness();
    await h.service.configure('daily', ['oc_a']);
    h.send.mockRejectedValue(new Error('lost response'));
    await h.service.publish(schedule, run);
    const uuid = h.send.mock.calls[0][2];
    await h.store.update(s => { const row = Object.values(s.receipts)[0]; row.state = 'sending'; row.leaseUntil = 0; return s; });
    h.advance(120_000);
    await h.create().flush();
    expect(h.send.mock.calls[1][2]).toBe(uuid);
    h.advance(60 * 60_000);
    await h.create().flush();
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.service.status('daily').receipts[0]).toMatchObject({ state: 'unknown', error: 'RECEIPT_UNKNOWN_NO_REPLAY' });
  });

  it('revokes pending sends and checks reconfiguration after asynchronous transport resolution', async () => {
    const h = harness();
    await h.service.configure('daily', ['oc_a']);
    h.resolve.mockImplementationOnce(async () => { await h.service.configure('daily', []); return h.transport; });
    await h.service.publish(schedule, run);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.service.status('daily')).toMatchObject({ binding: null,
      receipts: [expect.objectContaining({ state: 'failed', error: 'DELIVERY_REVOKED' })] });
  });

  it('makes repeated configuration idempotent and never changes the saved bot identity', async () => {
    const h = harness();
    const before = await h.service.configure('daily', ['oc_a']);
    expect(await h.service.configure('daily', ['oc_a'])).toEqual(before);
    h.transport.identity = { appId: 'app_other', ownerOpenId: 'owner', service: 'feishu' };
    await h.service.publish(schedule, run);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.service.status('daily').receipts[0]).toMatchObject({ state: 'failed', error: 'DELIVERY_IDENTITY_CHANGED' });
  });

  it('does not write an old account send result into a replacement account', async () => {
    const h = harness();
    await h.service.configure('daily', ['oc_a']);
    h.send.mockImplementation(async () => { h.switchAccount(); return { code: 0, messageId: 'om_old' }; });
    await expect(h.service.publish(schedule, run)).rejects.toThrow('account changed');
    expect(h.service.status('daily').receipts[0].messageId).toBeUndefined();
  });

  it('uses a durable claim to exclude another worker while a send is pending', async () => {
    const h = harness();
    await h.service.configure('daily', ['oc_a']);
    let release!: () => void;
    let started!: () => void;
    const sending = new Promise<void>(resolve => { started = resolve; });
    h.send.mockImplementation(async () => { started(); await new Promise<void>(resolve => { release = resolve; }); return { code: 0, messageId: 'om_a' }; });
    const first = h.service.publish(schedule, run);
    await sending;
    await h.create().flush();
    expect(h.send).toHaveBeenCalledTimes(1);
    release(); await first;
    expect(h.service.status('daily').receipts[0].state).toBe('sent');
  });

  it('requires code 0 and a message id, and bounds repeated ambiguous attempts', async () => {
    const h = harness();
    await h.service.configure('daily', ['oc_a']);
    h.send.mockResolvedValue({ code: 0 });
    await h.service.publish(schedule, run);
    for (const delay of [60_000, 5 * 60_000, 15 * 60_000, 20 * 60_000]) { h.advance(delay); await h.service.flush(); }
    expect(h.send).toHaveBeenCalledTimes(5);
    expect(h.service.status('daily').receipts[0]).toMatchObject({ state: 'unknown', error: 'MISSING_MESSAGE_ID' });
    h.advance(60_000); await h.service.flush();
    expect(h.send).toHaveBeenCalledTimes(5);
  });

  it('does not publish unsuccessful runs, unbound targets, or an oversized partial report', async () => {
    const h = harness();
    await expect(h.service.configure('daily', ['not_a_chat'])).rejects.toThrow('Invalid');
    h.getSchedule.mockResolvedValueOnce({ ...schedule, targetSessionId: undefined });
    await expect(h.service.configure('daily', ['oc_a'])).rejects.toThrow('Bind');
    await h.service.configure('daily', ['oc_a']);
    await h.service.publish(schedule, { ...run, status: 'failed' });
    await expect(h.service.publish(schedule, { ...run, resultText: '大'.repeat(15_000) })).rejects.toThrow('size limit');
    expect(h.store.read().receipts).toEqual({});
    expect(h.send).not.toHaveBeenCalled();
  });

  it('keeps table-like code literal and handles escaped pipes in a real table', () => {
    const card = renderFeishuDeliveryCard('Title', '```\n| A | B |\n| --- | --- |\n```\n\n| A | B |\n| --- | --- |\n| x\\|y | z |') as { body: { elements: unknown[] } };
    expect(card.body.elements).toHaveLength(2);
    expect(card.body.elements[1]).toMatchObject({ tag: 'table', rows: [{ c0: 'x|y', c1: 'z' }] });
  });
});
