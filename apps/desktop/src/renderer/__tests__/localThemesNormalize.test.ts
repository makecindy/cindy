import { describe, expect, it } from 'vitest';

import { normalizeLocalThemeColors } from '../themes/local-themes-normalize';

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
});
