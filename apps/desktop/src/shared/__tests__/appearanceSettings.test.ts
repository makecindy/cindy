import { describe, expect, it } from 'vitest';

import {
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_TERMINAL_FONT_FAMILY,
  clampAppearanceTerminalSize,
  normalizeAppearanceSettings,
} from '../appearanceSettings';

describe('terminal appearance settings', () => {
  it('adds the existing terminal defaults to old settings without inheriting code fonts', () => {
    const oldSettings = {
      uiFamily: 'Inter', codeFamily: 'JetBrains Mono', uiSize: 16, codeSize: 22, windowZoom: 1.2,
    };
    expect(normalizeAppearanceSettings(oldSettings)).toEqual({
      ...DEFAULT_APPEARANCE_SETTINGS, ...oldSettings, terminalFamily: '', terminalSize: 13,
    });
    expect(DEFAULT_TERMINAL_FONT_FAMILY).toBe(
      '"SF Mono", Menlo, Monaco, "Cascadia Code", "Courier New", monospace',
    );
  });

  it('normalizes terminal input without changing unrelated defaults', () => {
    expect(normalizeAppearanceSettings({ terminalFamily: '  Menlo  ', terminalSize: 18.6 })).toEqual({
      ...DEFAULT_APPEARANCE_SETTINGS, terminalFamily: 'Menlo', terminalSize: 19,
    });
    expect(normalizeAppearanceSettings({ terminalFamily: 3, terminalSize: '19' })).toEqual(
      DEFAULT_APPEARANCE_SETTINGS,
    );
    expect(normalizeAppearanceSettings({ terminalFamily: 'x'.repeat(300) }).terminalFamily).toHaveLength(256);
  });

  it.each([
    [9, 10], [25, 24], [13.6, 14], [NaN, 13], [Infinity, 13], [-Infinity, 13],
  ])('clamps terminal size %s to %s', (input, expected) => {
    expect(clampAppearanceTerminalSize(input)).toBe(expected);
  });
});
