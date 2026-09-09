// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useModelAccessCreditUsageResult } from '../hooks/useModelAccessCreditUsage';
import { useClaudeAccountUsageResult } from '../hooks/useClaudeAccountUsage';

const state = vi.hoisted(() => ({
  owner: 'credit-a',
  membership: 'personal',
  credit: vi.fn(),
  quota: vi.fn(),
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    dataOwnerId: state.owner,
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

it('uses the enterprise quota API and never returns personal credit for an organization', async () => {
  state.owner = 'quota-org';
  state.membership = 'org';
  state.quota.mockResolvedValue({
    spend: 12,
    maxBudget: 100,
    currency: 'USD',
    todaySpend: 1,
    fetchedAt: 1,
  });
  const view = renderHook(() => ({
    quota: useClaudeAccountUsageResult(true),
    credit: useModelAccessCreditUsageResult(true),
  }));
  await waitFor(() => expect(view.result.current.quota.usage?.currency).toBe('USD'));
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
    expect(request).toHaveBeenCalledTimes(1);
    statusBar.unmount();
    settings.unmount();
    const reopened = renderHook(() => useUsage(true));
    expect(reopened.result.current.usage).not.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    act(() => reopened.result.current.refresh());
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  });
}
