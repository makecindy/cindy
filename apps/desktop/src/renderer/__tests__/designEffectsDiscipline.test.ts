import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import { colorRegistry } from '../themes/color-registry';
import '../themes/colors';

/**
 * 阴影、渐变与写法失效的门禁（DESIGN.md §2 Gradient System、§6、§7，2026-11-07 用户裁决）。
 *
 * 这几类写法都能通过编译，界面却静默出错：无类型的 `shadow-[var(--x)]` 被 Tailwind 当成
 * 阴影颜色，不产生阴影；HSL 三元组 token 直接写进 `text-[var(--x)]` 是无效颜色；
 * `enabled:hover:` 的优先级低于 Button 变体，覆盖不生效。清单外的阴影和渐变则让 §6、§7
 * 的封闭清单与代码再次脱节。新增例外须先有设计决定，再登记到这里和对应规范。
 *
 * 不扫 CSS 与行内 style 的 box-shadow：它们目前都走登记 token 或细线，有回退时再扩。
 */

const RENDERER_ROOT = join(__dirname, '..');

/** 浮层阴影 token：§6 登记，写法必须带 `shadow:` 类型。 */
const REGISTERED_SHADOW_TOKENS = new Set(['shadow-menu', 'cmd-palette-shadow']);

/** 不产生模糊的内描边、外描边与细线，不算阴影。 */
const HAIRLINE_SHADOW = /^(?:inset_)?[\d.]+(?:px)?_[\d.]+(?:px)?_0(?:px)?(?:_[\d.]+(?:px)?)?_/;

const PRESET_SHADOW_EXEMPTIONS: Record<string, { count: number; reason: string }> = {
  'features/cc-agent/workdir-browse/PdfPreview.tsx': { count: 1, reason: '白色 PDF 页面与浅色底几乎同色，靠阴影分出纸张边界' },
};

const ARBITRARY_SHADOW_EXEMPTIONS: Record<string, { count: number; reason: string }> = {
  'components/settings/WorkLouderCodexKeyboardLayout.tsx': { count: 1, reason: '硬件示意图的摇杆立体感' },
};

/** 只能写在没有 Button 变体的裸按钮框上；Button 要用 palette 或同修饰符。 */
const RAW_BUTTON_FRAMES = new Set([
  'components/sidebar/GhostMainViewNavEntries.tsx',
  'components/sidebar/SidebarIconButton.tsx',
  'components/title-bar/ChromeIconButton.tsx',
]);

const GRADIENT_REGISTRY: Record<string, { count: number; reason: string }> = {
  'components/chat/ChatAudioCard.tsx': { count: 1, reason: '没有封面的音频占位（2026-11-07 用户裁决保留）' },
  'components/chat/GhostToolCard.tsx': { count: 1, reason: 'GhostTool 闪光（§15.4）' },
  'components/chat/JumpToBottomChip.tsx': { count: 1, reason: '单色叠加悬停，不是视觉渐变' },
  'components/chat/NewMessageIndicator.tsx': { count: 1, reason: '单色叠加悬停，不是视觉渐变' },
  'components/chat/PlanReviewBubble.tsx': { count: 1, reason: '折叠正文的边缘渐隐遮罩' },
  'components/login/LoginControls.tsx': { count: 1, reason: '单色叠加悬停，不是视觉渐变' },
  'components/settings/WorkLouderCodexKeyboardLayout.tsx': { count: 1, reason: '硬件示意图的旋钮高光' },
  'features/cc-agent/CCAgentSessionView.tsx': { count: 1, reason: '输入框上方的边缘渐隐' },
  'features/cc-agent/CCAgentSidebarUpper.tsx': { count: 2, reason: '侧栏列表的边缘渐隐遮罩' },
  'features/cc-agent/RolePillDropdown.tsx': { count: 2, reason: '横向滚动两端的边缘渐隐' },
  'features/right-sidebar/TabBar.tsx': { count: 1, reason: '标签栏横向滚动的边缘渐隐遮罩' },
  'features/right-sidebar/plugins/review/DiffViewer/ImageDiffPreview.tsx': { count: 4, reason: '透明底棋盘格，不是视觉渐变' },
  'styles/globals.css': { count: 13, reason: '字标扫光、模型预算色条（§15.4）、列表与输入框的边缘渐隐遮罩、单色叠层' },
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return ['__tests__', '__mocks__', 'vendor', 'themes', 'generated'].includes(name) ? [] : sourceFiles(path);
    }
    return /\.(?:tsx?|css)$/.test(name) && !/\.(?:test|spec)\./.test(name) ? [path] : [];
  });
}

/** 注释不算使用，也不改变行号。 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, '');
}

const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

function hslFormatTokens(): Set<string> {
  const triplet = /^[\d.]+\s+[\d.]+%\s+[\d.]+%/;
  const ids = colorRegistry.getColors()
    .filter(({ id }) => {
      const values = [colorRegistry.resolveDefault(id, 'light'), colorRegistry.resolveDefault(id, 'dark')];
      return values.some((value) => typeof value === 'string' && triplet.test(value));
    })
    .map(({ id }) => id);
  return new Set(ids);
}

interface EffectCounts {
  untypedShadows: string[];
  presetShadows: number;
  unregisteredShadows: string[];
  gradients: number;
  invalidHslColors: string[];
  losingButtonStates: number;
}

function countEffects(source: string, hslTokens: ReadonlySet<string>): EffectCounts {
  const text = stripComments(source);
  const arbitrary = [...text.matchAll(/(?<![\w-])shadow-\[([^\]\s]+)\]/g)].map((match) => match[1]);
  return {
    untypedShadows: arbitrary.filter((value) => value.startsWith('var(')),
    presetShadows: count(text, /(?<![\w-])shadow-(?:sm|md|lg|xl|2xl|inner)(?![\w-])/g),
    unregisteredShadows: arbitrary.filter((value) => {
      if (value.startsWith('var(') || HAIRLINE_SHADOW.test(value)) return false;
      const token = /^shadow:var\(--([a-z0-9-]+)\)$/.exec(value)?.[1];
      return !token || !REGISTERED_SHADOW_TOKENS.has(token);
    }),
    gradients: count(text, /\b(?:linear|radial|conic)-gradient\(|\bbg-gradient-to-/g),
    invalidHslColors: [
      ...text.matchAll(/(?<![\w-])(?:text|bg|border(?:-[trblxy])?|ring|fill|stroke|outline|from|to|via|caret|accent|decoration|placeholder|divide)-\[var\(--([a-z0-9-]+)\)\]/g),
    ]
      .filter((match) => hslTokens.has(match[1]))
      .map((match) => match[0]),
    losingButtonStates: count(text, /(?<![\w\]-]:)enabled:(?:hover|active):\[--button-face-/g),
  };
}

const HSL_TOKENS = hslFormatTokens();
const files = sourceFiles(RENDERER_ROOT).map((path) => ({
  file: relative(RENDERER_ROOT, path).split(sep).join('/'),
  effects: countEffects(readFileSync(path, 'utf8'), HSL_TOKENS),
}));

function exemptionDrift(
  registry: Record<string, { count: number }>,
  read: (effects: EffectCounts) => number,
): string[] {
  const actual = files.filter(({ effects }) => read(effects) > 0);
  const extra = actual
    .filter(({ file, effects }) => registry[file]?.count !== read(effects))
    .map(({ file, effects }) => `${file}: ${read(effects)}（登记 ${registry[file]?.count ?? 0}）`);
  const stale = Object.keys(registry)
    .filter((file) => !actual.some((entry) => entry.file === file))
    .map((file) => `${file}: 已无使用，移出登记`);
  return [...extra, ...stale];
}

describe('阴影、渐变与写法失效门禁', () => {
  it('规则本身能拦住已知的错误写法', () => {
    const hsl = new Set(['destructive']);
    const bad = countEffects(
      `'shadow-[var(--shadow-menu)] shadow-md hover:shadow-lg shadow-[0_4px_16px_black] shadow-[shadow:var(--unknown)]
       bg-gradient-to-t linear-gradient(red, blue) text-[var(--destructive)] enabled:hover:[--button-face-bg:red]'`,
      hsl,
    );
    expect(bad.untypedShadows).toHaveLength(1);
    expect(bad.presetShadows).toBe(2);
    expect(bad.unregisteredShadows).toHaveLength(2);
    expect(bad.gradients).toBe(2);
    expect(bad.invalidHslColors).toEqual(['text-[var(--destructive)]']);
    expect(bad.losingButtonStates).toBe(1);

    const good = countEffects(
      `'shadow-[shadow:var(--shadow-menu)] shadow-none shadow-[inset_0_0_0_1px_var(--x)] shadow-[0_1px_0_var(--x)]
       text-[hsl(var(--destructive))] enabled:[&:not([aria-disabled=true])]:hover:[--button-face-bg:red]
       // shadow-md 写在注释里不算
       '`,
      hsl,
    );
    expect(good).toEqual({
      untypedShadows: [],
      presetShadows: 0,
      unregisteredShadows: [],
      gradients: 0,
      invalidHslColors: [],
      losingButtonStates: 0,
    });
  });

  it('不写无类型的 shadow-[var(--x)]：Tailwind 会当成阴影颜色，不产生阴影', () => {
    expect(files.flatMap(({ file, effects }) => effects.untypedShadows.map((value) => `${file}: ${value}`))).toEqual([]);
  });

  it('预设阴影只留登记例外，浮层改用 shadow-[shadow:var(--shadow-menu)]', () => {
    expect(exemptionDrift(PRESET_SHADOW_EXEMPTIONS, (effects) => effects.presetShadows)).toEqual([]);
  });

  it('任意值阴影只能是登记 token 或细线', () => {
    expect(exemptionDrift(ARBITRARY_SHADOW_EXEMPTIONS, (effects) => effects.unregisteredShadows.length)).toEqual([]);
  });

  it('渐变不超出 §2 / §7 的登记范围', () => {
    expect(exemptionDrift(GRADIENT_REGISTRY, (effects) => effects.gradients)).toEqual([]);
  });

  it('HSL 三元组 token 要包 hsl()，不能直接当颜色写', () => {
    expect(files.flatMap(({ file, effects }) => effects.invalidHslColors.map((value) => `${file}: ${value}`))).toEqual([]);
  });

  it('enabled:hover 覆盖只写在裸按钮框上，Button 用 palette 或同修饰符', () => {
    expect(
      files.filter(({ file, effects }) => effects.losingButtonStates > 0 && !RAW_BUTTON_FRAMES.has(file)).map(({ file }) => file),
    ).toEqual([]);
  });
});
