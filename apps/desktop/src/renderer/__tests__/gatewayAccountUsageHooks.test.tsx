// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useModelAccessCreditUsageResult } from '../hooks/useModelAccessCreditUsage';
import { useClaudeAccountUsageResult } from '../hooks/useClaudeAccountUsage';

const state = vi.hoisted(() => ({
  owner: 'credit-a',
  generation: 1,
  membership: 'personal',
  credit: vi.fn(),
  quota: vi.fn(),
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    dataOwnerId: state.owner,
    dataOwnerGeneration: state.generation,
    mode: 'cloud',
    user: { membershipKind: state.membership },
  }),
}));
vi.mock('../features/billing/api', () => ({ billingApi: { getCreditUsage: state.credit } }));
const credit = (available: string) => ({
  available,
  plan: { remaining: '0', used: '0', total: '0' },
  purchased: { remaining: available, used: '0', total: available },
  promotional: { remaining: '0', used: '0', total: '0' },
});
beforeEach(() => {
  state.owner = 'credit-a';
  state.generation = 1;
  state.membership = 'personal';
  state.credit.mockReset();
  state.quota.mockReset();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      maker: { usage: { getAccount: state.quota, onClaudeAccountChanged: () => () => {} } },
    },
  });
});
afterEach(cleanup);

it('settles failed credit loading, retries, and ignores the previous account’s late response', async () => {
  state.credit.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(credit('18'));
  const view = renderHook(() => useModelAccessCreditUsageResult(true));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  expect(view.result.current.usage).toBeNull();
  act(() => view.result.current.refresh());
  await waitFor(() => expect(view.result.current.usage?.available).toBe('18'));
  let complete!: (value: ReturnType<typeof credit>) => void;
  state.credit.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  act(() => view.result.current.refresh());
  state.credit.mockResolvedValueOnce(credit('2'));
  state.owner = 'credit-b';
  view.rerender();
  expect(view.result.current.usage).toBeNull();
  await waitFor(() => expect(view.result.current.usage?.available).toBe('2'));
  await act(async () => complete(credit('999')));
  expect(view.result.current.usage?.available).toBe('2');
});

// Unit: the real quota hook must preserve the optional switch through IPC reads;
// previous coverage had only snapshots without the switch.
it.each([true, false, undefined])('preserves enterprise dailyLimitEnabled=%s without personal credit', async (dailyLimitEnabled) => {
  state.owner = `quota-org-${dailyLimitEnabled}`;
  state.membership = 'org';
  state.quota.mockResolvedValue({
    spend: 12,
    maxBudget: 100,
    currency: 'USD',
    todaySpend: 1,
    ...(dailyLimitEnabled === undefined ? {} : { dailyLimitEnabled }),
    fetchedAt: 1,
  });
  const view = renderHook(() => ({
    quota: useClaudeAccountUsageResult(true),
    credit: useModelAccessCreditUsageResult(true),
  }));
  await waitFor(() => expect(view.result.current.quota.usage?.currency).toBe('USD'));
  expect(view.result.current.quota.usage?.dailyLimitEnabled).toBe(dailyLimitEnabled);
  expect(view.result.current.credit.usage).toBeNull();
  expect(state.credit).not.toHaveBeenCalled();
  act(() => view.result.current.quota.refresh());
  await waitFor(() => expect(state.quota).toHaveBeenCalledTimes(2));
});

for (const kind of ['quota', 'credit'] as const) {
  it(`reuses warm ${kind} data immediately when a mounted settings panel becomes enabled`, async () => {
    state.owner = `warm-${kind}`;
    state.membership = kind === 'quota' ? 'org' : 'personal';
    const request = kind === 'quota' ? state.quota : state.credit;
    request.mockResolvedValue(
      kind === 'quota'
        ? { spend: 12, maxBudget: 100, currency: 'USD', todaySpend: 1, fetchedAt: Date.now() }
        : credit('18'),
    );
    const useUsage =
      kind === 'quota' ? useClaudeAccountUsageResult : useModelAccessCreditUsageResult;
    const settings = renderHook(({ enabled }) => useUsage(enabled), {
      initialProps: { enabled: false },
    });
    const statusBar = renderHook(() => useUsage(true));
    await waitFor(() => expect(statusBar.result.current.usage).not.toBeNull());
    settings.rerender({ enabled: true });
    expect(settings.result.current.usage).toEqual(statusBar.result.current.usage);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(kind === 'quota' ? 2 : 1));
    statusBar.unmount();
    settings.unmount();
    const reopened = renderHook(() => useUsage(true));
    expect(reopened.result.current.usage).not.toBeNull();
    await waitFor(() => expect(request).toHaveBeenCalledTimes(kind === 'quota' ? 3 : 1));
    act(() => reopened.result.current.refresh());
    await waitFor(() => expect(request).toHaveBeenCalledTimes(kind === 'quota' ? 4 : 2));
  });
}


it('clears the mounted and warm quota cache when the main process reports no limit', async () => {
  state.owner = 'quota-unlimited';
  state.membership = 'org';
  let changed!: Parameters<typeof window.electronAPI.maker.usage.onClaudeAccountChanged>[0];
  window.electronAPI.maker.usage.onClaudeAccountChanged = (listener) => {
    changed = listener;
    return () => {};
  };
  state.quota.mockResolvedValue({ spend: 100, maxBudget: 100, currency: 'CNY', todaySpend: null, fetchedAt: 1 });
  const view = renderHook(() => useClaudeAccountUsageResult(true));
  await waitFor(() => expect(view.result.current.usage?.maxBudget).toBe(100));
  state.quota.mockResolvedValue(null);
  act(() => changed(null));
  expect(view.result.current.usage).toBeNull();
  view.unmount();
  const reopened = renderHook(() => useClaudeAccountUsageResult(true));
  expect(reopened.result.current.usage).toBeNull();
  await waitFor(() => expect(reopened.result.current.loading).toBe(false));
});


it('preserves owner-bound warm quota when a refresh has no main snapshot', async () => {
  state.owner = 'quota-unavailable';
  state.membership = 'org';
  state.quota.mockResolvedValue({ spend: 12, maxBudget: 100, currency: 'CNY', todaySpend: null, fetchedAt: 1 });
  const first = renderHook(() => useClaudeAccountUsageResult(true));
  await waitFor(() => expect(first.result.current.usage?.spend).toBe(12));
  first.unmount();
  // No active listener while main switches accounts; returning to this owner
  // can yield null after a failed request, without invalidating its warm data.
  state.quota.mockResolvedValue(null);
  const reopened = renderHook(() => useClaudeAccountUsageResult(true));
  act(() => reopened.result.current.refresh());
  await waitFor(() => expect(state.quota).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(reopened.result.current.loading).toBe(false));
  expect(reopened.result.current.usage?.spend).toBe(12);
  reopened.unmount();
  const finalView = renderHook(() => useClaudeAccountUsageResult(true));
  await waitFor(() => expect(finalView.result.current.loading).toBe(false));
  expect(finalView.result.current.usage?.spend).toBe(12);
});

it.each(['unlimited', 'invalidated'])('replays an authoritative %s read after the clear push was missed while unmounted', async (quotaState) => {
  state.owner = `quota-missed-clear-${quotaState}`;
  state.membership = 'org';
  state.quota.mockResolvedValue({ spend: 12, maxBudget: 100, currency: 'CNY', todaySpend: null, fetchedAt: 1 });
  const first = renderHook(() => useClaudeAccountUsageResult(true));
  await waitFor(() => expect(first.result.current.usage?.spend).toBe(12));
  first.unmount();
  state.quota.mockResolvedValue({ quotaState });
  const reopened = renderHook(() => useClaudeAccountUsageResult(true));
  await waitFor(() => expect(reopened.result.current.loading).toBe(false));
  expect(reopened.result.current.usage).toBeNull();
});


it('preserves unlimited state, invalidates it on gateway change, and isolates accounts', async () => {
  state.owner = 'unlimited-transitions';
  state.membership = 'org';
  let changed!: Parameters<typeof window.electronAPI.maker.usage.onClaudeAccountChanged>[0];
  window.electronAPI.maker.usage.onClaudeAccountChanged = listener => {
    changed = listener;
    return () => {};
  };
  state.quota.mockResolvedValue({ quotaState: 'unlimited' });
  const view = renderHook(() => useClaudeAccountUsageResult(true));
  await waitFor(() => expect(view.result.current.unlimited).toBe(true));
  expect(view.result.current.usage).toBeNull();
  state.quota.mockResolvedValue(null);
  act(() => view.result.current.refresh());
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  expect(view.result.current.unlimited).toBe(true);
  state.quota.mockResolvedValue({ quotaState: 'invalidated' });
  act(() => changed(null));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  expect(view.result.current.unlimited).toBe(false);
  state.quota.mockResolvedValue({ quotaState: 'unlimited' });
  act(() => changed(null));
  await waitFor(() => expect(view.result.current.unlimited).toBe(true));
  const finite = { spend: 1, maxBudget: 100, currency: 'CNY' as const, todaySpend: null, fetchedAt: 1 };
  act(() => changed(finite));
  expect(view.result.current.unlimited).toBe(false);
  expect(view.result.current.usage).toEqual(finite);
  state.owner = 'another-unlimited-owner';
  state.quota.mockResolvedValue(null);
  view.rerender();
  expect(view.result.current.usage).toBeNull();
  expect(view.result.current.unlimited).toBe(false);
  await waitFor(() => expect(view.result.current.loading).toBe(false));
});


it('does not loop when the quota read itself broadcasts an unlimited clear', async () => {
  state.owner = 'unlimited-push-during-read';
  state.membership = 'org';
  let changed: Parameters<typeof window.electronAPI.maker.usage.onClaudeAccountChanged>[0] | undefined;
  window.electronAPI.maker.usage.onClaudeAccountChanged = listener => {
    changed = listener;
    return () => {};
  };
  state.quota.mockImplementation(async () => {
    await Promise.resolve();
    changed?.(null);
    return { quotaState: 'unlimited' };
  });
  const view = renderHook(() => useClaudeAccountUsageResult(true));
  await waitFor(() => expect(view.result.current.unlimited).toBe(true));
  expect(state.quota).toHaveBeenCalledTimes(1);
  act(() => changed?.(null));
  await waitFor(() => expect(view.result.current.unlimited).toBe(true));
  expect(state.quota).toHaveBeenCalledTimes(2);
});


it('coalesces unlimited reads across two mounted panes without ping-pong refreshes', async () => {
  state.owner = 'two-unlimited-panes';
  state.membership = 'org';
  const listeners = new Set<Parameters<typeof window.electronAPI.maker.usage.onClaudeAccountChanged>[0]>();
  window.electronAPI.maker.usage.onClaudeAccountChanged = listener => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  let resolveRead!: (value: unknown) => void;
  state.quota.mockImplementation(() => new Promise(resolve => { resolveRead = resolve; }));
  const first = renderHook(() => useClaudeAccountUsageResult(true));
  await waitFor(() => expect(state.quota).toHaveBeenCalledTimes(1));
  await act(async () => { resolveRead({ quotaState: 'unlimited' }); });
  const second = renderHook(() => useClaudeAccountUsageResult(true));
  await waitFor(() => expect(state.quota).toHaveBeenCalledTimes(2));
  act(() => { for (const listener of listeners) listener(null); });
  await act(async () => { resolveRead({ quotaState: 'unlimited' }); });
  await waitFor(() => expect(first.result.current.unlimited && second.result.current.unlimited).toBe(true));
  expect(state.quota).toHaveBeenCalledTimes(2);
  act(() => { for (const listener of listeners) listener(null); });
  await waitFor(() => expect(state.quota).toHaveBeenCalledTimes(3));
  act(() => { for (const listener of listeners) listener(null); });
  await act(async () => { resolveRead({ quotaState: 'unlimited' }); });
  expect(first.result.current.unlimited && second.result.current.unlimited).toBe(true);
  expect(state.quota).toHaveBeenCalledTimes(3);
});

// Unit regression: projection repair keeps the account ID but advances its generation.
// Existing account-switch tests cannot detect stale unlimited state for the same account.
it('invalidates unlimited immediately when the same owner generation changes', async () => {
  state.owner = 'generation-repair';
  state.membership = 'org';
  state.quota.mockResolvedValueOnce({ quotaState: 'unlimited' });
  const view = renderHook(() => useClaudeAccountUsageResult(true));
  await waitFor(() => expect(view.result.current.unlimited).toBe(true));
  state.quota.mockResolvedValueOnce({ spend: 12, maxBudget: 100, currency: 'CNY', todaySpend: null, fetchedAt: 1 });
  state.generation += 1;
  view.rerender();
  expect(view.result.current.unlimited).toBe(false);
  await waitFor(() => expect(view.result.current.usage?.maxBudget).toBe(100));
  expect(state.quota).toHaveBeenCalledTimes(2);
});
