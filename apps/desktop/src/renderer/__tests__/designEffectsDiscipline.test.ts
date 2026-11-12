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
 * `enabled:hover:` 的优先级低于 Button 变体，覆盖不生效；`globals.css` 对所有元素全局
 * `outline: none !important`（其后给输入框写的 `outline: revert` 不带 !important，压不过它），
 * 只写 `focus-visible:outline*` 的控件 Tab 聚焦时什么都不画
 * （§14.2，2026-11 维护者裁决：以规范为准改代码）。清单外的阴影和渐变则让 §6、§7
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
  'styles/globals.css': { count: 14, reason: '字标扫光、折扣模型名的预算渐变（§2、§15.4）、列表与输入框的边缘渐隐遮罩（含桌面背景下消息列表底部的渐隐）、单色叠层' },
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
  invisibleFocus:
    'globals.css 用 !important 压掉了所有元素的 outline，键盘焦点看不见：改成 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]，或换用 Button（DESIGN.md §14.2）',
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

/** 从 openIndex 处的开括号起，返回配对闭括号之后的下标；没有配对时返回 -1。 */
function closingIndex(source: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    if (source[i] === open) depth += 1;
    else if (source[i] === close && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * 匹配所在的 class 区域：同一行内的字符串常量、完整的 className 属性值（引号或花括号，
 * 允许跨行），以及外层 cn/clsx/twMerge(...) 调用（分行写法）。
 */
function classRegionsAround(source: string, index: number): string[] {
  const regions: string[] = [];
  const lineStart = source.lastIndexOf('\n', index) + 1;
  const lineEnd = source.indexOf('\n', index);
  const line = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
  for (const literal of line.matchAll(/(['"`])(?:(?!\1)[^\\]|\\.)*\1/g)) {
    const start = lineStart + (literal.index ?? 0);
    if (start <= index && index < start + literal[0].length) regions.push(literal[0]);
  }
  const before = source.slice(0, index);
  for (const attribute of before.matchAll(/\bclassName\s*=\s*/g)) {
    const at = (attribute.index ?? 0) + attribute[0].length;
    const quote = source[at];
    const end =
      quote === '{'
        ? closingIndex(source, at, '{', '}')
        : quote === '"' || quote === "'" || quote === '`'
          ? source.indexOf(quote, at + 1) + 1
          : 0;
    if (end > index) regions.push(source.slice(at, end));
  }
  for (const call of before.matchAll(/\b(?:cn|clsx|twMerge)\s*\(/g)) {
    const open = (call.index ?? 0) + call[0].length - 1;
    const end = closingIndex(source, open, '(', ')');
    if (end > index) regions.push(source.slice(open, end));
  }
  return regions;
}

/**
 * 只靠 outline 画焦点：同一 class 区域没有 focus-visible 焦点圈兜底。输入元素不例外——
 * globals.css 给 input / textarea / contenteditable 写的 `outline: revert` 不带 !important，
 * 输给前面的 `outline: none !important`，它们的 outline 同样画不出来。
 */
function relyOnlyOnOutline(source: string, index: number): boolean {
  return !classRegionsAround(source, index).some((region) => /focus-visible:(?:[\w-]+:)*ring-/.test(region));
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
  collect(
    'invisibleFocus',
    /(?<![\w-])focus-visible:outline(?!-none)(?:-[^\s'"`]*)?(?:\s+focus-visible:outline(?!-none)(?:-[^\s'"`]*)?)*/g,
    (match) => !isCommentLine(source, match.index ?? 0) && relyOnlyOnOutline(source, match.index ?? 0),
  );
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

  it('焦点规则只拦没有焦点圈兜底的 outline，输入元素也不例外', () => {
    const kinds = (source: string) => findEffects(source, new Set()).map(({ kind }) => kind);
    // Toast ×、附件预览图标按钮等:只写 outline,Tab 聚焦时 outline=none、box-shadow=none。
    expect(kinds('<button className="size-8 focus-visible:outline focus-visible:outline-2">')).toEqual(['invisibleFocus']);
    expect(kinds("const ICON = 'h-8 w-8 focus-visible:outline focus-visible:outline-[var(--focus-ring)]';")).toEqual([
      'invisibleFocus',
    ]);
    expect(kinds("<summary className=\"underline focus-visible:outline-2\">")).toEqual(['invisibleFocus']);
    // 输入元素的 outline 也被 !important 压掉(PdfPreview 页码输入框曾因豁免漏报)。
    expect(
      kinds(`<input onChange={(e) => set(e.target.value)} className="focus-visible:outline focus-visible:outline-2" />
        <textarea className="focus-visible:outline-2" />
        <div contentEditable className="focus-visible:outline" />`),
    ).toEqual(['invisibleFocus', 'invisibleFocus', 'invisibleFocus']);
    // cn() 分行写法:焦点圈在同一个 cn 的另一行也算兜底。
    expect(kinds("className={cn(\n  'rounded-full',\n  'focus-visible:outline focus-visible:outline-2',\n)}")).toEqual([
      'invisibleFocus',
    ]);
    expect(
      kinds("className={cn(\n  'focus-visible:outline focus-visible:outline-2',\n  'focus-visible:ring-2',\n)}"),
    ).toEqual([]);
    // 跨行的 className 属性值是同一个字符串:焦点圈写在下一行也算兜底,没有就照样红。
    expect(kinds('<button className="focus-visible:outline\n  focus-visible:ring-2">')).toEqual([]);
    expect(kinds('<button className={`focus-visible:outline\n  focus-visible:ring-2`}>')).toEqual([]);
    expect(kinds('<button className="focus-visible:outline\n  rounded-full">\n<a className="focus-visible:ring-2">')).toEqual([
      'invisibleFocus',
    ]);

    expect(
      kinds(`<button className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
        <a className="focus-visible:outline focus-visible:ring-2">
        <button className="focus-visible:outline-none focus-visible:after:ring-2">
        <input className="focus-visible:outline-none focus-visible:ring-2" />
        // focus-visible:outline in prose`),
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

  it('非输入元素的键盘焦点用 focus-visible 焦点圈，不只靠 outline', () => {
    expect(registryDrift(['invisibleFocus'])).toEqual([]);
  });
});
