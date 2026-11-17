// Mac desktop widgets: the app holds the quota overview only while a widget is on the desktop,
// writes what the extension reads and spends WidgetKit's daily reload budget only on changes
// (plus an occasional refresh so a current reading never looks stale).
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MobileUsageWidgetSnapshot } from '@cindy/maker-shared/device-link-contract';

vi.mock('electron', () => ({ app: { isPackaged: true, getAppPath: () => '/app' } }));

import {
  DESKTOP_WIDGETS_FRESHNESS_RELOAD_MS,
  DESKTOP_WIDGETS_MIN_RELOAD_MS,
  DESKTOP_WIDGETS_POLL_MS,
  DesktopWidgets,
  type DesktopWidgetStore,
} from '../desktopWidgets';
import type { QuotaOverviewBuild } from '../service';

function snapshotWith(value: string): MobileUsageWidgetSnapshot {
  return {
    version: 1, generatedAtMs: Date.now(), updatedAtMs: Date.now(), locale: 'en', moneySymbol: '$',
    sources: [{
      id: 'codex', kind: 'subscription', name: 'Codex', logo: 'codex', monogram: 'C', value, unit: '%', label: null,
      level: 'normal', fill: 0.5, reserve: false, emphasized: false, when: `${Date.now()}`, resetsAtMs: null,
    }],
    usage: { scope: 'all', days: [], daily: [] }, strings: {},
  } as MobileUsageWidgetSnapshot;
}

function harness() {
  let listener: ((build: QuotaOverviewBuild) => void) | null = null;
  let widgets: number | null = 0;
  let next: MobileUsageWidgetSnapshot | null = snapshotWith('50');
  const reloads: number[] = [];
  const files = new Map<string, string>();
  const release = vi.fn(() => { listener = null; });
  const acquire = vi.fn(() => release);
  const controller = new DesktopWidgets({
    overview: {
      subscribe: (changed) => { listener = changed; return () => { listener = null; }; },
      acquire,
      latest: () => null,
    },
    native: {
      apply: (json) => {
        const { action } = JSON.parse(json) as { action: string };
        if (action === 'reload') reloads.push(Date.now());
        return JSON.stringify({ ok: true, dataPath: 'Library/x', widgets });
      },
    },
    dataDir: '/home/Library/x',
    snapshot: () => next,
    deviceName: () => 'Studio',
    write: (file, contents) => files.set(file, contents),
    now: Date.now,
  });
  return {
    controller, acquire, release, reloads,
    setWidgets: (count: number | null) => { widgets = count; },
    build: (snapshot: MobileUsageWidgetSnapshot | null) => {
      next = snapshot;
      listener?.({ stale: false } as QuotaOverviewBuild);
    },
    store: () => JSON.parse(files.get('/home/Library/x/usage-widget-snapshot.json') ?? 'null') as DesktopWidgetStore | null,
  };
}

beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
afterEach(() => vi.useRealTimers());

it('collects only while a widget is on the desktop and keeps an unknown answer as it was', () => {
  const h = harness();
  h.controller.start();
  expect(h.acquire).not.toHaveBeenCalled();

  h.setWidgets(1);
  vi.advanceTimersByTime(DESKTOP_WIDGETS_POLL_MS);
  expect(h.acquire).toHaveBeenCalledTimes(1);

  h.setWidgets(null);
  vi.advanceTimersByTime(DESKTOP_WIDGETS_POLL_MS);
  expect(h.release).not.toHaveBeenCalled();

  h.setWidgets(0);
  vi.advanceTimersByTime(DESKTOP_WIDGETS_POLL_MS);
  expect(h.release).toHaveBeenCalledTimes(1);
  h.controller.stop();
});

it('writes every build, reloads changes at most every few minutes and an unchanged reading before it looks stale', () => {
  const h = harness();
  h.setWidgets(1);
  h.controller.start();

  h.build(snapshotWith('50'));
  expect(h.store()?.states.local?.snapshot.sources[0]?.value).toBe('50');
  expect(h.reloads).toHaveLength(1);

  // A newer build with the same reading (only times renewed) writes but does not reload.
  vi.advanceTimersByTime(60_000);
  h.build(snapshotWith('50'));
  expect(h.reloads).toHaveLength(1);

  // Two changes inside the window: one trailing reload, which shows the last one.
  h.build(snapshotWith('48'));
  h.build(snapshotWith('47'));
  expect(h.reloads).toHaveLength(1);
  vi.advanceTimersByTime(DESKTOP_WIDGETS_MIN_RELOAD_MS);
  expect(h.reloads).toHaveLength(2);
  expect(h.store()?.states.local?.snapshot.sources[0]?.value).toBe('47');

  vi.advanceTimersByTime(DESKTOP_WIDGETS_FRESHNESS_RELOAD_MS);
  h.build(snapshotWith('47'));
  expect(h.reloads).toHaveLength(3);

  // Signed out: the widget is left with nothing to show rather than the previous account's quota.
  h.build(null);
  expect(h.store()?.states).toEqual({});
  h.controller.stop();
});
