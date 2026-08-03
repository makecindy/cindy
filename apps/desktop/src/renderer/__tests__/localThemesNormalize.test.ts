import { describe, expect, it } from 'vitest';

import {
  contrastRatio,
  parseCssColor,
  type Rgb,
} from '../../shared/theme-import/color';
import { normalizeLocalThemeColors } from '../themes/local-themes-normalize';

function rgb(value: string | undefined): Rgb {
  if (!value) throw new Error('missing color in normalized local theme');
  const parsed = parseCssColor(value);
  if (!parsed) throw new Error(`invalid color in normalized local theme: ${value}`);
  return parsed;
}

const SWITCH_DERIVATION_TARGET = 3.2;

describe('normalizeLocalThemeColors', () => {
  it('迁移旧 connected badge override 并保留原中性色给文字 token', () => {
    const out = normalizeLocalThemeColors({
      surface: '#111',
      'settings-badge-connected': 'var(--text-primary)',
    });
    expect(out['settings-badge-connected']).toBe('var(--card-status-done)');
    expect(out['settings-badge-connected-text']).toBe('var(--text-primary)');
    expect(out['surface']).toBe('#111');
  });

  it('已迁移 connected badge token 时保持幂等', () => {
    const input = {
      'settings-badge-connected': 'var(--card-status-done)',
      'settings-badge-connected-text': 'var(--text-primary)',
    };
    const out = normalizeLocalThemeColors(input);
    expect(out).toBe(input);
  });

  it('保留旧快照中的自定义 connected badge 覆盖', () => {
    const input = {
      'settings-badge-connected': '#22c55e',
    };
    const out = normalizeLocalThemeColors(input);
    expect(out).toBe(input);
  });

  it('从 settings-input-placeholder 播种 text-placeholder 并丢弃 4 个旧 per-surface key', () => {
    const out = normalizeLocalThemeColors({
      surface: '#111',
      'settings-input-placeholder': '#c4c4c4',
      'chat-input-placeholder': 'var(--text-tertiary)',
      'ask-input-placeholder': 'var(--text-tertiary)',
      'plan-action-fb-placeholder': 'var(--text-tertiary)',
    });
    expect(out['text-placeholder']).toBe('#c4c4c4');
    expect(out['settings-input-placeholder']).toBeUndefined();
    expect(out['chat-input-placeholder']).toBeUndefined();
    expect(out['ask-input-placeholder']).toBeUndefined();
    expect(out['plan-action-fb-placeholder']).toBeUndefined();
    // 非 placeholder token 不受影响
    expect(out['surface']).toBe('#111');
  });

  it('settings 缺失时回退到 per-surface 值播种(按优先级)', () => {
    const out = normalizeLocalThemeColors({
      'chat-input-placeholder': '#a3a3a3',
      'plan-action-fb-placeholder': 'var(--text-tertiary)',
    });
    expect(out['text-placeholder']).toBe('#a3a3a3');
    expect(out['chat-input-placeholder']).toBeUndefined();
    expect(out['plan-action-fb-placeholder']).toBeUndefined();
  });

  it('已带 text-placeholder 的快照原样返回(幂等,不二次迁移)', () => {
    const input = {
      'text-placeholder': '#525252',
      'settings-input-placeholder': '#999',
    };
    const out = normalizeLocalThemeColors(input);
    expect(out).toBe(input);
    // 已迁移主题的旧 per-surface key 不动(它显式存在即视为用户/快照有意保留)
    expect(out['settings-input-placeholder']).toBe('#999');
  });

  it('完全没有 placeholder override 时不动(留给 registry 默认)', () => {
    const input = { surface: '#111', 'text-primary': '#eee' };
    const out = normalizeLocalThemeColors(input);
    expect(out).toBe(input);
    expect(out['text-placeholder']).toBeUndefined();
  });

  it.each([
    [
      'light',
      {
        surface: '#ffffff',
        'surface-elevated': '#ffffff',
        'surface-card-ivory': '#ffffff',
        'surface-hover': '#f8f8f8',
        'surface-hover-soft': '#ffffff',
        'surface-on-card': '#ffffff',
        'text-secondary': '#f0f0f0',
        // 迁移不能被已有兼容 token 的提前返回跳过。
        'text-placeholder': '#c4c4c4',
      },
    ],
    [
      'dark',
      {
        surface: '#000000',
        'surface-elevated': '#050505',
        'surface-card-ivory': '#050505',
        'surface-hover': '#0a0a0a',
        'surface-hover-soft': '#0a0a0a',
        'surface-on-card': '#000000',
        'text-secondary': '#101010',
        'text-placeholder': '#666666',
      },
    ],
  ])('为升级前保存的 %s 导入主题补齐 Switch 安全 token', (_type, input) => {
    const out = normalizeLocalThemeColors(input);
    const track = rgb(out['switch-track-off']);
    const thumb = rgb(out['switch-thumb-off']);

    expect(out['switch-track-off']).not.toBe(input['text-secondary']);
    expect(contrastRatio(track, thumb), 'thumb x track')
      .toBeGreaterThanOrEqual(SWITCH_DERIVATION_TARGET);
    for (const surfaceId of [
      'surface',
      'surface-elevated',
      'surface-card-ivory',
      'surface-hover',
      'surface-hover-soft',
    ]) {
      expect(
        contrastRatio(track, rgb(out[surfaceId])),
        `track x ${surfaceId}`,
      ).toBeGreaterThanOrEqual(SWITCH_DERIVATION_TARGET);
    }
  });

  it('保留用户显式配置的 Switch token，不二次校正', () => {
    const input = {
      'switch-track-off': '#777777',
      'switch-thumb-off': '#ffffff',
      'text-secondary': '#f0f0f0',
    };
    expect(normalizeLocalThemeColors(input)).toBe(input);
  });

  it('旧语义色不完整或不可解析时保持原样，不让本地主题加载失败', () => {
    const input = {
      surface: '#ffffff',
      'surface-on-card': 'var(--surface-elevated)',
      'text-secondary': '#f0f0f0',
    };
    expect(normalizeLocalThemeColors(input)).toBe(input);
  });

  it('无解的旧导入主题恢复升级前的边框轨道与表面滑块，不静默倒退到默认别名', () => {
    const input = {
      surface: '#000000',
      'surface-elevated': '#ffffff',
      'surface-card-ivory': '#ffffff',
      'surface-hover': '#777777',
      'surface-hover-soft': '#777777',
      'surface-on-card': '#ffffff',
      'border-default': '#555555',
      'text-secondary': '#777777',
    };

    const out = normalizeLocalThemeColors(input);

    expect(out['switch-track-off']).toBe('#555555');
    expect(out['switch-thumb-off']).toBe('#000000');
  });
});
