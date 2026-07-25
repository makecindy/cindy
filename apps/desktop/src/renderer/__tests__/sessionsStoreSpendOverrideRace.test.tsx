// @vitest-environment jsdom

/**
 * sessionsStore 费用 override 竞态:CN 构建的 usage:session-spend-changed 推送
 * 只带结构化 totalMoney(无 totalCostUsd)。列表请求启动后到达的推送必须进
 * override 重放,否则先发后至的 sessions:list 会用旧值覆盖新费用。
 */

import type { Session } from '@/lib/ccAgent.types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SpendPayload = {
  sessionId: string;
  totalMoney?: Session['totalMoney'];
  totalCostUsd?: number;
};

const mocks = vi.hoisted(() => {
  let spendListener: ((payload: SpendPayload) => void) | undefined;
  const onUsageSessionSpendChanged = vi.fn(
    (listener: (payload: SpendPayload) => void) => {
      spendListener = listener;
      return vi.fn();
    },
  );
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { onUsageSessionSpendChanged },
  });
  return {
    list: vi.fn(),
    emitSessionSpend(payload: SpendPayload): void {
      spendListener?.(payload);
    },
  };
});

vi.mock('@/lib/sessionService', () => ({
  list: mocks.list,
  create: vi.fn(),
}));

import { sessionsStore } from '@/lib/sessionsStore';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function session(id: string, partial: Partial<Session> = {}): Session {
  return { id, ...partial } as Session;
}

function cny(amount: number): NonNullable<Session['totalMoney']> {
  return { amount, currency: 'CNY', approximate: true, kind: 'actual-cost' };
}

describe('sessionsStore spend override race', () => {
  beforeEach(() => {
    mocks.list.mockReset();
    sessionsStore.reset();
  });

  afterEach(() => {
    sessionsStore.reset();
  });

  it('replays a structured totalMoney push over a stale in-flight list', async () => {
    const initial = deferred<Session[]>();
    const refresh = deferred<Session[]>();
    mocks.list
      .mockImplementationOnce(() => initial.promise)
      .mockImplementationOnce(() => refresh.promise);

    const firstLoad = sessionsStore.ensureByFilter('active');
    initial.resolve([session('s1', { totalCostUsd: 0, totalMoney: cny(1) })]);
    await firstLoad;

    const reload = sessionsStore.forceRefresh('active');
    // 列表请求已发出、尚未返回:CN 推送只带 totalMoney。
    mocks.emitSessionSpend({ sessionId: 's1', totalMoney: cny(2) });
    refresh.resolve([session('s1', { totalCostUsd: 0, totalMoney: cny(1) })]);
    await reload;

    expect(
      sessionsStore.getByFilter('active')?.[0]?.totalMoney?.amount,
    ).toBe(2);
  });

  it('still replays legacy totalCostUsd pushes alongside totalMoney', async () => {
    const initial = deferred<Session[]>();
    const refresh = deferred<Session[]>();
    mocks.list
      .mockImplementationOnce(() => initial.promise)
      .mockImplementationOnce(() => refresh.promise);

    const firstLoad = sessionsStore.ensureByFilter('active');
    initial.resolve([session('s1', { totalCostUsd: 1 })]);
    await firstLoad;

    const reload = sessionsStore.forceRefresh('active');
    mocks.emitSessionSpend({ sessionId: 's1', totalCostUsd: 3 });
    refresh.resolve([session('s1', { totalCostUsd: 1 })]);
    await reload;

    expect(sessionsStore.getByFilter('active')?.[0]?.totalCostUsd).toBe(3);
  });
});
