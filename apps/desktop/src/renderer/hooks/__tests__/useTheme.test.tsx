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
import { bootstrapLocalThemesSync } from '../../themes/local-themes';
import { themeService } from '../../themes/theme-service';
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
