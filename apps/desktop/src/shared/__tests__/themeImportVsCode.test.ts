import { describe, expect, it } from 'vitest';

import { convertVsCodeTheme, detectImportSource } from '../theme-import';
import {
  extractVsCodePalette,
  paletteToHex,
  parseVsCodeThemeJson,
  stripJsonComments,
} from '../theme-import/vscode';

/**
 * fixture 按 One Dark Pro 官方 `OneDark-Pro.json` 的真实结构与色值写（映射依据见
 * `renderer/themes/builtin/one-dark-pro.ts` 顶部的人工移植注释）。
 */
const ONE_DARK_PRO_JSON = JSON.stringify({
  name: 'One Dark Pro',
  type: 'dark',
  colors: {
    'editor.background': '#282c34',
    'editor.foreground': '#abb2bf',
    'sideBar.background': '#21252b',
    'list.hoverBackground': '#2c313a',
    'list.activeSelectionBackground': '#2c313a',
    'panel.border': '#3e4452',
    'editorLineNumber.foreground': '#495162',
    'button.background': '#61afef',
  },
  tokenColors: [
    {
      scope: 'comment',
      settings: { foreground: '#7f848e', fontStyle: 'italic' },
    },
    {
      scope: ['markup.heading', 'entity.name.section'],
      settings: { foreground: '#e06c75' },
    },
    {
      scope: 'markup.bold',
      settings: { foreground: '#d19a66' },
    },
  ],
});

describe('theme-import · jsonc 清理', () => {
  it('去掉行注释与块注释，容忍尾逗号', () => {
    const input = `{
      // 行注释
      "type": "dark", /* 块注释 */
      "colors": {
        "editor.background": "#282c34", // 尾注释
      },
    }`;
    expect(JSON.parse(stripJsonComments(input))).toEqual({
      type: 'dark',
      colors: { 'editor.background': '#282c34' },
    });
  });

  it('不误删字符串里的 // 与 /*', () => {
    const input = '{"a": "https://example.com/x", "b": "/* not a comment */"}';
    expect(JSON.parse(stripJsonComments(input))).toEqual({
      a: 'https://example.com/x',
      b: '/* not a comment */',
    });
  });

  it('不被转义引号骗过', () => {
    const input = '{"a": "say \\" // still string", "b": 1}';
    expect(JSON.parse(stripJsonComments(input))).toEqual({
      a: 'say " // still string',
      b: 1,
    });
  });

  // 回归:尾逗号处理曾用一条全局 replace(/,(\s*[}\]])/g)，它不认字符串边界，
  // 会把 JSON 值里合法的 `, }` / `, ]` 一起吃掉。
  it.each([
    ['{"a": "x, }y"}', { a: 'x, }y' }],
    ['{"a": "x, ]y"}', { a: 'x, ]y' }],
    ['{"a": "trailing, ", "b": 1}', { a: 'trailing, ', b: 1 }],
    ['{"a": "多个,  }  ]  逗号"}', { a: '多个,  }  ]  逗号' }],
  ])('不删字符串字面量里的 %s', (input, expected) => {
    expect(JSON.parse(stripJsonComments(input))).toEqual(expected);
  });

  it('尾逗号后跟行注释时仍能识别（注释先剥、再判尾逗号）', () => {
    const input = `{
      "a": 1, // 说明
      "b": [1, 2,], /* 块注释 */
    }`;
    expect(JSON.parse(stripJsonComments(input))).toEqual({ a: 1, b: [1, 2] });
  });
});

describe('theme-import · VSCode 主题识别', () => {
  it('既无 colors 也无 tokenColors 的 JSON 不是颜色主题', () => {
    expect(parseVsCodeThemeJson('{"foo":1}')).toBeNull();
  });

  it('坏 JSON 返回 null 而不抛', () => {
    expect(parseVsCodeThemeJson('{ not json')).toBeNull();
  });

  it('没有 editor.background 时判不出可用主题', () => {
    const parsed = parseVsCodeThemeJson('{"colors":{"foo.bar":"#fff"}}');
    expect(parsed).not.toBeNull();
    expect(extractVsCodePalette(parsed!, 'x')).toBeNull();
  });

  it('按扩展名判定来源', () => {
    expect(detectImportSource('OneDark-Pro.json')).toBe('vscode');
    expect(detectImportSource('theme.jsonc')).toBe('vscode');
    expect(detectImportSource('theme.css')).toBe('obsidian');
    expect(detectImportSource('readme.md')).toBeNull();
  });
});

describe('theme-import · One Dark Pro 色板抽取', () => {
  const parsed = parseVsCodeThemeJson(ONE_DARK_PRO_JSON);
  const extracted = extractVsCodePalette(parsed!, 'fallback');

  it('直取的角色与官方色值一致（不含派生档）', () => {
    expect(extracted).not.toBeNull();
    const hex = paletteToHex(extracted!.palette);
    expect(hex.surface).toBe('#282c34');
    expect(hex.elevated).toBe('#21252b');
    expect(hex.hover).toBe('#2c313a');
    expect(hex.chip).toBe('#2c313a');
    expect(hex.border).toBe('#3e4452');
    expect(hex.textPrimary).toBe('#abb2bf');
    expect(hex.textSecondary).toBe('#7f848e');
    expect(hex.textDisabled).toBe('#495162');
    expect(hex.accentPrimary).toBe('#61afef');
  });

  it('type 取自源文件声明；name 取自源文件', () => {
    expect(extracted!.type).toBe('dark');
    expect(extracted!.name).toBe('One Dark Pro');
  });

  it('accent soft/deep 是派生档（源主题不提供）', () => {
    expect(extracted!.derivedRoles).not.toContain('surface');
    expect(extracted!.derivedRoles).not.toContain('accentPrimary');
    // dark 下 soft 更亮、deep 更暗。
    const hex = paletteToHex(extracted!.palette);
    expect(hex.accentSoft).not.toBe(hex.accentPrimary);
    expect(hex.accentDeep).not.toBe(hex.accentPrimary);
  });

  it('markup.heading / markup.bold 映射成 Markdown token 源', () => {
    expect(extracted!.markdown.headings).toHaveLength(6);
    expect(extracted!.markdown.headings?.every((c) => c !== null)).toBe(true);
    expect(extracted!.markdown.strong).toEqual({ r: 209, g: 154, b: 102 });
  });
});

describe('theme-import · VSCode 缺键与推导', () => {
  it('只有 editor.background 时其余角色全部推导，且报告如实列出', () => {
    const raw = JSON.stringify({
      name: 'Bare',
      colors: { 'editor.background': '#101010' },
    });
    const parsed = parseVsCodeThemeJson(raw);
    const extracted = extractVsCodePalette(parsed!, 'bare-file');
    expect(extracted).not.toBeNull();
    expect(extracted!.type).toBe('dark'); // 由背景亮度判定
    expect(extracted!.derivedRoles).toEqual(
      expect.arrayContaining([
        'elevated',
        'hover',
        'chip',
        'border',
        'textPrimary',
        'textSecondary',
        'textTertiary',
        'textDisabled',
        'accentPrimary',
      ]),
    );
    expect(extracted!.resolvedRoles).toBe(1);
  });

  it('没有 name 时回退到传入的文件名', () => {
    const parsed = parseVsCodeThemeJson('{"colors":{"editor.background":"#fff"}}');
    expect(extractVsCodePalette(parsed!, 'my-theme')!.name).toBe('my-theme');
  });

  it('浅色背景在未声明 type 时判为 light', () => {
    const parsed = parseVsCodeThemeJson('{"colors":{"editor.background":"#fafafa"}}');
    expect(extractVsCodePalette(parsed!, 'x')!.type).toBe('light');
  });

  it('include 字段计入 unresolved（我们只读单文件）', () => {
    const parsed = parseVsCodeThemeJson(
      '{"include":"./base.json","colors":{"editor.background":"#101010"}}',
    );
    expect(extractVsCodePalette(parsed!, 'x')!.unresolved).toContain('include:./base.json');
  });
});

describe('theme-import · VSCode 端到端转换', () => {
  const result = convertVsCodeTheme(ONE_DARK_PRO_JSON, 'fallback');

  it('产出单个 dark 主题', () => {
    expect(result).not.toBeNull();
    expect(result!.themes).toHaveLength(1);
    expect(result!.themes[0].type).toBe('dark');
    expect(result!.themes[0].name).toBe('One Dark Pro');
  });

  it('token map 里含 Tier1 slot 与 Markdown token，且值来自源主题', () => {
    const colors = result!.themes[0].colors;
    expect(colors.surface).toBe('#282c34');
    expect(colors['text-primary']).toBe('#abb2bf');
    expect(colors['surface-hsl']).toBe('220 13% 18%');
    expect(colors['md-h1-fg']).toBe('#e06c75');
    expect(colors['md-strong-fg']).toBe('#d19a66');
  });

  it('产出里没有任何语义豁免族 token', () => {
    const ids = Object.keys(result!.themes[0].colors);
    expect(ids.filter((id) => id.startsWith('login-'))).toEqual([]);
    expect(ids).not.toContain('destructive');
    expect(ids).not.toContain('warning-accent');
    expect(ids).not.toContain('focus-ring');
  });

  it('报告标注来源为 vscode', () => {
    expect(result!.report.source).toBe('vscode');
    expect(result!.report.resolvedRoles).toBeGreaterThan(5);
  });

  it('非主题 JSON 返回 null', () => {
    expect(convertVsCodeTheme('{"foo":1}', 'x')).toBeNull();
    expect(convertVsCodeTheme('not json at all', 'x')).toBeNull();
  });
});
