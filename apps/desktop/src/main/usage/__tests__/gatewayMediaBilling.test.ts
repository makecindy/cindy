import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseGatewayMediaBillingHeader } from '../gatewayMediaBillingHeader.js';
import type { DbClient } from '../../localDb/client/DbClient.js';
import { waitForRetainedDbClient } from '../../localDb/client/pendingOperations.js';

const mocks = vi.hoisted(() => ({
  owner: 'owner-a',
  current: true,
  currency: 'CNY' as 'CNY' | 'USD' | null,
  tx: vi.fn(),
  sessionPush: vi.fn(),
  todayPush: vi.fn(),
  warn: vi.fn(),
  turnPush: vi.fn(),
  schedulePush: vi.fn(),
  captureTurn: vi.fn(),
  refreshTurn: vi.fn(),
}));
vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({ tx: mocks.tx }),
  getCurrentDbClientUserId: () => mocks.owner,
}));
vi.mock('../../localDb/dailySpend.js', () => ({ localDayKey: () => '2026-10-15' }));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => ({ ownerScopeKey: mocks.owner }),
  isDataOwnerBroadcastScopeCurrent: (scope: { ownerScopeKey: string }) =>
    mocks.current && scope.ownerScopeKey === mocks.owner,
}));
vi.mock('../../sessionSpendBroadcaster.js', () => ({ broadcastSessionSpend: mocks.sessionPush }));
vi.mock('../../usageBroadcaster.js', () => ({ rebroadcastTodaySpend: mocks.todayPush }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: mocks.warn }) }));
vi.mock('../../maker-host/active-catalog.js', () => ({ getActiveCatalog: () => ({ providers: [] }) }));
vi.mock('../modelPricing.js', () => ({
  getGatewayMediaBillingCurrency: async () => mocks.currency,
}));
vi.mock('../mediaTurnCost.js', () => ({
  captureMediaUserTurn: mocks.captureTurn,
  refreshMediaUserTurnCost: mocks.refreshTurn,
}));
vi.mock('../../messagePersistBroadcaster.js', () => ({
  enqueueDurableWrite: (_label: string, fn: () => unknown) => Promise.resolve(fn()),
}));
vi.mock('../../turnCostBroadcaster.js', () => ({ broadcastTurnCostPayload: mocks.turnPush }));
vi.mock('../../maker-ipc/schedule.js', () => ({ broadcastSchedulerChanged: mocks.schedulePush }));

import { prepareGatewayMediaBilling } from '../gatewayMediaBilling.js';

const encode = (payload: unknown) => Buffer.from(JSON.stringify(payload)).toString('base64url');
const response = (payload: unknown, status = 200) =>
  new Response('invalid response body', {
    status,
    headers: { 'X-Nova-AIGateway-Billing': encode(payload) },
  });

describe('Gateway media billing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.owner = 'owner-a';
    mocks.current = true;
    mocks.currency = 'CNY';
    mocks.tx.mockResolvedValue(null);
    mocks.captureTurn.mockResolvedValue({ clientId: 'original-user', scheduleId: 'schedule-1' });
    mocks.refreshTurn.mockResolvedValue({
      sessionId: 'session-1',
      clientId: 'answer',
      userTurnMoney: { amount: 0.75, currency: 'CNY' },
    });
  });

  it('accepts the Nova payload with optional provider metadata and unpadded Base64URL', () => {
    expect(
      parseGatewayMediaBillingHeader(
        encode({
          cost: 0.123,
          model: 'seedance-2.0',
          task_id: 'task-1',
          custom_llm_provider: 'seedance',
          metadata: { output_tokens: 1200 },
        }),
      ),
    ).toEqual({ cost: 0.123, model: 'seedance-2.0' });
    expect(parseGatewayMediaBillingHeader(encode({ cost: 0 }))).toEqual({ cost: 0 });
  });

  it.each([
    null,
    '',
    'not-json',
    encode({ cost: -1 }),
    encode({ cost: '1' }),
    encode({ cost: true }),
    encode({}),
    encode([]),
    Buffer.from('{"cost":1e400}').toString('base64url'),
  ])('rejects invalid billing %s', (header) => {
    expect(parseGatewayMediaBillingHeader(header)).toBeNull();
  });

  it('records the exact header cost once before body parsing, with captured currency and Host task', async () => {
    mocks.tx.mockResolvedValue({ legacyUsd: 0, amount: 3.5, currency: 'CNY', approximate: 0 });
    const record = await prepareGatewayMediaBilling({
      model: 'request-model',
      sessionId: 'session-1',
    });
    mocks.currency = 'USD';
    const res = response({ cost: 0.75, model: 'billed-model' });
    await record(res);
    await record(res);
    expect(res.bodyUsed).toBe(false);
    expect(mocks.tx).toHaveBeenCalledExactlyOnceWith('usage.recordMediaSpend', {
      day: '2026-10-15',
      model: 'billed-model',
      amount: 0.75,
      currency: 'CNY',
      sessionId: 'session-1',
      userClientId: 'original-user',
      now: expect.any(Number),
    });
    expect(mocks.sessionPush).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        totalMoney: { amount: 3.5, currency: 'CNY', approximate: false, kind: 'actual-cost' },
      }),
      expect.anything(),
    );
    expect(mocks.todayPush).toHaveBeenCalledOnce();
    expect(mocks.refreshTurn).toHaveBeenCalledWith(expect.anything(), 'session-1', 'original-user');
    expect(mocks.turnPush).toHaveBeenCalledOnce();
    expect(mocks.schedulePush).toHaveBeenCalledExactlyOnceWith('schedule-1');
  });

  it('uses the submitted model when the header omits it', async () => {
    await (
      await prepareGatewayMediaBilling({ model: 'request-model' })
    )(response({ cost: 1 }));
    expect(mocks.tx).toHaveBeenCalledWith(
      'usage.recordMediaSpend',
      expect.objectContaining({ model: 'request-model' }),
    );
  });

  it('retains the original database after an account switch without notifying the new owner', async () => {
    const db = { tx: mocks.tx } as unknown as DbClient;
    const record = await prepareGatewayMediaBilling({ model: 'image', db });
    let drained = false;
    const draining = waitForRetainedDbClient(db).then(() => { drained = true; });
    mocks.owner = 'owner-b';
    await Promise.resolve();
    expect(drained).toBe(false);
    await record(response({ cost: 1 }));
    await draining;
    expect(drained).toBe(true);
    expect(mocks.tx).toHaveBeenCalledOnce();
    expect(mocks.sessionPush).not.toHaveBeenCalled();
    expect(mocks.todayPush).not.toHaveBeenCalled();
  });

  it('stops preparation if the account changes while currency is being resolved', async () => {
    const preparing = prepareGatewayMediaBilling({ model: 'image' });
    mocks.owner = 'owner-b';
    await expect(preparing).rejects.toThrow('account changed before dispatch');
    expect(mocks.tx).not.toHaveBeenCalled();
  });

  it('ignores failed responses, missing headers and zero cost', async () => {
    for (const res of [response({ cost: 1 }, 500), new Response('{}'), response({ cost: 0 })]) {
      await (
        await prepareGatewayMediaBilling({ model: 'image' })
      )(res);
    }
    expect(mocks.tx).not.toHaveBeenCalled();
  });

  it('does not invent a currency or fail a paid result when persistence fails', async () => {
    mocks.currency = null;
    await (
      await prepareGatewayMediaBilling({ model: 'image' })
    )(response({ cost: 1 }));
    expect(mocks.tx).not.toHaveBeenCalled();
    mocks.currency = 'USD';
    mocks.tx.mockRejectedValue(new Error('database unavailable'));
    await expect(
      (await prepareGatewayMediaBilling({ model: 'image' }))(response({ cost: 1 })),
    ).resolves.toBeUndefined();
    expect(mocks.warn).toHaveBeenCalledWith(
      'Failed to record Gateway media billing',
      'database unavailable',
    );
  });
});
