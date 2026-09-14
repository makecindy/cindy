// @vitest-environment jsdom

/**
 * useUpdateNotice().onOpenVersion —— UpdateBanner 的「装前预览」入口。
 *
 * 契约:聚合 `(已装版本, 待装版本]` 这个区间 —— 跨了几版就显示几块,普通单版本升级就一块;
 * 不带已装版本本身,也不带它之前的历史(那是火焰按钮的活)。复用 auto 的布局契约(整段预加载、
 * 无懒加载历史、无版本跳转器),但 dismiss 不推进 lastReadVersion —— 否则重启装完后真正的
 * 自动公告就再也不弹了。
 *
 * 同时钉住:火焰按钮的完整历史路径不受本次改动影响。
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useUpdateNotice } from '@/hooks/useUpdateNotice';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const localeState = vi.hoisted(() => ({ current: 'en' as 'zh-CN' | 'en' | 'ja' | 'ko' }));
vi.mock('@/hooks/useLocale', () => ({
  useLocale: () => ({
    locale: localeState.current,
    effectiveLocale: localeState.current,
    setLocale: vi.fn(),
  }),
}));

const mocks = vi.hoisted(() => ({
  fetchReleaseNotes: vi.fn(),
  fetchReleaseNotesIndex: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/release-notes', () => ({
  fetchReleaseNotes: mocks.fetchReleaseNotes,
  fetchReleaseNotesIndex: mocks.fetchReleaseNotesIndex,
}));

vi.mock('@/lib/toast', () => ({ toast: { error: mocks.toastError } }));

const STORAGE_KEY = 'xdt-maker:lastReadVersion';

function notesFor(version: string, locale = 'en') {
  return {
    version,
    date: '2026-07-28',
    contributors: [],
    sections: [],
    topics: [{ title: `${locale}-${version}`, text: 'x', contributors: [] }],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

/** 设定「已装版本」,并让自动弹窗路径静默(lastRead === appVersion 时 effect 直接 return)。 */
function setInstalled(version: string) {
  (window as unknown as { electronAPI: unknown }).electronAPI = { appVersion: version };
  localStorage.setItem(STORAGE_KEY, version);
}

beforeEach(() => {
  localeState.current = 'en';
  localStorage.clear();
  mocks.fetchReleaseNotes.mockReset();
  mocks.fetchReleaseNotesIndex.mockReset();
  mocks.toastError.mockReset();
  mocks.fetchReleaseNotesIndex.mockResolvedValue(['1.3.9', '1.4.0', '1.4.1', '1.4.2']);
  mocks.fetchReleaseNotes.mockImplementation(async (v: string, locale: string) =>
    notesFor(v, locale));
  setInstalled('1.4.1');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useUpdateNotice onOpenVersion — pre-install preview', () => {
  it('shows one block for a plain one-version bump', async () => {
    const { result } = renderHook(() => useUpdateNotice());

    act(() => { result.current.onOpenVersion('1.4.2'); });

    await waitFor(() => expect(result.current.open).toBe(true));
    expect(result.current.mode).toBe('auto');
    expect(result.current.releaseNotes?.map((n) => n.version)).toEqual(['1.4.2']);
    // auto 布局契约:没有懒加载历史列表,也就没有版本跳转器。
    expect(result.current.allVersions).toBeNull();
  });

  it('aggregates every version the restart jumps over, newest first', async () => {
    setInstalled('1.3.9');
    const { result } = renderHook(() => useUpdateNotice());

    act(() => { result.current.onOpenVersion('1.4.2'); });

    await waitFor(() => expect(result.current.open).toBe(true));
    expect(result.current.releaseNotes?.map((n) => n.version)).toEqual([
      '1.4.2', '1.4.1', '1.4.0',
    ]);
  });

  it('excludes the installed version and everything older than it', async () => {
    setInstalled('1.4.0');
    const { result } = renderHook(() => useUpdateNotice());

    act(() => { result.current.onOpenVersion('1.4.2'); });

    await waitFor(() => expect(result.current.open).toBe(true));
    const shown = result.current.releaseNotes?.map((n) => n.version) ?? [];
    expect(shown).toEqual(['1.4.2', '1.4.1']);
    expect(shown).not.toContain('1.4.0');
    expect(shown).not.toContain('1.3.9');
    expect(mocks.fetchReleaseNotes).not.toHaveBeenCalledWith('1.3.9', 'en');
  });

  it('caps the aggregated range at 5 versions', async () => {
    setInstalled('1.0.0');
    mocks.fetchReleaseNotesIndex.mockResolvedValue(
      Array.from({ length: 9 }, (_, i) => `1.1.${i + 1}`),
    );
    const { result } = renderHook(() => useUpdateNotice());

    act(() => { result.current.onOpenVersion('1.1.9'); });

    await waitFor(() => expect(result.current.open).toBe(true));
    expect(result.current.releaseNotes?.map((n) => n.version)).toEqual([
      '1.1.9', '1.1.8', '1.1.7', '1.1.6', '1.1.5',
    ]);
  });

  it('drops an in-between version whose notes are missing, keeps the rest', async () => {
    setInstalled('1.3.9');
    mocks.fetchReleaseNotes.mockImplementation(async (v: string, locale: string) =>
      (v === '1.4.1' ? null : notesFor(v, locale)));
    const { result } = renderHook(() => useUpdateNotice());

    act(() => { result.current.onOpenVersion('1.4.2'); });

    await waitFor(() => expect(result.current.open).toBe(true));
    expect(result.current.releaseNotes?.map((n) => n.version)).toEqual(['1.4.2', '1.4.0']);
  });

  it('falls back to the pending version alone when the index is unreachable', async () => {
    setInstalled('1.3.9');
    mocks.fetchReleaseNotesIndex.mockResolvedValue(null);
    const { result } = renderHook(() => useUpdateNotice());

    act(() => { result.current.onOpenVersion('1.4.2'); });

    await waitFor(() => expect(result.current.open).toBe(true));
    expect(result.current.releaseNotes?.map((n) => n.version)).toEqual(['1.4.2']);
  });

  it('includes the pending version even when the CDN index lags behind it', async () => {
    mocks.fetchReleaseNotesIndex.mockResolvedValue(['1.3.9', '1.4.0', '1.4.1']);
    const { result } = renderHook(() => useUpdateNotice());

    act(() => { result.current.onOpenVersion('1.4.2'); });

    await waitFor(() => expect(result.current.open).toBe(true));
    expect(result.current.releaseNotes?.map((n) => n.version)).toEqual(['1.4.2']);
  });

  it('stays closed and toasts when the pending version itself has no notes', async () => {
    setInstalled('1.3.9');
    mocks.fetchReleaseNotes.mockImplementation(async (v: string, locale: string) =>
      (v === '1.4.2' ? null : notesFor(v, locale)));
    const { result } = renderHook(() => useUpdateNotice());

    act(() => { result.current.onOpenVersion('1.4.2'); });

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(result.current.open).toBe(false);
    expect(result.current.releaseNotes).toBeNull();
  });

  it('dedupes a double click before the dialog has opened', async () => {
    const { result } = renderHook(() => useUpdateNotice());

    // 同一 tick 两次点击:`open` 还是 false,只有同步 ref 拦得住第二次。
    act(() => {
      result.current.onOpenVersion('1.4.2');
      result.current.onOpenVersion('1.4.2');
    });

    await waitFor(() => expect(result.current.open).toBe(true));
    expect(mocks.fetchReleaseNotesIndex).toHaveBeenCalledTimes(1);
    expect(mocks.fetchReleaseNotes).toHaveBeenCalledTimes(1);
  });

  it('opens with the pending version alone when the index hangs past its budget', async () => {
    setInstalled('1.3.9');
    // index 永不 resolve —— 模拟 CDN 挂住(真实链路要等满 15s 超时)。
    mocks.fetchReleaseNotesIndex.mockReturnValue(new Promise(() => {}));
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useUpdateNotice());

      act(() => { result.current.onOpenVersion('1.4.2'); });

      // 预算到点前不该开:in-between 版本还有希望赶上。
      await act(async () => { await vi.advanceTimersByTimeAsync(2999); });
      expect(result.current.open).toBe(false);

      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      await vi.waitFor(() => expect(result.current.open).toBe(true));
      expect(result.current.releaseNotes?.map((n) => n.version)).toEqual(['1.4.2']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves lastReadVersion untouched on dismiss, so the post-restart popup still fires', async () => {
    const { result } = renderHook(() => useUpdateNotice());

    act(() => { result.current.onOpenVersion('1.4.2'); });
    await waitFor(() => expect(result.current.open).toBe(true));
    act(() => { result.current.dismiss(); });

    expect(localStorage.getItem(STORAGE_KEY)).toBe('1.4.1');
  });

  it('passes the effective locale and refreshes loaded preview notes after a language switch', async () => {
    const { result, rerender } = renderHook(() => useUpdateNotice());

    act(() => { result.current.onOpenVersion('1.4.2'); });
    await waitFor(() => expect(result.current.open).toBe(true));
    expect(mocks.fetchReleaseNotes).toHaveBeenCalledWith('1.4.2', 'en');
    expect(result.current.releaseNotes?.[0]?.topics[0]?.title).toBe('en-1.4.2');

    localeState.current = 'ja';
    rerender();
    await waitFor(() =>
      expect(result.current.releaseNotes?.[0]?.topics[0]?.title).toBe('ja-1.4.2'));
    expect(mocks.fetchReleaseNotes).toHaveBeenCalledWith('1.4.2', 'ja');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('1.4.1');
  });

  it('finishes opening a preview in the new locale when language changes in flight', async () => {
    const pendingEn = deferred<ReturnType<typeof notesFor>>();
    mocks.fetchReleaseNotes.mockImplementation((version: string, locale: string) => {
      if (version === '1.4.2' && locale === 'en') return pendingEn.promise;
      return Promise.resolve(notesFor(version, locale));
    });
    const { result, rerender } = renderHook(() => useUpdateNotice());

    act(() => { result.current.onOpenVersion('1.4.2'); });
    localeState.current = 'ja';
    rerender();
    await act(async () => { pendingEn.resolve(notesFor('1.4.2', 'en')); });

    await waitFor(() => expect(result.current.open).toBe(true));
    expect(result.current.releaseNotes?.[0]?.topics[0]?.title).toBe('ja-1.4.2');
    expect(mocks.fetchReleaseNotes).toHaveBeenCalledWith('1.4.2', 'ja');
  });
});

describe('useUpdateNotice onOpen — flame-icon history is unchanged', () => {
  it('still seeds appVersion and lists the full <= appVersion history', async () => {
    const { result } = renderHook(() => useUpdateNotice());

    act(() => { result.current.onOpen(); });

    await waitFor(() => expect(result.current.open).toBe(true));
    expect(result.current.mode).toBe('manual');
    expect(result.current.releaseNotes?.map((n) => n.version)).toEqual(['1.4.1']);
    expect(result.current.allVersions).toEqual(['1.4.1', '1.4.0', '1.3.9']);
    expect(mocks.fetchReleaseNotes).toHaveBeenCalledWith('1.4.1', 'en');
  });

  it('uses the current locale for manual history lazy loads', async () => {
    localeState.current = 'ko';
    const { result } = renderHook(() => useUpdateNotice());

    act(() => { result.current.onOpen(); });
    await waitFor(() => expect(result.current.open).toBe(true));
    await act(async () => { await result.current.loadVersion('1.4.0'); });

    expect(mocks.fetchReleaseNotes).toHaveBeenCalledWith('1.4.1', 'ko');
    expect(mocks.fetchReleaseNotes).toHaveBeenCalledWith('1.4.0', 'ko');
  });

  it('finishes opening manual history in the new locale when language changes in flight', async () => {
    const appEn = deferred<ReturnType<typeof notesFor>>();
    mocks.fetchReleaseNotes.mockImplementation((version: string, locale: string) => {
      if (version === '1.4.1' && locale === 'en') return appEn.promise;
      return Promise.resolve(notesFor(version, locale));
    });
    const { result, rerender } = renderHook(() => useUpdateNotice());

    act(() => { result.current.onOpen(); });
    localeState.current = 'ko';
    rerender();
    await act(async () => { appEn.resolve(notesFor('1.4.1', 'en')); });

    await waitFor(() => expect(result.current.open).toBe(true));
    expect(result.current.mode).toBe('manual');
    expect(result.current.releaseNotes?.[0]?.topics[0]?.title).toBe('ko-1.4.1');
    expect(mocks.fetchReleaseNotes).toHaveBeenCalledWith('1.4.1', 'ko');
  });
});

describe('useUpdateNotice automatic popup', () => {
  it('loads automatic notices with the effective locale', async () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = { appVersion: '1.4.2' };
    localStorage.setItem(STORAGE_KEY, '1.4.1');
    localeState.current = 'ja';

    const { result } = renderHook(() => useUpdateNotice());

    await waitFor(() => expect(result.current.open).toBe(true));
    expect(mocks.fetchReleaseNotes).toHaveBeenCalledWith('1.4.2', 'ja');
    expect(result.current.releaseNotes?.[0]?.topics[0]?.title).toBe('ja-1.4.2');
  });

  it('retries a transient automatic notice miss before giving up', async () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = { appVersion: '1.4.2' };
    localStorage.setItem(STORAGE_KEY, '1.4.1');
    let currentFetch = 0;
    mocks.fetchReleaseNotes.mockImplementation(async (version: string, locale: string) => {
      if (version === '1.4.2' && currentFetch++ === 0) return null;
      return notesFor(version, locale);
    });
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useUpdateNotice());

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(result.current.open).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(result.current.open).toBe(true);
      expect(result.current.releaseNotes?.map((n) => n.version)).toEqual(['1.4.2']);
      expect(currentFetch).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reopen an automatic notice after manual history is opened and dismissed during retry delay', async () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = { appVersion: '1.4.2' };
    localStorage.setItem(STORAGE_KEY, '1.4.1');
    let currentFetch = 0;
    mocks.fetchReleaseNotes.mockImplementation(async (version: string, locale: string) => {
      if (version === '1.4.2' && currentFetch++ === 0) return null;
      return notesFor(version, locale);
    });
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useUpdateNotice());

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(result.current.open).toBe(false);

      act(() => { result.current.onOpen(); });
      await act(async () => { await Promise.resolve(); });
      expect(result.current.open).toBe(true);

      act(() => { result.current.dismiss(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(result.current.open).toBe(false);
      expect(currentFetch).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reopen an automatic notice dismissed during a locale refresh', async () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = { appVersion: '1.4.2' };
    localStorage.setItem(STORAGE_KEY, '1.4.1');
    const jaRefresh = deferred<ReturnType<typeof notesFor>>();
    mocks.fetchReleaseNotes.mockImplementation((version: string, locale: string) => {
      if (locale === 'ja') return jaRefresh.promise;
      return Promise.resolve(notesFor(version, locale));
    });
    const { result, rerender } = renderHook(() => useUpdateNotice());

    await waitFor(() => expect(result.current.open).toBe(true));
    localeState.current = 'ja';
    rerender();
    act(() => { result.current.dismiss(); });
    expect(result.current.open).toBe(false);

    await act(async () => { jaRefresh.resolve(notesFor('1.4.2', 'ja')); });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.open).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('1.4.2');
    expect(mocks.fetchReleaseNotes).toHaveBeenCalledTimes(2);
  });
});
