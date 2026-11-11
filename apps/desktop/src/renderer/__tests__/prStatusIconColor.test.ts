import { describe, expect, it } from 'vitest';

import {
  hslTripletLightness,
  prIconSurface,
  prStatusIconColor,
  shouldShowPrUnresolvedDot,
} from '../features/cc-agent/gitContextPrVisuals';

describe('prIconSurface', () => {
  it('未选中跟主题表面走', () => {
    expect(prIconSurface({ themeIsDark: false, isActive: false })).toBe('light');
    expect(prIconSurface({ themeIsDark: true, isActive: false })).toBe('dark');
  });

  it('读不到实际明度时,选中按 Cindy 反相假设兜底', () => {
    expect(prIconSurface({ themeIsDark: true, isActive: true })).toBe('light');
    expect(prIconSurface({ themeIsDark: false, isActive: true })).toBe('dark');
  });

  it('有实际背景明度时不再假设选中反相(社区/导入主题)', () => {
    expect(
      prIconSurface({ themeIsDark: false, isActive: true, backgroundLightness: 92 }),
    ).toBe('light');
    expect(
      prIconSurface({ themeIsDark: true, isActive: true, backgroundLightness: 18 }),
    ).toBe('dark');
  });
});

describe('hslTripletLightness', () => {
  it('解析 HSL 三元组与带 alpha 的写法', () => {
    expect(hslTripletLightness('0.0 0.0% 93.3%')).toBe(93.3);
    expect(hslTripletLightness('0.0 0.0% 100.0% / 0.09')).toBe(100);
    expect(hslTripletLightness('214.3 5.5% 24.9%')).toBe(24.9);
  });

  it('解析不了返回 null', () => {
    expect(hslTripletLightness('')).toBeNull();
    expect(hslTripletLightness('#eeeeee')).toBeNull();
  });
});

describe('prStatusIconColor', () => {
  it('open 按表面取侧栏专用绿,不跟主题 --diff-add-fg', () => {
    expect(prStatusIconColor('open', 'light')).toBe('var(--pr-open-on-light)');
    expect(prStatusIconColor('open', 'dark')).toBe('var(--pr-open-on-dark)');
  });

  it('其它三态与未知态不跟表面走', () => {
    expect(prStatusIconColor('draft', 'light')).toBe('var(--text-tertiary)');
    expect(prStatusIconColor('merged', 'dark')).toBe('var(--focus-ring)');
    expect(prStatusIconColor('closed', 'light')).toBe('var(--error-fg)');
    expect(prStatusIconColor(null, 'dark')).toBe('var(--text-tertiary)');
  });
});

describe('shouldShowPrUnresolvedDot', () => {
  it('只在 open/draft 且 count>0 时打点', () => {
    expect(shouldShowPrUnresolvedDot('open', 3)).toBe(true);
    expect(shouldShowPrUnresolvedDot('draft', 1)).toBe(true);
    expect(shouldShowPrUnresolvedDot('open', 0)).toBe(false);
    expect(shouldShowPrUnresolvedDot('open', null)).toBe(false);
    expect(shouldShowPrUnresolvedDot('merged', 4)).toBe(false);
    expect(shouldShowPrUnresolvedDot('closed', 2)).toBe(false);
    expect(shouldShowPrUnresolvedDot(null, 5)).toBe(false);
  });
});
