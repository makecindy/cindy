// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PluginUsageCard } from '../PluginUsageCard';
import { PluginSharedUsage } from '../PluginSharedUsage';
import type { PluginUsageSummary } from '../../../../shared/pluginUsage';
import type { PluginMarketItem } from '../../../../shared/pluginMarket';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { value?: string }) =>
      options?.value !== undefined ? `${options.value} ${key}` : key,
    i18n: { language: 'en' },
  }),
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const summary: PluginUsageSummary = {
  subjectId: 'subject1',
  recordingStartedAt: 1,
  lastUsedAt: 2,
  callsLast7Days: 7,
  totalCalls: 8,
  until: 3,
  deviceName: 'Mac',
  recentTasks: [{ sessionId: 'task1', title: 'Current title', lastUsedAt: 2 }],
};
function api(load = vi.fn(async () => summary)) {
  const clear = vi.fn(async () => {});
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { ghosts: { usageSummary: load, clearUsage: clear } },
  });
  return { load, clear };
}
it('updates recent and rolling usage while the detail remains mounted', async () => {
  vi.useFakeTimers();
  const next = { ...summary, lastUsedAt: Date.UTC(2026, 9, 14, 12), callsLast7Days: 8 };
  const { load } = api(vi.fn().mockResolvedValueOnce(summary).mockResolvedValue(next));
  const view = render(<PluginUsageCard ghostId="plugin" />);
  await act(async () => {});
  const recent = view.container.querySelector('dd')!.textContent;
  expect(screen.getByText('7')).toBeTruthy();
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(screen.getByText('8')).toBeTruthy();
  expect(view.container.querySelector('dd')!.textContent).not.toBe(recent);
  expect(load).toHaveBeenCalledTimes(2);
  view.unmount();
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(load).toHaveBeenCalledTimes(2);
});
it('pauses automatic reads while hidden and refreshes when visible again', async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const { load } = api();
  render(<PluginUsageCard ghostId="plugin" />);
  await act(async () => {});
  visibility.mockReturnValue('hidden');
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(load).toHaveBeenCalledTimes(1);
  visibility.mockReturnValue('visible');
  await act(async () => fireEvent(document, new Event('visibilitychange')));
  expect(load).toHaveBeenCalledTimes(2);
});
it('does not overlap polling or commit a response from a previous plugin', async () => {
  vi.useFakeTimers();
  let complete!: (value: PluginUsageSummary) => void;
  const pending = new Promise<PluginUsageSummary>((resolve) => { complete = resolve; });
  const { load } = api(vi.fn().mockResolvedValueOnce(summary).mockReturnValueOnce(pending)
    .mockResolvedValue({ ...summary, callsLast7Days: 9 }));
  const view = render(<PluginUsageCard ghostId="first" />);
  await act(async () => {});
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(load).toHaveBeenCalledTimes(2);
  view.rerender(<PluginUsageCard ghostId="second" />);
  await act(async () => {});
  expect(screen.getByText('9')).toBeTruthy();
  await act(async () => complete({ ...summary, callsLast7Days: 8 }));
  expect(screen.queryByText('8')).toBeNull();
  expect(screen.getByText('9')).toBeTruthy();
});
it('holds automatic reads during clear confirmation and ignores a pre-clear response', async () => {
  vi.useFakeTimers();
  let complete!: (value: PluginUsageSummary) => void;
  let confirm!: (value: boolean) => void;
  const pending = new Promise<PluginUsageSummary>((resolve) => { complete = resolve; });
  const { load, clear } = api(vi.fn().mockResolvedValueOnce(summary).mockReturnValueOnce(pending)
    .mockResolvedValue({ ...summary, lastUsedAt: null, callsLast7Days: 0 }));
  render(<PluginUsageCard ghostId="plugin" confirmClear={() => new Promise(resolve => { confirm = resolve; })} />);
  await act(async () => {});
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.usage.clear' }));
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => confirm(true));
  expect(clear).toHaveBeenCalledWith('subject1');
  expect(screen.getByText('0')).toBeTruthy();
  await act(async () => complete(summary));
  expect(screen.queryByText('7')).toBeNull();
});
it('shows two personal metrics with a direct clear action after confirmation', async () => {
  const { load, clear } = api();
  const confirm = vi.fn(async () => true);
  render(<PluginUsageCard ghostId="plugin" confirmClear={confirm} />);
  await screen.findByText('7');
  expect(screen.queryByText('Current title')).toBeNull();
  expect(screen.queryByText('settings.ghosts.usage.tasks')).toBeNull();
  expect(screen.queryByRole('menuitem')).toBeNull();
  expect(screen.queryByRole('button', { name: 'settings.ghosts.usage.more' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.usage.clear' }));
  await waitFor(() => expect(clear).toHaveBeenCalledWith('subject1'));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
});
it('cancelled confirmation never deletes records', async () => {
  const { clear } = api();
  render(<PluginUsageCard ghostId="plugin" confirmClear={async () => false} />);
  await screen.findByText('7');
  fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.usage.clear' }));
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'settings.ghosts.usage.clear' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  expect(clear).not.toHaveBeenCalled();
});
it('distinguishes unavailable from actual zero with no invented usage', async () => {
  api(vi.fn().mockRejectedValue(new Error('unavailable')));
  const view = render(<PluginUsageCard ghostId="plugin" />);
  await screen.findByText('settings.ghosts.usage.unavailable');
  expect(screen.queryByText('0')).toBeNull();
  view.unmount();
  api(
    vi.fn(async () => ({
      ...summary,
      lastUsedAt: null,
      callsLast7Days: 0,
      totalCalls: 0,
      recentTasks: [],
    })),
  );
  render(<PluginUsageCard ghostId="plugin" />);
  await screen.findByText('settings.ghosts.usage.never');
  expect(screen.getByText('0')).toBeTruthy();
});
it('does not dispatch a clear while confirmation is pending', async () => {
  const { clear } = api();
  let answer!: (confirmed: boolean) => void;
  const confirm = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
  );
  render(<PluginUsageCard ghostId="plugin" confirmClear={confirm} />);
  await screen.findByText('7');
  const button = screen.getByRole('button', { name: 'settings.ghosts.usage.clear' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(clear).not.toHaveBeenCalled();
  answer(false);
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  expect(clear).not.toHaveBeenCalled();
});

const shared = {
  sourceType: 'server',
  scope: 'public',
  downloadStatistics: { requestCount: '12' },
  usageStatistics: { usageCount: '10', usageCountLast7Days: '5', asOf: '2026-10-13T00:00:00Z' },
} as PluginMarketItem;

it('hides absent metrics independently without inventing zero', () => {
  const view = render(
    <PluginSharedUsage
      detail={{ ...shared, downloadStatistics: undefined, usageStatistics: undefined }}
    />,
  );
  expect(view.container.textContent).toBe('');
  view.rerender(
    <PluginSharedUsage
      detail={{
        ...shared,
        downloadStatistics: undefined,
        usageStatistics: { usageCountLast7Days: '5', asOf: '2026-10-13T00:00:00Z' },
      }}
    />,
  );
  expect(view.container.textContent).toBe('');
  view.rerender(<PluginSharedUsage detail={{ ...shared, downloadStatistics: undefined }} />);
  expect(screen.getByText('10 settings.ghosts.usage.usesValue')).toBeTruthy();
  expect(view.container.textContent).not.toContain('downloadsValue');
  view.rerender(<PluginSharedUsage detail={{ ...shared, usageStatistics: undefined }} />);
  expect(screen.getByText('12 settings.ghosts.usage.downloadsValue')).toBeTruthy();
  expect(view.container.textContent).not.toContain('usesValue');
  expect(view.container.textContent?.match(/·/g)).toHaveLength(1);
});

it.each([
  ['git-market', 'public'],
  ['local-market', 'public'],
  ['server', 'personal'],
])('hides aggregates outside the authorized scope (%s, %s)', (sourceType, scope) => {
  const view = render(
    <PluginSharedUsage detail={{ ...shared, sourceType, scope } as PluginMarketItem} />,
  );
  expect(view.container.textContent).toBe('');
});

it.each(['public', 'organization'] as const)(
  'shows exact cumulative shared metrics in %s',
  (scope) => {
    const view = render(<PluginSharedUsage detail={{ ...shared, scope }} />);
    expect(screen.getByText('12 settings.ghosts.usage.downloadsValue')).toBeTruthy();
    expect(screen.getByText('10 settings.ghosts.usage.usesValue')).toBeTruthy();
    expect(view.container.textContent).not.toContain('last7Days');
    expect(view.container.textContent).not.toContain('installs');
    for (const count of ['0', '18446744073709551615']) {
      view.rerender(
        <PluginSharedUsage
          detail={{
            ...shared,
            scope,
            downloadStatistics: { requestCount: count },
            usageStatistics: { ...shared.usageStatistics!, usageCount: count },
          }}
        />,
      );
      const formatted = BigInt(count).toLocaleString('en');
      expect(screen.getByText(`${formatted} settings.ghosts.usage.downloadsValue`)).toBeTruthy();
      expect(screen.getByText(`${formatted} settings.ghosts.usage.usesValue`)).toBeTruthy();
    }
  },
);

it('shows download-only list metadata inside a card without nesting a button', () => {
  const view = render(
    <button type="button">
      <PluginSharedUsage detail={shared} variant="list" />
    </button>,
  );
  expect(screen.getByText('12 settings.ghosts.usage.downloadsValue')).toBeTruthy();
  expect(view.container.textContent).not.toContain('usesValue');
  expect(view.container.querySelectorAll('button')).toHaveLength(1);
  expect(view.container.querySelector('[tabindex]')).toBeNull();
});
