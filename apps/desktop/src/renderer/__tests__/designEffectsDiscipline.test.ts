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
 * 不扫 CSS 与行内 style 里的 box-shadow 和 HSL 颜色：它们目前都走登记 token、细线或 hsl()，
 * 有回退时再扩。`sidebar-item-active-*` 在 Cindy 是实色、其它主题是 HSL 通道，也不在检测范围。
 */

const RENDERER_ROOT = join(__dirname, '..');
const TAILWIND_CONFIG = join(RENDERER_ROOT, '../../tailwind.config.ts');

type Registry = Record<string, { count: number; reason: string }>;

/** 浮层阴影 token：§6 登记，写法必须带 `shadow:` 类型。 */
const REGISTERED_SHADOW_TOKENS = new Set(['shadow-menu', 'cmd-palette-shadow']);

/** 每一层都不模糊的内描边、外描边与细线，不算阴影。 */
const HAIRLINE_LAYER = /^(?:inset_)?-?[\d.]+(?:px)?_-?[\d.]+(?:px)?_0(?:px)?(?:_-?[\d.]+(?:px)?)?_/;

const SHADOW_REGISTRY: Registry = {
  'components/branding/ThemeBrandLockup.tsx': { count: 1, reason: '品牌图标的投影' },
  'components/settings/WorkLouderCodexKeyboardLayout.tsx': { count: 1, reason: '硬件示意图的摇杆帽' },
  'features/cc-agent/workdir-browse/PdfPreview.tsx': { count: 1, reason: '白色 PDF 页面与浅色底几乎同色，靠阴影分出纸张边界' },
};

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

/** 这些是没有 Button 变体的裸按钮框，`enabled:hover:` 不会输给变体。 */
const RAW_BUTTON_FRAMES: Registry = {
  'components/sidebar/GhostMainViewNavEntries.tsx': { count: 2, reason: '裸按钮框的悬停与按下' },
  'components/sidebar/SidebarIconButton.tsx': { count: 2, reason: '裸按钮框的悬停与按下' },
  'components/title-bar/ChromeIconButton.tsx': { count: 2, reason: '裸按钮框的悬停与按下' },
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

/** 默认值是 HSL 三元组的 token，加上 Tailwind 配置里按 `hsl(var(--x))` 消费的 token。 */
function hslFormatTokens(): Set<string> {
  const triplet = /^[\d.]+\s+[\d.]+%\s+[\d.]+%/;
  const fromDefaults = colorRegistry.getColors()
    .filter(({ id }) => {
      const values = [colorRegistry.resolveDefault(id, 'light'), colorRegistry.resolveDefault(id, 'dark')];
      return values.some((value) => typeof value === 'string' && triplet.test(value));
    })
    .map(({ id }) => id);
  const fromTailwind = [...readFileSync(TAILWIND_CONFIG, 'utf8').matchAll(/hslVar\('([a-z0-9-]+)'\)/g)].map((match) => match[1]);
  return new Set([...fromDefaults, ...fromTailwind]);
}

const FIXES = {
  untypedShadow: '浮层改成 shadow-[shadow:var(--shadow-menu)]，页内元素删掉（DESIGN.md §6）',
  shadow: '浮层改成 shadow-[shadow:var(--shadow-menu)]，页内元素删掉；确需保留先有设计决定，再登记到 SHADOW_REGISTRY 和 §6',
  gradient: '改成纯色；确需保留先有设计决定，再登记到 GRADIENT_REGISTRY 和 §2 / §7',
  invalidHslColor: '这个 token 是 HSL 三元组，改成 hsl(var(--x)) 或对应的 Tailwind 颜色类',
  losingButtonState: '会输给 Button 变体：用 palette，或写成 enabled:[&:not([aria-disabled=true])]:hover:',
} as const;

type EffectKind = keyof typeof FIXES;

interface Finding {
  kind: EffectKind;
  line: number;
  value: string;
}

function isRegisteredArbitraryShadow(value: string): boolean {
  const token = /^shadow:var\(--([a-z0-9-]+)\)$/.exec(value)?.[1];
  if (token) return REGISTERED_SHADOW_TOKENS.has(token);
  return value.split(/,(?![^(]*\))/).every((layer) => HAIRLINE_LAYER.test(layer));
}

function isCommentLine(source: string, index: number): boolean {
  const line = source.slice(source.lastIndexOf('\n', index) + 1, index).trimStart();
  return line.startsWith('//') || line.startsWith('*') || line.startsWith('/*');
}

function findEffects(source: string, hslTokens: ReadonlySet<string>): Finding[] {
  const findings: Finding[] = [];
  const collect = (kind: EffectKind, pattern: RegExp, keep: (match: RegExpMatchArray) => boolean = () => true) => {
    for (const match of source.matchAll(pattern)) {
      if (keep(match)) {
        findings.push({ kind, line: source.slice(0, match.index).split('\n').length, value: match[0] });
      }
    }
  };
  collect('untypedShadow', /(?<![\w-])shadow-\[var\([^\]\s]+\]/g);
  collect('shadow', /(?<![\w-])shadow-(?:sm|md|lg|xl|2xl|inner)(?![\w-])/g);
  collect('shadow', /(?<![\w-])shadow-\[((?!var\()[^\]\s]+)\]/g, (match) => !isRegisteredArbitraryShadow(match[1]));
  collect('shadow', /\bdrop-shadow(?:\(|-[a-z[])/g);
  // 无后缀的 `shadow`（含 `hover:shadow`）也是预设阴影；注释里的英文单词不算。
  collect('shadow', /(?<=[\s'"`])(?:[\w-]+:|\[[^\]\s]+\]:)*shadow(?=[\s'"`])/g, (match) => !isCommentLine(source, match.index ?? 0));
  collect('gradient', /\b(?:linear|radial|conic)-gradient\(|\bbg-gradient-to-/g);
  collect(
    'invalidHslColor',
    /(?<![\w-])(?:text|bg|border(?:-[trblxy])?|ring|fill|stroke|outline|from|to|via|caret|accent|decoration|placeholder|divide)-\[var\(--([a-z0-9-]+)\)\]/g,
    (match) => hslTokens.has(match[1]),
  );
  collect('invalidHslColor', /\[--button-face-(?:bg|border):var\(--([a-z0-9-]+)\)\]/g, (match) => hslTokens.has(match[1]));
  collect('losingButtonState', /\benabled:(?:hover|active):\[--button-face-/g);
  return findings;
}

const HSL_TOKENS = hslFormatTokens();
const files = sourceFiles(RENDERER_ROOT).map((path) => ({
  file: relative(RENDERER_ROOT, path).split(sep).join('/'),
  findings: findEffects(readFileSync(path, 'utf8'), HSL_TOKENS),
}));

const describeFinding = (file: string, { kind, line, value }: Finding) => `${file}:${line} ${value} → ${FIXES[kind]}`;

/** 登记表与实际一一对应：多出来的逐条列出位置和改法，已不使用的要移出登记。 */
function registryDrift(kinds: readonly EffectKind[], registry: Registry = {}): string[] {
  const used = files
    .map(({ file, findings }) => ({ file, matches: findings.filter(({ kind }) => kinds.includes(kind)) }))
    .filter(({ matches }) => matches.length > 0);
  const extra = used
    .filter(({ file, matches }) => registry[file]?.count !== matches.length)
    .flatMap(({ file, matches }) => [
      `${file}: ${matches.length} 处（登记 ${registry[file]?.count ?? 0}）`,
      ...matches.map((match) => describeFinding(file, match)),
    ]);
  const stale = Object.keys(registry)
    .filter((file) => !used.some((entry) => entry.file === file))
    .map((file) => `${file}: 已无使用，移出登记`);
  return [...extra, ...stale];
}

describe('阴影、渐变与写法失效门禁', () => {
  it('规则本身能拦住已知的错误写法', () => {
    const hsl = new Set(['destructive']);
    const kinds = (source: string) => findEffects(source, hsl).map(({ kind }) => kind);

    expect(kinds("'shadow-[var(--shadow-menu)]'")).toEqual(['untypedShadow']);
    expect(kinds("'shadow-md hover:shadow-lg'")).toEqual(['shadow', 'shadow']);
    expect(kinds("'shadow' 'rounded hover:shadow'")).toEqual(['shadow', 'shadow']);
    expect(kinds("// no shadow here\n * inset shadow 画在盒内\n'shadow-none'")).toEqual([]);
    expect(kinds("'shadow-[0_4px_16px_black] shadow-[shadow:var(--unknown)]'")).toEqual(['shadow', 'shadow']);
    expect(kinds("'shadow-[0_1px_0_#fff,0_8px_24px_#000]'")).toEqual(['shadow']);
    expect(kinds("'drop-shadow-md' filter: 'drop-shadow(0 1px 2px red)'")).toEqual(['shadow', 'shadow']);
    expect(kinds("'bg-gradient-to-t' 'linear-gradient(red, blue)'")).toEqual(['gradient', 'gradient']);
    expect(kinds("'text-[var(--destructive)] [--button-face-bg:var(--destructive)]'")).toEqual([
      'invalidHslColor',
      'invalidHslColor',
    ]);
    expect(kinds("'enabled:hover:[--button-face-bg:red] dark:enabled:active:[--button-face-bg:red]'")).toEqual([
      'losingButtonState',
      'losingButtonState',
    ]);

    expect(
      kinds(`'shadow-[shadow:var(--shadow-menu)] shadow-none shadow-[inset_0_0_0_1px_var(--x)] shadow-[0_1px_0_var(--x)]
       shadow-[inset_0_-1px_0_red] text-[hsl(var(--destructive))] [--button-face-bg:hsl(var(--destructive))]
       enabled:[&:not([aria-disabled=true])]:hover:[--button-face-bg:red]'`),
    ).toEqual([]);
  });

  it('错误信息带文件、行号和改法', () => {
    const [finding] = findEffects("first line\n'shadow-md'", new Set());
    expect(finding).toEqual({ kind: 'shadow', line: 2, value: 'shadow-md' });
    expect(describeFinding('a.tsx', finding)).toBe(`a.tsx:2 shadow-md → ${FIXES.shadow}`);
  });

  it('不写无类型的 shadow-[var(--x)]：Tailwind 会当成阴影颜色，不产生阴影', () => {
    expect(registryDrift(['untypedShadow'])).toEqual([]);
  });

  it('阴影只留登记例外', () => {
    expect(registryDrift(['shadow'], SHADOW_REGISTRY)).toEqual([]);
  });

  it('渐变不超出 §2 / §7 的登记范围', () => {
    expect(registryDrift(['gradient'], GRADIENT_REGISTRY)).toEqual([]);
  });

  it('HSL 三元组 token 要包 hsl()，不能直接当颜色写', () => {
    expect(registryDrift(['invalidHslColor'])).toEqual([]);
  });

  it('enabled:hover 覆盖只写在裸按钮框上，Button 用 palette 或同修饰符', () => {
    expect(registryDrift(['losingButtonState'], RAW_BUTTON_FRAMES)).toEqual([]);
  });
});
