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

import { themeService } from '../../themes/theme-service';
import { publishSkinAppearance } from '../../cindy-brain/skinAppearanceStore';
import { ThemeProvider, useTheme } from '../useTheme';

// jsdom 无 matchMedia,ThemeProvider 初始化与 system 模式需要它。
vi.stubGlobal('matchMedia', (q: string) => ({
  matches: false,
  media: q,
  addEventListener: () => {},
  removeEventListener: () => {},
}));

function wrapper({ children }: { children: ReactNode }) {
  return createElement(ThemeProvider, null, children);
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
    localStorage.clear();
    publishSkinAppearance(null);
    delete document.documentElement.dataset.theme;
    document.documentElement.classList.remove('dark');
    vi.spyOn(themeService, 'applyTheme').mockImplementation(() => {});
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

  it('皮肤作为互斥外观来源，显示模式只解析其对应明暗变体', () => {
    publishSkinAppearance({
      palette: 'ocean',
      sourceGhostId: 'skin',
      dim: 0.28,
      surfaceOpacity: 0.82,
      updatedAt: 1,
    });
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.appearanceSource).toBe('skin');
    const applySpy = themeService.applyTheme as unknown as ReturnType<typeof vi.fn>;
    expect(applySpy.mock.calls.at(-1)?.[0]).toMatchObject({
      id: 'skin-ocean-light',
      type: 'light',
    });
  });

  it('停用皮肤后恢复此前保存的普通主题家族', () => {
    localStorage.setItem('theme.familyId', 'default');
    publishSkinAppearance({
      palette: 'forest',
      sourceGhostId: 'skin',
      dim: 0.28,
      surfaceOpacity: 0.82,
      updatedAt: 1,
    });
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.familyId).toBe('default');
    act(() => publishSkinAppearance(null));
    expect(result.current.appearanceSource).toBe('theme');
    expect(result.current.familyId).toBe('default');
  });
});
