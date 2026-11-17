// @vitest-environment jsdom

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_APPEARANCE_SETTINGS,
  normalizeAppearanceSettings,
  type AppearanceSettings,
} from '../../../../shared/appearanceSettings';
import { createOverrideSettingsFile } from '../../../../main/maker-host/override-settings-file';
import { withCrossProcessLock } from '../../../../main/device-link/crossProcessLock';
import { DockIconPicker } from '../DockIconPicker';

const h = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useFontSettings', () => ({
  getInitialAppearanceSettings: () => DEFAULT_APPEARANCE_SETTINGS,
}));
vi.mock('@/components/markdown/useIsDarkMode', () => ({ useIsDarkMode: () => false }));
vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/lib/toast', () => ({ toast: { error: h.error } }));
vi.mock('../../../../main/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));

// Production entry/result: real DockIconPicker clicks -> appearance save bridge,
// including the actual override store and file lock in the contention regression.
// PR #9139: an older lock retry can overtake a newer choice; existing font and
// wallpaper tests do not exercise Dock saves. Minimal input: cat then mark while
// a different writer holds the lock. Standard unit, fake retry timers, no network.
// Standalone measurement: 659 ms for four cases on the development machine.
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const originalApi = window.electronAPI;
let emit: ((settings: AppearanceSettings) => void) | undefined;
function mount(setPatch: (patch: Partial<AppearanceSettings>) => Promise<AppearanceSettings>) {
  window.electronAPI = {
    appearanceSettings: {
      setPatch,
      onChanged: (callback: typeof emit) => {
        emit = callback;
        return () => {
          emit = undefined;
        };
      },
    },
  } as unknown as typeof window.electronAPI;
  render(<DockIconPicker />);
}
function choose(icon: string) {
  fireEvent.click(
    screen.getByRole('radio', { name: 'settings.appearance.appIcon.options.' + icon }),
  );
}
function selected(icon: string) {
  expect(
    screen
      .getByRole('radio', { name: 'settings.appearance.appIcon.options.' + icon })
      .getAttribute('aria-checked'),
  ).toBe('true');
}
function snapshot(appIcon: AppearanceSettings['appIcon']): AppearanceSettings {
  return { ...DEFAULT_APPEARANCE_SETTINGS, appIcon };
}
afterEach(() => {
  cleanup();
  window.electronAPI = originalApi;
  emit = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
  h.error.mockClear();
});

describe('Dock icon saves', () => {
  it('persists the last choice when an older request is waiting on the real file lock', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-dock-save-'));
    const file = path.join(dir, 'appearance-settings.json');
    const store = createOverrideSettingsFile({
      filePath: () => file,
      defaults: DEFAULT_APPEARANCE_SETTINGS,
      normalize: normalizeAppearanceSettings,
      label: 'dock-test',
      log: { info: vi.fn(), warn: vi.fn() },
    });
    const held = deferred();
    const release = deferred();
    const retry = deferred();
    const finalSave = deferred();
    const completed: string[] = [];
    const holder = withCrossProcessLock(
      file + '.lock',
      { label: 'other-appearance-write' },
      async (lease) => {
        expect(lease.held).toBe(true);
        held.resolve();
        await release.promise;
      },
    );
    await held.promise;
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const timer = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      if (delay === 40) retry.resolve();
      return timer(callback, delay, ...args);
    });
    const save = vi.fn(async (patch: Partial<AppearanceSettings>) => {
      await store.writePatchAtomic(patch);
      const next = store.read();
      act(() => emit?.(next));
      completed.push(patch.appIcon!);
      if (patch.appIcon === 'mark') finalSave.resolve();
      return next;
    });
    try {
      mount(save);
      choose('cat');
      await retry.promise;
      release.resolve();
      await holder;
      choose('mark');
      // If the UI starts a concurrent save, let it acquire the now-free lock
      // before advancing the older retry, reproducing the observed overtaking.
      if (save.mock.results.length > 1) await save.mock.results[1].value;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(40);
        await save.mock.results[0].value;
        await finalSave.promise;
      });
      expect(completed).toEqual(['cat', 'mark']);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).appIcon).toBe('mark');
      selected('mark');
    } finally {
      release.resolve();
      await holder;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the latest optimistic choice during older broadcasts and continues after a failed save', async () => {
    const first = deferred<AppearanceSettings>();
    const second = deferred<AppearanceSettings>();
    const save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    mount(save);
    choose('cat');
    choose('mark');
    await act(async () => {
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(1);
    act(() => emit?.(snapshot('wordmark')));
    selected('mark');
    await act(async () => {
      first.reject(new Error('disk failure'));
    });
    expect(save).toHaveBeenCalledTimes(2);
    selected('mark');
    expect(h.error).toHaveBeenCalledOnce();
    await act(async () => {
      emit?.(snapshot('mark'));
      second.resolve(snapshot('mark'));
    });
    selected('mark');
  });

  it('rolls back a failed latest save to the last confirmed icon, not a failed earlier selection', async () => {
    const first = deferred<AppearanceSettings>();
    const second = deferred<AppearanceSettings>();
    mount(vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));
    choose('cat');
    choose('mark');
    await act(async () => {
      first.reject(new Error('disk failure'));
    });
    await act(async () => {
      second.reject(new Error('disk failure'));
    });
    selected('default');
    expect(h.error).toHaveBeenCalledTimes(2);
  });

  it('uses the newest choice for rapid keyboard steps and confirms saves without a broadcast', async () => {
    const first = deferred<AppearanceSettings>();
    const second = deferred<AppearanceSettings>();
    const save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    mount(save);
    const button = screen.getByRole('radio', {
      name: 'settings.appearance.appIcon.options.default',
    });
    act(() => {
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    selected('wordmark');
    await act(async () => {
      first.resolve(snapshot('cat'));
    });
    expect(save.mock.calls.map(([patch]) => patch.appIcon)).toEqual(['cat', 'wordmark']);
    selected('wordmark');
    await act(async () => {
      second.reject(new Error('disk failure'));
    });
    selected('cat');
  });
});
