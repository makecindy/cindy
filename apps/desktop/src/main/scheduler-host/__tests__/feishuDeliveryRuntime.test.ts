import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeishuIM } from '@cindy/im';
import type { Schedule, ScheduleRun, Scheduler } from '@cindy/maker-scheduler';
import { getFeishuScheduleDelivery, startFeishuScheduleDelivery, stopFeishuScheduleDelivery } from '../feishuDeliveryRuntime.desktop.js';

// Separate adapter environment: real atomic file store, fake host/account/transport.
// Production entry: scheduler startup + configured delivery. Rule: account isolation
// and no success without a real receipt. The pure service tests cannot prove the
// wire payload, durable reopening, corrupt-file preservation or lifecycle shutdown.
// Minimum input: one report/one target with code=0 and a message_id. Tier: unit;
// files are unique tmpdir fixtures, no Electron, real account data or external API.
const host = vi.hoisted(() => ({ root: '', owner: 'a', appId: 'app_hihi', boundary: false, taskStatus: 'active',
  callApi: vi.fn(), getChatInfo: vi.fn(async () => ({})) }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => host.owner,
  isAppSessionBoundaryPending: () => host.boundary,
  ownerScopedUserDataPath: (name: string) => path.join(host.root, host.owner, name),
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ status: host.taskStatus }] }) }) }),
} }) }));
vi.mock('../../localDb/schema.js', () => ({ sessions: { status: 'status', id: 'id' } }));
vi.mock('../../im/shared/botImConnectionRuntime.js', () => ({ getBotFeishuTransport: vi.fn() }));
vi.mock('../../mcp-integrations/feishuTransportRouting.js', () => ({
  createFeishuTransportResolver: (deps: { readTurnScope: () => unknown; personalIm: FeishuIM }) => async () => {
    expect(deps.readTurnScope()).toBeNull();
    return { im: deps.personalIm, assertCurrent: () => { if (host.boundary) throw new Error('account changed'); } };
  },
}));

const schedule = { id: 'daily', name: 'report', status: 'active', targetSessionId: 'task' } as Schedule;
const run = { id: 'run', scheduleId: 'daily', status: 'success', resultText: '| Metric | Count |\n| --- | --- |\n| Issue | 7 |' } as ScheduleRun;
const scheduler = { get: vi.fn(async () => schedule) } as unknown as Scheduler;
const im = { getBotAppId: () => host.appId, getOwnerOpenId: () => 'owner', getService: () => 'feishu',
  getChatInfo: host.getChatInfo, callApi: host.callApi } as unknown as FeishuIM;
const start = () => startFeishuScheduleDelivery(scheduler, im, true);

beforeEach(() => {
  host.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-feishu-delivery-'));
  host.owner = 'a'; host.appId = 'app_hihi'; host.boundary = false;
  host.taskStatus = 'active';
  host.callApi.mockReset().mockResolvedValue({ code: 0, data: { message_id: 'om_success' } });
  start();
});
afterEach(() => { stopFeishuScheduleDelivery(); fs.rmSync(host.root, { recursive: true, force: true }); });

describe('Feishu delivery Desktop adapter', () => {
  it('sends via the pinned bot with an explicit chat_id and persists a real receipt across restart', async () => {
    await getFeishuScheduleDelivery().configure('daily', ['oc_authorized']);
    await getFeishuScheduleDelivery().publish(schedule, run);
    expect(host.callApi).toHaveBeenCalledExactlyOnceWith({ method: 'POST', path: '/open-apis/im/v1/messages',
      params: { receive_id_type: 'chat_id' }, data: { receive_id: 'oc_authorized', msg_type: 'interactive',
        content: expect.any(String), uuid: expect.stringMatching(/^[a-f0-9]{32}$/) } });
    expect(JSON.parse(host.callApi.mock.calls[0][0].data.content).body.elements[0].tag).toBe('table');
    stopFeishuScheduleDelivery(); start();
    expect(getFeishuScheduleDelivery().status('daily').receipts[0]).toMatchObject({ code: 0, messageId: 'om_success', state: 'sent' });
    await getFeishuScheduleDelivery().publish(schedule, run);
    expect(host.callApi).toHaveBeenCalledTimes(1);
  });

  it('does not mistake missing code or SDK business rejection for delivery', async () => {
    await getFeishuScheduleDelivery().configure('daily', ['oc_authorized']);
    host.callApi.mockResolvedValueOnce({ data: { message_id: 'om_unproven' } });
    await getFeishuScheduleDelivery().publish(schedule, run);
    expect(getFeishuScheduleDelivery().status('daily').receipts[0].state).toBe('pending');
    expect(getFeishuScheduleDelivery().status('daily').receipts[0].code).toBeUndefined();
    host.callApi.mockRejectedValueOnce(Object.assign(new Error('SDK business reject'), { code: 230002 }));
    await getFeishuScheduleDelivery().publish(schedule, { ...run, id: 'run-2' });
    expect(getFeishuScheduleDelivery().status('daily').receipts[1]).toMatchObject({ state: 'pending', code: 230002 });
  });

  it('isolates owners and rejects stale service handles after shutdown', async () => {
    const old = getFeishuScheduleDelivery();
    await old.configure('daily', ['oc_authorized']);
    host.owner = 'b'; start();
    expect(getFeishuScheduleDelivery().status('daily')).toEqual({ binding: null, receipts: [] });
    await expect(old.publish(schedule, run)).rejects.toThrow('account changed');
    expect(host.callApi).not.toHaveBeenCalled();
  });

  it('fails closed on corrupt persisted state without replacing the file or sending', async () => {
    await getFeishuScheduleDelivery().configure('daily', ['oc_authorized']);
    const file = path.join(host.root, 'a', 'scheduler-feishu-delivery.json');
    fs.writeFileSync(file, '{"bindings": "broken"}');
    await expect(getFeishuScheduleDelivery().publish(schedule, run)).rejects.toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('{"bindings": "broken"}');
    expect(host.callApi).not.toHaveBeenCalled();
  });

  it('drops queued report content instead of sending it after its bound task is deleted', async () => {
    await getFeishuScheduleDelivery().configure('daily', ['oc_authorized']);
    host.taskStatus = 'deleted';
    await getFeishuScheduleDelivery().publish(schedule, run);
    expect(host.callApi).not.toHaveBeenCalled();
    expect(getFeishuScheduleDelivery().status('daily').receipts[0]).toMatchObject({ state: 'failed', error: 'DELIVERY_REVOKED' });
    const file = path.join(host.root, 'a', 'scheduler-feishu-delivery.json');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('"card"');
  });
});
