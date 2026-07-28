/**
 * VSCode 颜色主题（`*.json` / jsonc）→ Cindy 色板。
 *
 * 映射依据是仓库里已有的人工移植记录:`renderer/themes/builtin/one-dark-pro.ts`
 * 顶部注释逐行写明了 SURFACE ← `editor.background`、ELEVATED ←
 * `sideBar.background`、HOVER ← `list.hoverBackground`、BORDER ←
 * `panel.border`、PRIMARY ← `editor.foreground`、SECONDARY ← comment scope、
 * DISABLED ← `lineNumber.foreground`。本文件把那套判断代码化并补上 fallback 链。
 *
 * 源文件没给的角色一律**推导**而非留空(VSCode 自己也是这么干的:主题只写一部分
 * workbench 色,其余由内建默认派生),并把推导过的角色名放进报告。
 */

import {
  isDarkBackground,
  parseCssColor,
  parseCssColorComposited,
  shade,
  toHex,
  type Rgb,
} from './color';
import type { MarkdownPalette, ThemePalette, ThemeTypeName } from './palette';

function stripBom(input: string): string {
  return input.charCodeAt(0) === 0xFEFF ? input.slice(1) : input;
}

/** 去掉 jsonc 的注释与尾逗号——VSCode 主题文件普遍带注释。 */
export function stripJsonComments(input: string): string {
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];
    const next = input[i + 1];
    if (inLineComment) {
      if (c === '\n') {
        inLineComment = false;
        out += c;
      }
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') {
        // 转义序列整体透传，避免把 \" 误判成字符串结束。
        if (next !== undefined) {
          out += next;
          i += 1;
        }
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    out += c;
  }
  // 尾逗号必须在注释剥完之后、且带字符串感知地删(`, // 注释\n}` 这种要先没了
  // 注释才看得出是尾逗号)。此前用一条全局 replace(/,(\s*[}\]])/g) 处理,那个
  // 正则不认字符串边界,会把 JSON 值里合法的 `, }` 一起吃掉
  // (`{"a": "x, }y"}` 被改成 `{"a": "x}y"}`)。
  return stripTrailingCommas(out);
}

/** 删掉 `}` / `]` 前的尾逗号；字符串字面量内的逗号原样保留。 */
function stripTrailingCommas(input: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];
    if (inString) {
      out += c;
      if (c === '\\') {
        if (i + 1 < input.length) {
          out += input[i + 1];
          i += 1;
        }
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === ',' && isTrailingComma(input, i)) continue;
    out += c;
  }
  return out;
}

/** `,` 之后跳过空白，若紧接 `}` 或 `]` 则它是尾逗号。 */
function isTrailingComma(input: string, commaIndex: number): boolean {
  for (let j = commaIndex + 1; j < input.length; j += 1) {
    const c = input[j];
    if (c === '}' || c === ']') return true;
    if (!/\s/.test(c)) return false;
  }
  // 逗号后只剩空白：JSON 本身已经不合法，交给 JSON.parse 报错。
  return false;
}

interface VsCodeTokenColor {
  scope?: string | string[];
  settings?: { foreground?: string; fontStyle?: string };
}

interface VsCodeThemeJson {
  name?: string;
  type?: string;
  include?: string;
  colors?: Record<string, unknown>;
  tokenColors?: VsCodeTokenColor[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 解析 VSCode 主题文件；不是主题 JSON 时返回 null（由调用方给出可读报错）。 */
export function parseVsCodeThemeJson(raw: string): VsCodeThemeJson | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(stripBom(raw)));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const hasColors = isRecord(parsed.colors);
  const hasTokenColors = Array.isArray(parsed.tokenColors);
  // `colors` 与 `tokenColors` 都没有 → 不是颜色主题（可能是 snippets / settings）。
  if (!hasColors && !hasTokenColors) return null;
  return {
    ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
    ...(typeof parsed.type === 'string' ? { type: parsed.type } : {}),
    ...(typeof parsed.include === 'string' ? { include: parsed.include } : {}),
    ...(hasColors ? { colors: parsed.colors as Record<string, unknown> } : {}),
    ...(hasTokenColors ? { tokenColors: parsed.tokenColors as VsCodeTokenColor[] } : {}),
  };
}

function scopeList(scope: string | string[] | undefined): string[] {
  if (Array.isArray(scope)) return scope.flatMap((s) => scopeList(s));
  if (typeof scope !== 'string') return [];
  return scope
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 取某个 TextMate scope 的前景色（反向扫描——VSCode 是 last-match-wins）。
 * 精确匹配优先于前缀匹配，避免 `comment.block.documentation` 覆盖 `comment`。
 * 带 alpha 的颜色合成到 `over` 底色上（同 VSCode 渲染行为）。
 */
function tokenColorFor(theme: VsCodeThemeJson, wanted: string, over?: Rgb | null): Rgb | null {
  const entries = theme.tokenColors ?? [];
  let prefixHit: Rgb | null = null;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const fg = entries[i].settings?.foreground;
    if (typeof fg !== 'string') continue;
    for (const scope of scopeList(entries[i].scope)) {
      if (scope === wanted) {
        const rgb = over ? parseCssColorComposited(fg, over) : parseCssColor(fg);
        if (rgb) return rgb;
      }
      if (!prefixHit && wanted.startsWith(`${scope}.`)) {
        prefixHit = over ? parseCssColorComposited(fg, over) : parseCssColor(fg);
      }
    }
  }
  return prefixHit;
}

export interface VsCodeExtraction {
  palette: ThemePalette;
  type: ThemeTypeName;
  name: string;
  markdown: MarkdownPalette;
  derivedRoles: string[];
  resolvedRoles: number;
  unresolved: string[];
}

/**
 * 从 VSCode 主题抽 Cindy 色板。
 *
 * `fallbackName` 用于源文件没写 `name` 时（一般传文件名）。
 */
export function extractVsCodePalette(
  theme: VsCodeThemeJson,
  fallbackName: string,
): VsCodeExtraction | null {
  const colors = theme.colors ?? {};
  const unresolved: string[] = [];
  const derivedRoles: string[] = [];
  let resolvedRoles = 0;

  /** 按 key 链取首个可解析的色值；全不命中返回 null。 */
  const pickColor = (keys: string[], compositeBg?: Rgb | null): Rgb | null => {
    for (const key of keys) {
      const raw = colors[key];
      if (typeof raw !== 'string') continue;
      const rgb = compositeBg
        ? parseCssColorComposited(raw, compositeBg)
        : parseCssColor(raw);
      if (rgb) return rgb;
      unresolved.push(key);
    }
    return null;
  };

  /** 命中则计入 resolved，否则用 derive() 推导并计入 derivedRoles。 */
  const role = (name: string, keys: string[], derive: () => Rgb, compositeBg?: Rgb | null): Rgb => {
    const hit = pickColor(keys, compositeBg);
    if (hit) {
      resolvedRoles += 1;
      return hit;
    }
    derivedRoles.push(name);
    return derive();
  };

  const surfaceHit = pickColor(['editor.background', 'editorPane.background']);
  if (!surfaceHit) {
    // 连主背景都没有,判不出这是个可用的颜色主题。包含 `include` 时背景可能来自
    // 被继承的主题,此时如实返回 null 让调用方给出继承限制说明,而非报"不支持"。
    return null;
  }
  resolvedRoles += 1;
  const surface = surfaceHit;

  const declaredType = theme.type?.toLowerCase();
  const type: ThemeTypeName = declaredType === 'light' || declaredType === 'dark'
    ? declaredType
    : isDarkBackground(surface)
      ? 'dark'
      : 'light';
  const dark = type === 'dark';
  /** 层级推导方向:暗色主题往亮走一档,亮色主题往暗走一档。 */
  const step = (base: Rgb, amount: number): Rgb => shade(base, dark ? amount : -amount);

  const elevated = role(
    'elevated',
    ['sideBar.background', 'editorWidget.background', 'panel.background', 'activityBar.background'],
    () => step(surface, 0.05),
  );
  const hover = role(
    'hover',
    ['list.hoverBackground', 'toolbar.hoverBackground', 'menu.selectionBackground'],
    () => step(surface, 0.08),
    surfaceHit,
  );
  const chip = role(
    'chip',
    ['list.activeSelectionBackground', 'editorGroupHeader.tabsBackground', 'badge.background'],
    () => step(hover, 0.04),
    surfaceHit,
  );
  const border = role(
    'border',
    ['panel.border', 'editorGroup.border', 'input.border', 'contrastBorder', 'widget.border'],
    () => step(surface, 0.2),
    surfaceHit,
  );

  const textPrimary = role(
    'textPrimary',
    ['editor.foreground', 'foreground'],
    () => (dark ? { r: 212, g: 212, b: 212 } : { r: 38, g: 38, b: 38 }),
    surfaceHit,
  );
  // 二级文字优先取注释色——这是 one-dark-pro.ts 注释里记录的人工判断
  // (SECONDARY ← comments),比 descriptionForeground 更贴近"弱化正文"的观感。
  const commentColor = tokenColorFor(theme, 'comment', surfaceHit);
  if (commentColor) resolvedRoles += 1;
  const textSecondary = commentColor ?? role(
    'textSecondary',
    ['descriptionForeground', 'editorCodeLens.foreground'],
    () => shade(textPrimary, dark ? -0.28 : 0.28),
    surfaceHit,
  );
  const textDisabled = role(
    'textDisabled',
    ['editorLineNumber.foreground', 'editorWhitespace.foreground'],
    () => shade(textSecondary, dark ? -0.35 : 0.35),
    surfaceHit,
  );
  const textTertiary = role(
    'textTertiary',
    ['editorHint.foreground', 'breadcrumb.foreground'],
    () => shade(textSecondary, dark ? -0.16 : 0.16),
  );

  const accentPrimary = role(
    'accentPrimary',
    [
      'button.background',
      'focusBorder',
      'textLink.foreground',
      'activityBarBadge.background',
      'progressBar.background',
      'statusBarItem.remoteBackground',
    ],
    () => textPrimary,
  );
  const accentSoft = shade(accentPrimary, dark ? 0.22 : -0.28);
  derivedRoles.push('accentSoft');
  const accentDeep = shade(accentPrimary, dark ? -0.22 : -0.28);
  derivedRoles.push('accentDeep');
  const elevatedSoft = dark ? elevated : step(elevated, 0.08);
  derivedRoles.push('elevatedSoft');

  const headingColor = tokenColorFor(theme, 'markup.heading', surfaceHit);
  const boldColor = tokenColorFor(theme, 'markup.bold', surfaceHit);
  const markdown: MarkdownPalette = {
    ...(headingColor ? { headings: Array.from({ length: 6 }, () => headingColor) } : {}),
    ...(boldColor ? { strong: boldColor } : {}),
  };

  if (theme.include) {
    // 我们只读单文件,被 include 的基底主题里的色值拿不到——如实计入报告。
    unresolved.push(`include:${theme.include}`);
  }

  return {
    palette: {
      surface,
      elevated,
      elevatedSoft,
      hover,
      chip,
      border,
      textPrimary,
      textSecondary,
      textTertiary,
      textDisabled,
      accentPrimary,
      accentSoft,
      accentDeep,
    },
    type,
    name: theme.name?.trim() || fallbackName,
    markdown,
    derivedRoles,
    resolvedRoles,
    unresolved,
  };
}

/** 调试用:把色板打成 hex map（测试断言更易读）。 */
export function paletteToHex(palette: ThemePalette): Record<string, string> {
  return Object.fromEntries(
    Object.entries(palette).map(([k, v]) => [k, toHex(v as Rgb)]),
  );
}
