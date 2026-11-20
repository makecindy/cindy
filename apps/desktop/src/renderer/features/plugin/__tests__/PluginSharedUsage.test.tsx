// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PluginSharedUsage } from '../PluginSharedUsage';
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
  expect(screen.getByText('12')).toBeTruthy();
  expect(view.container.textContent).not.toContain('usesValue');
  expect(view.container.querySelectorAll('button')).toHaveLength(1);
  expect(view.container.querySelector('[tabindex]')).toBeNull();
});

it.each([
  ['0', '0'],
  ['999', '999'],
  ['1000', '1k'],
  ['12480', '12.4k'],
  ['999999', '999.9k'],
  ['1000000', '1M'],
  ['1280000', '1.2M'],
  ['9007199254740993', '9007199254.7M'],
])('shortens list downloads %s to %s while retaining the exact count', (count, expected) => {
  render(<PluginSharedUsage detail={{ ...shared, downloadStatistics: { requestCount: count } }} variant="list" />);
  const metric = screen.getByRole('group', {
    name: `${BigInt(count).toLocaleString('en')} settings.ghosts.usage.downloadsValue`,
  });
  expect(metric.textContent).toBe(expected);
});

it('shows the exact download count on hover', async () => {
  render(<PluginSharedUsage detail={{ ...shared, downloadStatistics: { requestCount: '12480' } }} variant="list" />);
  fireEvent.pointerMove(screen.getByRole('group'), { pointerType: 'mouse' });
  expect((await screen.findByRole('tooltip')).textContent).toBe('12,480 settings.ghosts.usage.downloadsValue');
});
