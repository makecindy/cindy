import { describe, expect, it } from 'vitest';

import { colorRegistry } from '../color-registry';
// import 触发整表注册。
import '../colors';
import { builtinThemes } from '../registry';
import { exportThemeColors } from '../theme-service';

/**
 * Markdown 颜色 token 的"零影响"守卫。
 *
 * 这组 token（h1–h6 + strong）是为外部主题导入（Obsidian `--hN-color` /
 * VSCode `markup.heading`）引入的可覆盖槽位。引入它们之前，这些元素的颜色是从
 * 容器继承来的——`baseComponents` 只给字号字重，不给 color。
 *
 * 因此默认值必须是 `inherit` 而不是 `var(--text-primary)`：后者会让
 * tool card / secondary 文字区里的 Markdown 标题与加粗从弱化色变回主色，那是
 * 实打实的观感改动。本文件断言这条不变量，任何把默认值改成具体色槽的改动都会
 * 在这里失败。
 *
 * 注：blockquote 已不在上述"弱化色容器"之列 —— `msg-blockquote-text` 本身即
 * `--text-primary`（引用常承载本轮最该看的内容，弱化会让它被扫读跳过），引用
 * 语义由左侧竖线承担。这不影响本文件的断言：`md-*` 仍是 `inherit`，仍然继承
 * 容器色，只是那个容器色现在是主色。
 *
 * 三条断言合起来构成机械证明：默认值恒为 `inherit` + 没有内置主题 override +
 * 每个内置主题导出后仍解析为 `inherit` ⇒ 所有内置主题渲染出的 `color:
 * var(--md-*)` 都等价于引入前的 `color: inherit`。
 */

const MD_COLOR_TOKENS = [
  'md-h1-fg',
  'md-h2-fg',
  'md-h3-fg',
  'md-h4-fg',
  'md-h5-fg',
  'md-h6-fg',
  'md-strong-fg',
] as const;

describe('Markdown 颜色 token · 默认保持中性', () => {
  it.each(MD_COLOR_TOKENS)('%s 的 light / dark 默认值都是 inherit', (id) => {
    expect(colorRegistry.resolveDefault(id, 'light')).toBe('inherit');
    expect(colorRegistry.resolveDefault(id, 'dark')).toBe('inherit');
  });

  it('没有任何内置主题 override 这组 token', () => {
    const offenders: string[] = [];
    for (const [themeId, theme] of Object.entries(builtinThemes)) {
      const colors = theme.colors as Record<string, string | undefined>;
      for (const id of MD_COLOR_TOKENS) {
        if (colors[id] !== undefined) offenders.push(`${themeId}.${id}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it.each(Object.keys(builtinThemes))(
    '主题 %s 导出后这组 token 仍解析为 inherit（渲染结果与引入前等价）',
    (themeId) => {
      const exported = exportThemeColors(builtinThemes[themeId]);
      for (const id of MD_COLOR_TOKENS) {
        expect(exported[id], `${themeId}.${id}`).toBe('inherit');
      }
    },
  );

  it('registry 里 md- 前缀的 token 只有表格底色与这 7 个文字色', () => {
    const mdTokens = colorRegistry
      .getColors()
      .map((c) => c.id)
      .filter((id) => id.startsWith('md-'))
      .sort();
    expect(mdTokens).toEqual(['md-table-bg', ...MD_COLOR_TOKENS].sort());
  });
});
