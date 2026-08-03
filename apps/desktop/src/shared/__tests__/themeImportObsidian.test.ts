import { describe, expect, it } from 'vitest';

import { convertObsidianTheme } from '../theme-import';
import { toHex } from '../theme-import/color';
import {
  collectCssRules,
  collectObsidianVars,
  extractObsidianPalette,
  resolveVarValue,
} from '../theme-import/obsidian';
import { paletteToHex } from '../theme-import/vscode';

/** 覆盖真实 Obsidian 主题里常见的写法：色阶变量、var 解引用、hsl 拼装、color-mix。 */
const THEME_CSS = `
/* Some Theme */
body {
  --color-base-00: #1e1e1e;
  --font-text-theme: Inter, sans-serif;
  /* Obsidian v1 常见写法：accent 拆成 h/s/l 三个变量再拼装 */
  --accent-h: 254;
  --accent-s: 80%;
  --accent-l: 68%;
}
.theme-dark {
  --background-primary: var(--color-base-00);
  --background-secondary: #252525;
  --background-modifier-hover: #2a2a2a;
  --background-secondary-alt: #303030;
  --background-modifier-border: #333;
  --text-normal: #dcddde;
  --text-muted: #999999;
  --text-faint: #666666;
  --interactive-accent: hsl(var(--accent-h), var(--accent-s), var(--accent-l));
  --interactive-accent-hover: #6a5acd;
  --h1-color: #e06c75;
  --h2-color: #61afef;
  --bold-color: #d19a66;
}
.theme-light {
  --background-primary: #ffffff;
  --background-secondary: #f5f5f5;
  --text-normal: #222222;
  --text-muted: #6b6b6b;
  --interactive-accent: #7b6cd9;
  --background-modifier-border: color-mix(in srgb, #000 12%, transparent);
}
@media (min-width: 400px) {
  .theme-dark {
    --divider-color: #444444;
  }
}
.some-plugin-widget {
  --background-primary: #ff0000;
}
`;

const UNSATISFIABLE_MODE_VARS = `
  --background-primary: #000000;
  --background-secondary: #ffffff;
  --background-modifier-hover: #777777;
  --background-secondary-alt: #666666;
  --background-modifier-border: #555555;
  --text-normal: #dddddd;
  --text-muted: #777777;
  --text-faint: #777777;
  --interactive-accent: #666666;
`;

const VALID_MODE_VARS = {
  dark: `
    --background-primary: #1e1e1e;
    --background-secondary: #252525;
    --background-modifier-hover: #2a2a2a;
    --background-secondary-alt: #303030;
    --background-modifier-border: #333333;
    --text-normal: #dcddde;
    --text-muted: #999999;
    --text-faint: #666666;
    --interactive-accent: #7b6cd9;
  `,
  light: `
    --background-primary: #ffffff;
    --background-secondary: #f5f5f5;
    --background-modifier-hover: #eeeeee;
    --background-secondary-alt: #e5e5e5;
    --background-modifier-border: #d7d7d7;
    --text-normal: #222222;
    --text-muted: #6b6b6b;
    --text-faint: #999999;
    --interactive-accent: #7b6cd9;
  `,
} as const;

describe('theme-import · CSS 规则扫描', () => {
  it('切出顶层规则并递归展开 at-rule', () => {
    const rules = collectCssRules(THEME_CSS);
    const selectors = rules.map((r) => r.selector);
    expect(selectors).toContain('body');
    expect(selectors).toContain('.theme-dark');
    expect(selectors).toContain('.theme-light');
    // @media 内的 .theme-dark 被递归提出来（同名选择器出现两次）。
    expect(selectors.filter((s) => s === '.theme-dark')).toHaveLength(2);
    // @media 自身不作为规则留下。
    expect(selectors.some((s) => s.startsWith('@'))).toBe(false);
  });

  it('落单右括号不会让扫描崩掉', () => {
    expect(() => collectCssRules('} .a { --x: 1; }')).not.toThrow();
    expect(collectCssRules('} .a { --x: 1; }').map((r) => r.selector)).toContain('.a');
  });

  // 回归:块深度曾按裸字符数,字符串里的大括号会让边界错位,把后面的主题块整段吞掉。
  it('字符串字面量里的大括号不算块边界', () => {
    const css = `
      .theme-dark::before { content: "{"; --a: 1; }
      .theme-light { --background-primary: #ffffff; }
    `;
    const selectors = collectCssRules(css).map((r) => r.selector);
    expect(selectors).toContain('.theme-light');
    const light = collectCssRules(css).find((r) => r.selector === '.theme-light');
    expect(light?.body).toContain('--background-primary');
  });

  it('单引号与右大括号字符串同样不破坏边界', () => {
    const css = `
      .x { content: '}'; }
      .theme-dark { --background-primary: #101010; }
    `;
    const dark = collectCssRules(css).find((r) => r.selector === '.theme-dark');
    expect(dark?.body).toContain('--background-primary');
  });

  it('选择器属性值里的大括号也不破坏边界', () => {
    const css = `
      [data-x="{"] { --a: 1; }
      .theme-dark { --background-primary: #101010; }
    `;
    const dark = collectCssRules(css).find((r) => r.selector === '.theme-dark');
    expect(dark?.body).toContain('--background-primary');
  });

  it('带大括号的 data URL 不吞掉后续主题块（端到端）', () => {
    const css = `
      .cm-line { background-image: url("data:image/svg+xml,%3Csvg%3E{}%3C/svg%3E"); }
      .theme-dark { --background-primary: #1e1e1e; --text-normal: #dcddde; }
      .theme-light { --background-primary: #ffffff; --text-normal: #222222; }
    `;
    const result = convertObsidianTheme(css, 'Braced');
    expect(result).not.toBeNull();
    expect(result!.themes.map((t) => t.type).sort()).toEqual(['dark', 'light']);
  });
});

describe('theme-import · var() 解引用', () => {
  const vars = new Map([
    ['--a', 'var(--b)'],
    ['--b', '#123456'],
    ['--loop', 'var(--loop)'],
  ]);

  it('多层引用逐层展开', () => {
    expect(resolveVarValue('var(--a)', vars)).toBe('#123456');
  });

  it('未定义变量走 fallback', () => {
    expect(resolveVarValue('var(--missing, #abcdef)', vars)).toBe('#abcdef');
  });

  it('未定义且无 fallback 时原样保留（由调用方判失败）', () => {
    expect(resolveVarValue('var(--missing)', vars)).toBe('var(--missing)');
  });

  it('自引用不会死循环', () => {
    expect(() => resolveVarValue('var(--loop)', vars)).not.toThrow();
  });
});

describe('theme-import · 变量收集与模式划分', () => {
  const modes = collectObsidianVars(THEME_CSS);

  it('产出 dark 与 light 两套', () => {
    expect(modes.map((m) => m.type).sort()).toEqual(['dark', 'light']);
  });

  it('body/:root 的基底变量并入每个模式', () => {
    const dark = modes.find((m) => m.type === 'dark')!;
    expect(dark.vars.get('--color-base-00')).toBe('#1e1e1e');
  });

  it('@media 里的主题块变量也被收进来', () => {
    const dark = modes.find((m) => m.type === 'dark')!;
    expect(dark.vars.get('--divider-color')).toBe('#444444');
  });

  it('组件局部选择器的同名变量不污染全局色板', () => {
    const dark = modes.find((m) => m.type === 'dark')!;
    // .some-plugin-widget 里的 --background-primary: #ff0000 必须被忽略。
    expect(dark.vars.get('--background-primary')).toBe('var(--color-base-00)');
  });
});

describe('theme-import · Obsidian 色板抽取', () => {
  const modes = collectObsidianVars(THEME_CSS);
  const dark = extractObsidianPalette(modes.find((m) => m.type === 'dark')!)!;
  const light = extractObsidianPalette(modes.find((m) => m.type === 'light')!)!;

  it('dark：var 解引用后拿到正确底色', () => {
    expect(paletteToHex(dark.palette).surface).toBe('#1e1e1e');
  });

  it('dark：官方变量逐项映射', () => {
    const hex = paletteToHex(dark.palette);
    expect(hex.elevated).toBe('#252525');
    expect(hex.hover).toBe('#2a2a2a');
    expect(hex.chip).toBe('#303030');
    expect(hex.border).toBe('#333333');
    expect(hex.textPrimary).toBe('#dcddde');
    expect(hex.textSecondary).toBe('#999999');
    expect(hex.textTertiary).toBe('#666666');
  });

  it('dark：hsl(var(--h), var(--s), var(--l)) 拼装形态能求值', () => {
    // 三个分量先解引用成 254 / 80% / 68%，再按 hsl() 换算成 sRGB。
    expect(paletteToHex(dark.palette).accentPrimary).toBe(toHex({ r: 139, g: 108, b: 239 }));
    expect(paletteToHex(dark.palette).accentDeep).toBe('#6a5acd');
  });

  it('dark：标题色与加粗色被读出（缺席的层级留空）', () => {
    expect(dark.markdown.headings?.[0]).toEqual({ r: 224, g: 108, b: 117 });
    expect(dark.markdown.headings?.[1]).toEqual({ r: 97, g: 175, b: 239 });
    expect(dark.markdown.headings?.[2]).toBeNull();
    expect(dark.markdown.strong).toEqual({ r: 209, g: 154, b: 102 });
  });

  it('light：color-mix() 无法求值时记入 unresolved 并改走派生', () => {
    expect(light.unresolved).toContain('--background-modifier-border');
    expect(light.derivedRoles).toContain('border');
  });

  it('light：没有标题色变量时不产出 Markdown 源', () => {
    expect(light.markdown.headings).toBeUndefined();
    expect(light.markdown.strong).toBeUndefined();
  });

  it('拿不到背景色时返回 null（不硬造主题）', () => {
    const vars = new Map([['--text-normal', '#fff']]);
    expect(extractObsidianPalette({ type: 'dark', vars })).toBeNull();
  });
});

describe('theme-import · Obsidian 端到端转换', () => {
  const result = convertObsidianTheme(THEME_CSS, 'Some Theme');

  it('双态 CSS 产出 light + dark 两个主题，同名', () => {
    expect(result).not.toBeNull();
    expect(result!.themes).toHaveLength(2);
    expect(result!.themes.map((t) => t.type).sort()).toEqual(['dark', 'light']);
    expect(new Set(result!.themes.map((t) => t.name))).toEqual(new Set(['Some Theme']));
  });

  it('每个产物都是完整 token map', () => {
    for (const theme of result!.themes) {
      expect(Object.keys(theme.colors).length).toBeGreaterThan(80);
      expect(theme.colors.surface).toMatch(/^#[0-9a-f]{6}$/);
      expect(theme.colors['surface-hsl']).toMatch(/^\d+ \d+% \d+%$/);
    }
  });

  it('Markdown 标题色只出现在提供了它的那个模式里', () => {
    const dark = result!.themes.find((t) => t.type === 'dark')!;
    const light = result!.themes.find((t) => t.type === 'light')!;
    expect(dark.colors['md-h1-fg']).toBe('#e06c75');
    expect(light.colors['md-h1-fg']).toBeUndefined();
  });

  it('报告合并了两个模式的缺口', () => {
    expect(result!.report.source).toBe('obsidian');
    expect(result!.report.unresolved).toContain('--background-modifier-border');
    expect(result!.report.derivedRoles.length).toBeGreaterThan(0);
  });

  it('单态 CSS 按背景亮度判定模式', () => {
    const single = convertObsidianTheme(':root { --background-primary: #ffffff; }', 'X');
    expect(single!.themes).toHaveLength(1);
    expect(single!.themes[0].type).toBe('light');
  });

  it.each([
    ['light', 'dark'],
    ['dark', 'light'],
  ] as const)(
    '%s 模式色板不可满足时保留成功的 %s 模式',
    (failedMode, successfulMode) => {
      const css = `
        .theme-${failedMode} { ${UNSATISFIABLE_MODE_VARS} }
        .theme-${successfulMode} { ${VALID_MODE_VARS[successfulMode]} }
      `;

      const partial = convertObsidianTheme(css, 'Partial Theme');

      expect(partial).not.toBeNull();
      expect(partial!.themes.map((theme) => theme.type)).toEqual([successfulMode]);
      expect(partial!.report.unresolved).toContain(`mode:${failedMode}`);
    },
  );

  it('没有任何主题变量的 CSS 返回 null', () => {
    expect(convertObsidianTheme('.foo { color: red; }', 'X')).toBeNull();
    expect(convertObsidianTheme('', 'X')).toBeNull();
  });
});
