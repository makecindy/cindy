// @vitest-environment jsdom

/**
 * useTheme 跨窗口主题同步(D2-3,计划 §2 D2-3):
 * - 其他窗口切 theme/familyId → localStorage storage 事件 → 本窗口 state + applyTheme 跟随
 * - 本窗口 setItem 不触发 storage(storage 事件语义),不会循环
 * - 非法值/无关 key 不触发
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

import '../../themes/colors';
import { bootstrapLocalThemesSync, getLocalThemes } from '../../themes/local-themes';
import { themeService } from '../../themes/theme-service';
import { tryGetFamily } from '../../themes/families';
import { DEFAULT_APPEARANCE_SETTINGS } from '../../../shared/appearanceSettings';
import type { LocalThemesResult } from '../../../shared/local-themes';
import {
  __resetLoginFirstLaunchLightGateForTest,
  endLoginFirstLaunchLightGate,
  followLocalThemeChanges,
  getInitialThemeVariant,
  ThemeProvider,
  useTheme,
} from '../useTheme';

const applyVibrancyMock = vi.fn();
vi.mock('../../lib/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('../../i18n', () => ({ default: { t: (key: string) => key } }));
let systemPrefersDark = false;

// jsdom 无 matchMedia,ThemeProvider 初始化与 system 模式需要它。
vi.stubGlobal('matchMedia', (q: string) => ({
  matches: systemPrefersDark,
  media: q,
  addEventListener: () => {},
  removeEventListener: () => {},
}));

function wrapper({ children }: { children: ReactNode }) {
  return createElement(ThemeProvider, null, children);
}

function utilityWindowWrapper({ children }: { children: ReactNode }) {
  return createElement(ThemeProvider, { children, syncWindowVibrancy: false });
}

// 构造 storage 事件:用普通 Event + 显式 key/newValue,避免依赖 jsdom 对
// StorageEvent 构造函数第二参数(init)的重载支持(CodeQL: superfluous trailing arguments)。
// useTheme 的 storage 监听只读 event.key / event.newValue,语义完全等价。
function dispatchStorage(key: string, newValue: string | null) {
  const event = new Event('storage');
  Object.defineProperty(event, 'key', { value: key });
  Object.defineProperty(event, 'newValue', { value: newValue });
  window.dispatchEvent(event);
}

describe('useTheme 跨窗口主题同步(D2-3)', () => {
  beforeEach(() => {
    __resetLoginFirstLaunchLightGateForTest();
    systemPrefersDark = false;
    localStorage.clear();
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.wallpaperActive;
    document.documentElement.classList.remove('dark');
    vi.spyOn(themeService, 'applyTheme').mockImplementation(() => {});
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      theme: { applyVibrancy: applyVibrancyMock },
    };
    applyVibrancyMock.mockClear();
  });

  // Unit, real ThemeProvider/setters and browser storage: old users must not
  // depend on the Host appearance file to start or switch builtin themes.
  // Earlier migration tests asserted the replacement ownership, not this
  // compatibility contract. A throwing Host plus an old dark/default choice
  // reproduces both the startup regression and the lost synchronous setter.
  it('starts and switches builtin themes from legacy storage even when Host settings are unreadable', () => {
    const unavailable = vi.fn(() => { throw new Error('Appearance file unreadable'); });
    Object.assign(window.electronAPI, { appearanceSettings: {
      getSync: unavailable, selectTheme: unavailable, migrateTheme: unavailable,
      onChanged: unavailable,
    } });
    localStorage.setItem('theme', 'dark');
    localStorage.setItem('theme.familyId', 'default');
    expect(getInitialThemeVariant().theme.type).toBe('dark');
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.familyId).toBe('default');
    expect(localStorage.getItem('theme')).toBe('dark');
    for (const mode of ['system', 'light', 'dark'] as const) {
      act(() => result.current.setTheme(mode));
      expect(result.current.theme).toBe(mode);
      expect(localStorage.getItem('theme')).toBe(mode);
    }
    act(() => result.current.setFamily('cindy'));
    expect(result.current.familyId).toBe('cindy');
    expect(localStorage.getItem('theme.familyId')).toBe('cindy');
    expect(unavailable).not.toHaveBeenCalled();
  });

  // Unit through the real cache and ThemeProvider: a package adds metadata and
  // async preparation without changing old Theme objects or stored selection.
  // Minimum: one local package then a builtin; legacy storage tests miss this exit.
  it('prepares an explicit package before saving its selection and clears defaults only when leaving a package', async () => {
    vi.mocked(themeService.applyTheme).mockRestore();
    localStorage.setItem('theme', 'light');
    localStorage.setItem('theme.familyId', 'default');
    const builtin = structuredClone(tryGetFamily('cindy'));
    const loose = { id: 'loose-local', name: 'Loose', type: 'light' as const, colors: {} };
    const install = (themes: LocalThemesResult['themes']) => {
      Object.assign(window.electronAPI, { localThemes: {
        listSync: () => ({ success: true, themes, diagnostics: [] }), onChanged: () => () => {},
      } });
      bootstrapLocalThemesSync();
    };
    install([loose]);
    const originalLoose = getLocalThemes()[0];
    install([{ ...loose, appearance: { density: 0.9 } }, {
      id: 'paper-light-local', family: 'paper', name: 'Paper', type: 'light', colors: {},
      packageSha256: 'a'.repeat(64), appearance: { uiFont: { family: 'Theme Font' }, motion: 0 },
    }]);
    expect(getLocalThemes()[0]).toEqual(originalLoose);
    expect(tryGetFamily('cindy')).toEqual(builtin);
    let complete!: (value: typeof DEFAULT_APPEARANCE_SETTINGS) => void;
    const selectTheme = vi.fn(() => new Promise<typeof DEFAULT_APPEARANCE_SETTINGS>(resolve => { complete = resolve; }));
    Object.assign(window.electronAPI, { appearanceSettings: {
      getSync: () => DEFAULT_APPEARANCE_SETTINGS, onChanged: () => () => {}, selectTheme,
    } });
    const { result, unmount } = renderHook(() => useTheme(), { wrapper });
    expect(selectTheme).not.toHaveBeenCalled();
    const previousTheme = document.documentElement.dataset.theme;
    act(() => { result.current.setFamily('paper-local'); });
    expect(document.documentElement.dataset.theme).toBe(previousTheme);
    expect(result.current.familyId).toBe('default');
    expect(localStorage.getItem('theme.familyId')).toBe('default');
    expect(selectTheme).toHaveBeenCalledExactlyOnceWith({ mode: 'light', familyId: 'paper-local' });
    await act(async () => { complete(DEFAULT_APPEARANCE_SETTINGS); });
    expect(document.documentElement.dataset.theme).toBe('paper-light-local');
    expect(result.current.familyId).toBe('paper-local');
    expect(localStorage.getItem('theme.familyId')).toBe('paper-local');
    selectTheme.mockResolvedValue(DEFAULT_APPEARANCE_SETTINGS);
    await act(async () => { result.current.setFamily('default'); });
    expect(selectTheme).toHaveBeenLastCalledWith(null);
    expect(selectTheme).toHaveBeenCalledTimes(2);
    await act(async () => { result.current.setFamily('loose-local'); result.current.setTheme('dark'); });
    expect(selectTheme).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem('theme.familyId')).toBe('loose-local');
    unmount();
  });

  // Unit, real setters/storage/palette: an explicit bad package must never write
  // the selection, even temporarily. The former rollback tests checked only the
  // final state and missed writes propagated to other windows before rejection.
  it.each(['builtin', 'absent', 'package', 'mode', 'accepted'])(
    'keeps the original selection and palette throughout package rejection (%s)', async scenario => {
      vi.mocked(themeService.applyTheme).mockRestore();
      const packaged = (family: string, type: 'light' | 'dark') => ({
        id: `${family}-${type}-local`, family, name: family, type, colors: { surface: '#fafafa' },
        packageSha256: 'a'.repeat(64), appearance: { density: 0.9 },
      });
      let previousFamily = scenario === 'builtin' ? 'default' : scenario === 'absent' ? 'cindy' : 'kept-local';
      if (scenario !== 'absent') {
        localStorage.setItem('theme', 'system');
        localStorage.setItem('theme.familyId', previousFamily);
      }
      let stored = [localStorage.getItem('theme'), localStorage.getItem('theme.familyId')];
      const selectTheme = vi.fn().mockResolvedValue(DEFAULT_APPEARANCE_SETTINGS);
      Object.assign(window.electronAPI, { localThemes: {
        listSync: () => ({ success: true, themes: ['kept', 'broken', 'newer'].flatMap(family =>
          [packaged(family, 'light'), packaged(family, 'dark')]), diagnostics: [] }),
        onChanged: () => () => {},
      }, appearanceSettings: { getSync: () => DEFAULT_APPEARANCE_SETTINGS,
        onChanged: () => () => {}, selectTheme } });
      bootstrapLocalThemesSync();
      const { result, unmount } = renderHook(() => useTheme(), { wrapper });
      await act(async () => {});
      if (scenario === 'accepted') {
        await act(async () => { result.current.setFamily('newer-local'); });
        previousFamily = 'newer-local';
        stored = [localStorage.getItem('theme'), localStorage.getItem('theme.familyId')];
      }
      const previousTheme = themeService.getCurrentTheme();
      const acceptedCalls = selectTheme.mock.calls.length;
      const writes = vi.spyOn(Storage.prototype, 'setItem');
      const rejects: Array<(reason: Error) => void> = [];
      selectTheme.mockImplementation((selection: unknown) => selection === null
        ? Promise.resolve(DEFAULT_APPEARANCE_SETTINGS)
        : new Promise((_resolve, reject) => { rejects.push(reject); }));
      act(() => {
        if (scenario === 'mode') result.current.setTheme('dark');
        else result.current.setFamily('broken-local');
      });
      expect(result.current.familyId).toBe(previousFamily);
      expect(result.current.theme).toBe('system');
      expect([localStorage.getItem('theme'), localStorage.getItem('theme.familyId')]).toEqual(stored);
      expect(themeService.getCurrentTheme()).toBe(previousTheme);
      expect(writes).not.toHaveBeenCalled();
      const requests = rejects.length;
      await act(async () => { rejects.at(-1)!(new Error('Invalid resource')); await vi.dynamicImportSettled(); });
      expect(result.current.familyId).toBe(previousFamily);
      expect(result.current.theme).toBe('system');
      expect([localStorage.getItem('theme'), localStorage.getItem('theme.familyId')]).toEqual(stored);
      expect(themeService.getCurrentTheme()).toBe(previousTheme);
      expect(document.documentElement.dataset.theme).toBe(previousTheme!.id);
      expect(selectTheme).toHaveBeenCalledTimes(acceptedCalls + requests);
      expect(writes).not.toHaveBeenCalled();
      writes.mockRestore();
      selectTheme.mockResolvedValue(DEFAULT_APPEARANCE_SETTINGS);
      act(() => result.current.setFamily('default'));
      await act(async () => {});
      unmount();
    },
  );

  // Unit: two successful preparations complete out of order, or a synchronous
  // builtin/loose selection cancels one. Existing rejection tests miss late
  // success overwriting a newer choice. Deferred IPC keeps the test under 5s.
  it.each(['package', 'builtin', 'loose', 'same-mode', 'storage'] as const)(
    'discards a successful package preparation superseded by %s', async next => {
      vi.mocked(themeService.applyTheme).mockRestore();
      localStorage.setItem('theme', 'light');
      localStorage.setItem('theme.familyId', 'default');
      const complete: Array<(value: typeof DEFAULT_APPEARANCE_SETTINGS) => void> = [];
      const selectTheme = vi.fn((selection: unknown) => selection === null
        ? Promise.resolve(DEFAULT_APPEARANCE_SETTINGS)
        : new Promise<typeof DEFAULT_APPEARANCE_SETTINGS>(resolve => { complete.push(resolve); }));
      Object.assign(window.electronAPI, { localThemes: {
        listSync: () => ({ success: true, diagnostics: [], themes: [
          ...['first', 'last'].map(family => ({ id: `${family}-light-local`, family, name: family,
            type: 'light', colors: {}, packageSha256: 'a'.repeat(64), appearance: { density: 0.9 } })),
          { id: 'loose-local', name: 'Loose', type: 'light', colors: {} },
        ] }), onChanged: () => () => {},
      }, appearanceSettings: { getSync: () => DEFAULT_APPEARANCE_SETTINGS,
        onChanged: () => () => {}, selectTheme } });
      bootstrapLocalThemesSync();
      const { result, unmount } = renderHook(() => useTheme(), { wrapper });
      act(() => { result.current.setFamily('first-local'); });
      act(() => {
        if (next === 'storage') {
          localStorage.setItem('theme.familyId', 'cindy');
          dispatchStorage('theme.familyId', 'cindy');
        } else if (next === 'same-mode') result.current.setTheme('light');
        else result.current.setFamily(next === 'package' ? 'last-local' : next === 'builtin' ? 'cindy' : 'loose-local');
      });
      if (next === 'package') {
        expect(result.current.familyId).toBe('default');
        await act(async () => { complete[1](DEFAULT_APPEARANCE_SETTINGS); });
      }
      const expected = next === 'package' ? 'last-local' : next === 'builtin' || next === 'storage' ? 'cindy' : next === 'loose' ? 'loose-local' : 'default';
      const palette = themeService.getCurrentTheme();
      expect(result.current.familyId).toBe(expected);
      await act(async () => { complete[0](DEFAULT_APPEARANCE_SETTINGS); });
      expect(result.current.familyId).toBe(expected);
      expect(localStorage.getItem('theme.familyId')).toBe(expected);
      expect(themeService.getCurrentTheme()).toBe(palette);
      selectTheme.mockResolvedValue(DEFAULT_APPEARANCE_SETTINGS);
      await act(async () => { result.current.setFamily('default'); });
      unmount();
    },
  );

  it('把应用主题模式同步给 main 作为下次 Windows 创建期 backing 镜像', () => {
    localStorage.setItem('theme', 'dark');
    renderHook(() => useTheme(), { wrapper });

    expect(applyVibrancyMock).toHaveBeenCalledWith('cindy', true, 'dark', true, false, null);
  });

  it('utility 窗口复用 ThemeProvider 时不写全局窗口材质快照', () => {
    localStorage.setItem('theme', 'dark');
    renderHook(() => useTheme(), { wrapper: utilityWindowWrapper });

    expect(applyVibrancyMock).not.toHaveBeenCalled();
  });

  it('把单变体家族标记为不随系统模式切换', () => {
    localStorage.setItem('theme.familyId', 'eclipse');
    renderHook(() => useTheme(), { wrapper });

    expect(applyVibrancyMock).toHaveBeenCalledWith('eclipse', true, 'system', false, false, null);
  });

  it('系统深色下真首启按亮色门的实际主题上报 backing，门结束后恢复深色', () => {
    systemPrefersDark = true;
    expect(getInitialThemeVariant().theme.type).toBe('light');

    renderHook(() => useTheme(), { wrapper });
    expect(applyVibrancyMock).toHaveBeenLastCalledWith('cindy', false, 'system', true, false, null);

    act(() => {
      endLoginFirstLaunchLightGate();
    });
    expect(applyVibrancyMock).toHaveBeenLastCalledWith('cindy', true, 'system', true, false, null);
  });

  it('其他窗口切 theme → storage 事件 → 本窗口 theme state 跟随并重应用', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.theme).toBe('system');
    act(() => {
      dispatchStorage('theme', 'dark');
    });
    expect(result.current.theme).toBe('dark');
    expect(themeService.applyTheme).toHaveBeenCalled();
  });

  // Protocol regression: wallpaper rendering used to leave the native material enabled.
  it('reports actual canvas coverage, deduplicates unchanged coverage and stops observing on unmount', async () => {
    localStorage.setItem('theme', 'dark');
    const { result, unmount } = renderHook(() => useTheme(), { wrapper });
    const root = document.documentElement;
    await act(async () => {
      root.dataset.wallpaperActive = 'true';
    });
    expect(applyVibrancyMock).toHaveBeenLastCalledWith('cindy', true, 'dark', true, true, null);

    const count = applyVibrancyMock.mock.calls.length;
    await act(async () => {
      root.dataset.wallpaperActive = 'true';
    });
    expect(applyVibrancyMock).toHaveBeenCalledTimes(count);

    act(() => {
      result.current.setTheme('light');
    });
    expect(applyVibrancyMock).toHaveBeenLastCalledWith('cindy', false, 'light', true, true, null);
    await act(async () => {
      delete root.dataset.wallpaperActive;
    });
    expect(applyVibrancyMock).toHaveBeenLastCalledWith('cindy', false, 'light', true, false, null);

    unmount();
    applyVibrancyMock.mockClear();
    await act(async () => {
      root.dataset.wallpaperActive = 'true';
    });
    expect(applyVibrancyMock).not.toHaveBeenCalled();
  });

  it('reports a wallpaper canvas already present at ThemeProvider mount', () => {
    localStorage.setItem('theme', 'dark');
    document.documentElement.dataset.wallpaperActive = 'true';
    renderHook(() => useTheme(), { wrapper });
    expect(applyVibrancyMock).toHaveBeenLastCalledWith('cindy', true, 'dark', true, true, null);
  });

  it('无存档时默认 cindy,其他窗口切 familyId=default 后本窗口跟随', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.familyId).toBe('cindy');
    act(() => {
      dispatchStorage('theme.familyId', 'default');
    });
    expect(result.current.familyId).toBe('default');
  });

  it('保留已有用户存储的主题家族选择', () => {
    localStorage.setItem('theme.familyId', 'default');
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.familyId).toBe('default');
  });

  it('同一主题家族再次应用时仍通知主题订阅者', () => {
    document.documentElement.dataset.theme = 'cindy-light';
    document.documentElement.classList.remove('dark');
    const { result } = renderHook(() => useTheme(), { wrapper });
    const applySpy = themeService.applyTheme as unknown as ReturnType<typeof vi.fn>;
    applySpy.mockClear();

    act(() => {
      result.current.setFamily('cindy');
    });

    expect(applySpy).toHaveBeenCalledOnce();
  });

  it('非法 theme 值不触发 state 变更', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    const before = result.current.theme;
    act(() => {
      dispatchStorage('theme', 'garbage');
    });
    expect(result.current.theme).toBe(before);
  });

  it('非法 familyId(未注册)不触发变更', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    const before = result.current.familyId;
    act(() => {
      dispatchStorage('theme.familyId', 'no-such-family');
    });
    expect(result.current.familyId).toBe(before);
  });

  it('无关 key 的 storage 事件不触发主题变更', () => {
    const applySpy = themeService.applyTheme as unknown as ReturnType<typeof vi.fn>;
    applySpy.mockClear();
    const { result } = renderHook(() => useTheme(), { wrapper });
    const beforeTheme = result.current.theme;
    const beforeFamily = result.current.familyId;
    act(() => {
      dispatchStorage('unrelated.key', 'x');
    });
    expect(result.current.theme).toBe(beforeTheme);
    expect(result.current.familyId).toBe(beforeFamily);
  });

// Unit IPC contract: without this observation, toggling desktop blur leaves the
// native material stale until a theme change. Existing tests only change artwork.
it('reports every desktop blur radius and clears the override when returning to artwork', async () => {
  const { unmount } = renderHook(() => useTheme(), { wrapper });
  const root = document.documentElement;
  await act(async () => {
    root.dataset.desktopBackground = 'true';
    root.dataset.desktopBlur = '0';
  });
  expect(applyVibrancyMock.mock.lastCall?.[5]).toBe(0);
  await act(async () => { root.dataset.desktopBlur = '5'; });
  expect(applyVibrancyMock.mock.lastCall?.[5]).toBe(5);
  await act(async () => { root.dataset.desktopBlur = '17'; });
  expect(applyVibrancyMock.mock.lastCall?.[5]).toBe(17);
  await act(async () => { delete root.dataset.desktopBackground; });
  expect(applyVibrancyMock.mock.lastCall?.[5]).toBeNull();
  delete root.dataset.desktopBlur;
  unmount();
});
});

// PR #9358：既有 Provider 测试没有覆盖无 Provider 的轻量窗口。
// unit：从生产初始化入口接收同 ID 换色推送，验证实际 CSS、明暗及取消订阅。
describe('辅助窗口 Omarchy 实时换色', () => {
  it('同 ID 同明暗换色、明暗切换均更新 DOM，停止订阅后不再更新', () => {
    vi.restoreAllMocks();
    __resetLoginFirstLaunchLightGateForTest();
    localStorage.clear();
    localStorage.setItem('theme.familyId', 'omarchy');
    localStorage.setItem('theme', 'light');
    let push: (payload: LocalThemesResult) => void = () => {};
    const payload = (type: 'light' | 'dark', surface: string): LocalThemesResult => ({
      success: true, diagnostics: [], themes: [{ id: 'omarchy', name: 'Omarchy', type, colors: { surface } }],
    });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      localThemes: {
        listSync: () => payload('light', '#faf4ed'),
        onChanged: (callback: typeof push) => { push = callback; return () => {}; },
      },
      theme: { applyVibrancy: applyVibrancyMock },
    };
    applyVibrancyMock.mockClear();
    bootstrapLocalThemesSync();
    themeService.applyTheme(getInitialThemeVariant().theme);
    const stop = followLocalThemeChanges();
    const root = document.documentElement;
    const surface = () => getComputedStyle(root).getPropertyValue('--surface').trim();
    try {
      expect(surface()).toBe('#faf4ed');
      push(payload('light', '#ffffff'));
      expect(surface()).toBe('#ffffff');
      push(payload('dark', '#142620'));
      expect(surface()).toBe('#142620');
      expect(root.classList.contains('dark')).toBe(true);
      expect(root.style.colorScheme).toBe('dark');
      push(payload('light', '#faf4ed'));
      expect(surface()).toBe('#faf4ed');
      expect(root.classList.contains('dark')).toBe(false);
      expect(root.style.colorScheme).toBe('light');
      expect(applyVibrancyMock).not.toHaveBeenCalled();
      stop();
      push(payload('dark', '#142620'));
      expect(surface()).toBe('#faf4ed');
    } finally {
      stop();
      localStorage.clear();
      document.getElementById('theme-vars')?.remove();
    }
  });
});
