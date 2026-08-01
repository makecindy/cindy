import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { colorRegistry } from '../themes/color-registry';
import '../themes/colors';
import { isProtectedToken } from '../../shared/theme-import/protected-tokens';

const globalsSource = readFileSync(resolve(__dirname, '..', 'styles', 'globals.css'), 'utf8');
const editorThemeSource = readFileSync(
  resolve(__dirname, '..', 'components', 'markdown', 'codemirrorGithubTheme.ts'),
  'utf8',
);

/**
 * 宿主文字选中后把焦点移进插件 webview 时,Chromium 会把未样式化的原生选区
 * 改成很深的 inactive 色。这里锁住全局接线、编辑器一致性与双模式 token,
 * 防止选区仍在却再次看起来像被取消。
 */
describe('global text selection color', () => {
  it('uses the dedicated selection token for native host selections', () => {
    expect(globalsSource).toMatch(
      /::selection\s*\{\s*background:\s*var\(--text-selection-bg\);\s*\}/,
    );
  });

  it('defines the selection token for both themes from the stable focus blue', () => {
    expect(colorRegistry.resolveDefault('text-selection-bg', 'light')).toBe(
      'var(--focus-ring-soft)',
    );
    expect(colorRegistry.resolveDefault('text-selection-bg', 'dark')).toBe(
      'var(--focus-ring-soft)',
    );
  });

  it('keeps CodeMirror selections aligned with the native host selection', () => {
    expect(editorThemeSource).not.toContain("background: 'var(--focus-ring-soft)");
    expect(editorThemeSource.match(/background: 'var\(--text-selection-bg\)/g)).toHaveLength(6);
  });

  it('keeps imported themes from replacing the selection visibility color', () => {
    expect(isProtectedToken('text-selection-bg')).toBe(true);
  });
});
