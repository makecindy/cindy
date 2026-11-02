import { describe, expect, it } from 'vitest';

import {
  contrastRatio,
  parseCssColor,
  type Rgb,
} from '../../shared/theme-import/color';
import legacyTable from '../themes/loginLegacyDefaults.json';
import { LEGACY_SNAPSHOT_MIN_MATCHES } from '../themes/loginLegacyDefaults';
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

  describe('升级前导出的 login-* 默认值(历史快照迁移)', () => {
    /** 某个模式下「旧版导出的快照」:前 N 个有历史值的登录 token 各取一个旧值。 */
    function legacySnapshot(type: 'light' | 'dark'): Record<string, string> {
      const entries = Object.entries(legacyTable.defaults)
        .map(([id, slots]) => [id, slots[type][0]] as const)
        .filter((entry): entry is readonly [string, string] => entry[1] !== undefined);
      return Object.fromEntries(entries.slice(0, LEGACY_SNAPSHOT_MIN_MATCHES + 2));
    }

    it('旧快照:丢弃等于本模式历史默认值的 override,用户改过的值与非登录色原样保留', () => {
      const snapshot = legacySnapshot('light');
      expect(Object.keys(snapshot).length).toBeGreaterThan(LEGACY_SNAPSHOT_MIN_MATCHES);
      const out = normalizeLocalThemeColors(
        { ...snapshot, surface: '#111111', 'login-control-bg': '#123456' }, // 后一项是用户自己改过的
        'light',
      );
      expect(out).toEqual({ surface: '#111111', 'login-control-bg': '#123456' });
    });

    it('覆盖更早几代:10-23 前的文字实色、10-01 前的画布底,否则旧值会压在新面板上', () => {
      expect(
        normalizeLocalThemeColors(
          { ...legacySnapshot('dark'), 'login-secondary-text': '#6F6F6F', 'login-bg-base': '#1F1F1E' },
          'dark',
        ),
      ).toEqual({});
      expect(
        normalizeLocalThemeColors(
          { ...legacySnapshot('light'), 'login-title-text': '#252222', 'login-bg-base': '#EDEDED' },
          'light',
        ),
      ).toEqual({});
    });

    it('rgba 数字写法不同(0.5 与 0.50)也能识别', () => {
      expect(
        normalizeLocalThemeColors(
          { ...legacySnapshot('light'), 'login-overlay-button-pressed': 'rgba(0,0,0,0.5)' },
          'light',
        ),
      ).toEqual({});
    });

    it('只比对本模式的历史值:深色快照里混入的历史亮色值不被丢弃,反之亦然', () => {
      expect(
        normalizeLocalThemeColors({ ...legacySnapshot('dark'), 'login-panel-bg': '#FBFBFB' }, 'dark'),
      ).toEqual({ 'login-panel-bg': '#FBFBFB' });
      expect(
        normalizeLocalThemeColors({ ...legacySnapshot('light'), 'login-panel-bg': '#312F2F' }, 'light'),
      ).toEqual({ 'login-panel-bg': '#312F2F' });
    });

    it('稀疏手写主题,或本版本新建的副本里零星几个有意设成历史值的 override,原样保留', () => {
      const sparse = { 'login-panel-bg': '#FBFBFB', 'login-secondary-text': '#6F6F6F' };
      expect(normalizeLocalThemeColors(sparse, 'light')).toBe(sparse);
      // 新建副本:全部登录色是当前值(不在历史表里),用户只改了一个为历史值
      const freshCopy = {
        ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`login-current-${i}`, '#abcdef'])),
        'login-panel-bg': '#FBFBFB',
      };
      expect(normalizeLocalThemeColors(freshCopy, 'light')).toBe(freshCopy);
    });

    it('没有传主题模式时不迁移;幂等,没有可迁移项时返回同一个对象', () => {
      const snapshot = legacySnapshot('light');
      expect(normalizeLocalThemeColors(snapshot)).toBe(snapshot);
      const colors = { surface: '#111111', 'login-control-bg': '#123456' };
      expect(normalizeLocalThemeColors(colors, 'light')).toBe(colors);
      const once = normalizeLocalThemeColors({ ...snapshot, surface: '#111111' }, 'light');
      expect(normalizeLocalThemeColors(once, 'light')).toEqual(once);
    });
  });
});
