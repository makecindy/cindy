// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('react-router-dom', () => ({ useLocation: () => ({ pathname: '/' }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import '../../themes/colors';
import { colorRegistry } from '../../themes/color-registry';
import { resolveOverlayPalette } from '../useRegionCaptureShortcut';

/**
 * 覆盖层配色兜底:CSS 变量缺失时不再手写颜色字面量,而是回到颜色注册表的
 * 当前明/暗默认值(check:design-colors 阻塞 renderer 内的字面量兜底)。
 */
describe('resolveOverlayPalette fallback', () => {
  beforeEach(() => {
    // 让 normalizeCaptureColor 走"非法值 → 兜底"分支,不触碰 canvas。
    vi.stubGlobal('CSS', { supports: () => false });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.classList.remove('dark');
  });

  it('uses registered light defaults when the theme variables are absent', () => {
    const palette = resolveOverlayPalette();
    expect(palette.selectionBorder).toBe(colorRegistry.resolveDefault('region-capture-selection-border', 'light'));
    expect(palette.pillBg).toBe(colorRegistry.resolveDefault('tooltip-bg', 'light'));
    expect(palette.pillFg).toBe(colorRegistry.resolveDefault('tooltip-text', 'light'));
    expect(palette.scrim).toBe(colorRegistry.resolveDefault('overlay-modal', 'light'));
    expect(palette.pillBg).toMatch(/^#|^rgba?\(/);
  });

  it('follows the dark root class before any theme is applied', () => {
    document.documentElement.classList.add('dark');
    const palette = resolveOverlayPalette();
    expect(palette.pillBg).toBe(colorRegistry.resolveDefault('tooltip-bg', 'dark'));
    expect(palette.scrim).toBe(colorRegistry.resolveDefault('overlay-modal', 'dark'));
    expect(palette.pillBg).not.toBe(colorRegistry.resolveDefault('tooltip-bg', 'light'));
  });
});
