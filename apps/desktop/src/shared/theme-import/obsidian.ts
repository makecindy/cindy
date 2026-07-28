/**
 * Obsidian 主题（`theme.css`）→ Cindy 色板。
 *
 * ## 这是"调色板导入",不是主题移植
 *
 * Obsidian 主题是任意 CSS:除了 CSS 自定义属性,还大量改选择器、布局、圆角、
 * 字体。我们**只取颜色变量**,其余一律丢弃——这是设计约束而不是偷懒:Cindy 的
 * 布局与排版由自己的设计规范(DESIGN.md §3/§5)负责,不接受外部 CSS 接管。
 *
 * ## 解析范围
 *
 * 从 `.theme-dark{}` / `.theme-light{}` / `body{}` / `:root{}` 里收集自定义属性,
 * 做 `var()` 解引用(含 `var(--x, fallback)` 与 Obsidian v1 的 `--color-base-NN`
 * 色阶),再按 Obsidian 官方变量名映射。`color-mix()` 一类无法静态求值的写法会
 * 跳过并计入报告——不猜值。
 *
 * 变量名以 Obsidian 官方 CSS variables 文档为准（`--background-primary` /
 * `--text-normal` / `--interactive-accent` / `--h1-color` 等长期稳定的公开 API）。
 */

import { isDarkBackground, parseCssColor, parseCssColorComposited, shade, type Rgb } from './color';
import type { MarkdownPalette, ThemePalette, ThemeTypeName } from './palette';

type VarMap = Map<string, string>;

interface CssRule {
  selector: string;
  body: string;
}

/**
 * 剥掉 CSS 块注释。必须在切规则之前做:主题文件普遍在规则前写版权/说明注释,
 * 不剥的话选择器会连着前面那段注释一起被切出来(实测 `body` 变成
 * "注释文本 + 换行 + body"),根级选择器判定直接失配,整段基底变量丢失。
 * 字符串字面量里的注释起始符不动。
 */
export function stripCssComments(source: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (quote !== null) {
      out += c;
      if (c === '\\') {
        if (i + 1 < source.length) {
          out += source[i + 1];
          i += 1;
        }
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    out += c;
  }
  return out;
}

const MAX_AT_RULE_DEPTH = 8;

/**
 * 极简 CSS 规则扫描:按大括号深度切出 `selector { body }` 对；at-rule
 * (`@media` 等) 的内容递归处理,让包在 media query 里的主题块也能被读到。
 */
export function collectCssRules(source: string): CssRule[] {
  return scanCssRules(stripCssComments(source), 0);
}

/**
 * 从 `{` 起找配对的 `}`，返回它的下一个位置（找不到则到末尾）。
 *
 * 字符串字面量里的大括号不计入深度——`content: "{"`、带大括号的 data URL 都是
 * 合法 CSS，按裸字符数深度会把后续 `.theme-light` / `.theme-dark` 规则整段吞掉。
 */
function findBlockEnd(source: string, openIndex: number): number {
  let depth = 1;
  let quote: string | null = null;
  let j = openIndex + 1;
  while (j < source.length && depth > 0) {
    const c = source[j];
    if (quote !== null) {
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === quote) quote = null;
      j += 1;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    j += 1;
  }
  return j;
}

const SKIP_AT_RULE_RE = /^@(supports|font-face|keyframes|counter-style|page)\b/i;
const PRINT_MEDIA_RE = /^@media\b[^{]*\bprint\b/i;
const VIEWPORT_MEDIA_RE = /^@media\b[^{]*\b(max-width|max-height)\b/i;

function shouldRecurseAtRule(selector: string): boolean {
  if (SKIP_AT_RULE_RE.test(selector)) return false;
  if (PRINT_MEDIA_RE.test(selector)) return false;
  if (VIEWPORT_MEDIA_RE.test(selector)) return false;
  return true;
}

const NESTED_THEME_SELECTOR_RE = /(?:^|[,\s])&\s*\.theme-(dark|light)/i;

function scanCssRules(source: string, depth: number): CssRule[] {
  if (depth >= MAX_AT_RULE_DEPTH) return [];
  const rules: CssRule[] = [];
  let selectorStart = 0;
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const ch = source[i];
    if (quote !== null) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === ';') {
      const pending = source.slice(selectorStart, i).trim();
      if (pending.startsWith('@')) {
        i += 1;
        selectorStart = i;
        continue;
      }
      i += 1;
      selectorStart = i;
      continue;
    }
    if (ch === '{') {
      const selector = source.slice(selectorStart, i).trim();
      const j = findBlockEnd(source, i);
      const body = source.slice(i + 1, Math.max(i + 1, j - 1));
      if (selector.startsWith('@')) {
        if (shouldRecurseAtRule(selector)) {
          rules.push(...scanCssRules(body, depth + 1));
        }
      } else if (selector.length > 0) {
        rules.push({ selector, body });
        // CSS nesting: `body { &.theme-dark { ... } }` — recurse into the
        // body so nested theme selectors are collected as separate rules.
        // Works at any depth so at-rule-wrapped nesting is also captured.
        // Only emit children whose resolved selector passes selectorMode()
        // as a root-level theme rule — prevents component-scoped descendants
        // (`.theme-dark .modal { ... }`) from overriding global palette.
        const nested = scanCssRules(body, depth + 1);
        for (const child of nested) {
          if (!NESTED_THEME_SELECTOR_RE.test(child.selector)) continue;
          // Expand `&` per comma-separated parent part to avoid generating
          // invalid selectors like `body, html.theme-dark` from `body, html`.
          const parentParts = selector.split(',').map((p) => p.trim()).filter(Boolean);
          const childParts = child.selector.split(',').map((p) => p.trim()).filter(Boolean);
          const expanded = childParts.flatMap((cp) =>
            parentParts.map((pp) => cp.replace(/&/g, pp)),
          );
          const resolved = expanded.join(', ');
          if (selectorMode(resolved) !== null) {
            rules.push({ selector: resolved, body: child.body });
          }
        }
      }
      i = j;
      selectorStart = i;
      continue;
    }
    if (ch === '}') {
      i += 1;
      selectorStart = i;
      continue;
    }
    i += 1;
  }
  return rules;
}

/**
 * 抽一个 declaration block 里的自定义属性。
 * `!important` 声明锁定变量不被后续普通声明覆盖。
 * 跳过嵌套块（CSS nesting `& .child { ... }`）以免把子选择器的声明误收为根级。
 */
function collectCustomProps(body: string, into: VarMap, locked?: Set<string>): void {
  const flat = stripNestedBlocks(body);
  for (const m of flat.matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;]+)(?:;|$)/g)) {
    const name = m[1].trim();
    const rawValue = m[2].trim();
    const isImportant = /!important\s*$/i.test(rawValue);
    const value = rawValue.replace(/!important/gi, '').trim();
    if (value.length === 0) continue;
    if (locked?.has(name) && !isImportant) continue;
    into.set(name, value);
    if (isImportant) locked?.add(name);
  }
}

function stripNestedBlocks(body: string): string {
  let out = '';
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (quote !== null) {
      if (c === '\\') {
        if (depth === 0) out += c + (body[i + 1] ?? '');
        i += 1;
        continue;
      }
      if (c === quote) quote = null;
      if (depth === 0) out += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      if (depth === 0) out += c;
      continue;
    }
    if (c === '{') { depth += 1; continue; }
    if (c === '}') { if (depth > 0) depth -= 1; continue; }
    if (depth === 0) out += c;
  }
  return out;
}

const MAX_VAR_DEPTH = 8;
const MAX_EXPANDED_LENGTH = 100_000;

/**
 * 把值里的 `var(--x)` / `var(--x, fallback)` 递归展开成字面量。
 * 展开后仍含 `var(` 或无法求值时由调用方判定失败。
 * 长度超过 MAX_EXPANDED_LENGTH 时中止（防恶意主题指数膨胀阻塞主进程）。
 */
export function resolveVarValue(
  raw: string,
  vars: VarMap,
  depth = 0,
): string {
  if (depth >= MAX_VAR_DEPTH || !raw.includes('var(')) return raw;
  if (raw.length > MAX_EXPANDED_LENGTH) return raw;
  let changed = false;
  let budget = MAX_EXPANDED_LENGTH;
  const replaced = raw.replace(
    /var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,([^()]*(?:\([^()]*\)[^()]*)*))?\)/g,
    (_all, name: string, fallback: string | undefined) => {
      if (budget <= 0) return _all;
      const hit = vars.get(name);
      if (hit !== undefined) {
        budget -= hit.length;
        changed = true;
        return hit;
      }
      if (fallback !== undefined) {
        budget -= fallback.length;
        changed = true;
        return fallback.trim();
      }
      return _all;
    },
  );
  if (!changed || replaced.length > MAX_EXPANDED_LENGTH) return replaced;
  return resolveVarValue(replaced, vars, depth + 1);
}

export interface ObsidianExtraction {
  palette: ThemePalette;
  type: ThemeTypeName;
  markdown: MarkdownPalette;
  derivedRoles: string[];
  resolvedRoles: number;
  unresolved: string[];
}

/** 按模式聚合出的变量表。 */
interface ModeVars {
  type: ThemeTypeName;
  vars: VarMap;
}

function selectorMode(selector: string): ThemeTypeName | 'base' | null {
  // 逗号分隔的选择器列表（`.theme-dark, .theme-light { ... }`）拆开逐条判定。
  const parts = selector.split(',').map((p) => p.toLowerCase().trim()).filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  // 多段选择器中只要有一段是根级 theme class 就算;两种都有视为 base。
  let hasDark = false;
  let hasLight = false;
  let hasBase = false;
  for (const s of parts) {
    if (/^(body|html|:root|\*)?\s*\.theme-(dark|light)\s*$/.test(s)) {
      if (s.includes('.theme-dark')) hasDark = true;
      if (s.includes('.theme-light')) hasLight = true;
    } else if (/^(:root|html|body|\*)$/.test(s)) {
      hasBase = true;
    }
  }
  if (hasDark && hasLight) return 'base';
  // Mixed list containing both a root element and a theme class (e.g.
  // `:root, .theme-dark`) applies in all modes — classify as base.
  if ((hasDark || hasLight) && hasBase) return 'base';
  if (hasDark) return 'dark';
  if (hasLight) return 'light';
  // 纯根选择器（无 theme class）——但必须是 `:root` / `body` / `html` 自身，
  // 不能是 `body .modal` 这种后代组合。
  if (hasBase || (parts.length === 1 && /^(:root|html|body|\*)$/.test(parts[0]))) return 'base';
  return null;
}

/** 从整份 CSS 聚合出 light / dark 两套变量表（缺失的模式不返回）。 */
export function collectObsidianVars(source: string): ModeVars[] {
  const base: VarMap = new Map();
  const dark: VarMap = new Map();
  const light: VarMap = new Map();
  const baseLocked = new Set<string>();
  const darkLocked = new Set<string>();
  const lightLocked = new Set<string>();
  for (const rule of collectCssRules(source)) {
    const mode = selectorMode(rule.selector);
    if (mode === null) continue;
    if (mode === 'base') {
      collectCustomProps(rule.body, base, baseLocked);
      continue;
    }
    collectCustomProps(
      rule.body,
      mode === 'dark' ? dark : light,
      mode === 'dark' ? darkLocked : lightLocked,
    );
  }
  const out: ModeVars[] = [];
  // Merge base into mode. Base !important wins over non-important mode values,
  // but a mode-specific !important overrides the base (higher specificity in CSS).
  const merge = (mode: VarMap, modeLocked: Set<string>): VarMap => {
    const merged = new Map([...base, ...mode]);
    for (const name of baseLocked) {
      if (modeLocked.has(name)) continue;
      const baseVal = base.get(name);
      if (baseVal !== undefined) merged.set(name, baseVal);
    }
    return merged;
  };
  if (dark.size > 0) out.push({ type: 'dark', vars: merge(dark, darkLocked) });
  if (light.size > 0) out.push({ type: 'light', vars: merge(light, lightLocked) });
  // base-only fallback：只有根级声明且无显式模式块时，按背景亮度推断类型。
  if (out.length === 0 && base.size > 0) {
    const bg = readColor(base, ['--background-primary', '--color-base-00']);
    out.push({
      type: bg && isDarkBackground(bg) ? 'dark' : 'light',
      vars: base,
    });
  }
  // 双态补全：如果只有一个显式模式块而 base 有可用色板，base 作为缺失模式的来源。
  // 例如 `:root` 定义 light 色板 + `.theme-dark` 覆盖 → 应同时产出 light 变体。
  if (out.length === 1 && base.size > 0) {
    const existing = out[0].type;
    const bg = readColor(base, ['--background-primary', '--color-base-00']);
    const baseType: ThemeTypeName = bg && isDarkBackground(bg) ? 'dark' : 'light';
    if (baseType !== existing) {
      out.push({ type: baseType, vars: base });
    }
  }
  return out;
}

/** 取首个能求值成颜色的变量。`compositeBg` 不为 null 时，半透明值合成到该底色上。 */
function readColor(vars: VarMap, names: string[], unresolved?: string[], compositeBg?: Rgb | null): Rgb | null {
  for (const name of names) {
    const raw = vars.get(name);
    if (raw === undefined) continue;
    const resolved = resolveVarValue(raw, vars);
    const rgb = compositeBg
      ? parseCssColorComposited(resolved, compositeBg)
      : parseCssColor(resolved);
    if (rgb) return rgb;
    unresolved?.push(name);
  }
  return null;
}

/** 把一套变量表转成 Cindy 色板。背景色都读不到时返回 null。 */
export function extractObsidianPalette({ type, vars }: ModeVars): ObsidianExtraction | null {
  const unresolved: string[] = [];
  const derivedRoles: string[] = [];
  let resolvedRoles = 0;

  const role = (name: string, names: string[], derive: () => Rgb, compositeBg?: Rgb | null): Rgb => {
    const hit = readColor(vars, names, unresolved, compositeBg);
    if (hit) {
      resolvedRoles += 1;
      return hit;
    }
    derivedRoles.push(name);
    return derive();
  };

  const surface = readColor(vars, ['--background-primary', '--color-base-00'], unresolved);
  if (!surface) return null;
  resolvedRoles += 1;

  const dark = type === 'dark';
  const step = (base: Rgb, amount: number): Rgb => shade(base, dark ? amount : -amount);

  const elevated = role(
    'elevated',
    ['--background-secondary', '--background-primary-alt', '--color-base-10'],
    () => step(surface, 0.05),
    surface,
  );
  const hover = (() => {
    const hit = readColor(vars, ['--background-modifier-hover', '--color-base-20'], unresolved, surface);
    if (hit) { resolvedRoles += 1; return hit; }
    derivedRoles.push('hover');
    return step(surface, 0.08);
  })();
  const chip = (() => {
    const hit = readColor(vars, ['--background-secondary-alt', '--background-modifier-active-hover', '--color-base-25'], unresolved, surface);
    if (hit) { resolvedRoles += 1; return hit; }
    derivedRoles.push('chip');
    return step(hover, 0.04);
  })();
  const border = (() => {
    const hit = readColor(vars, ['--background-modifier-border', '--divider-color', '--color-base-30'], unresolved, surface);
    if (hit) { resolvedRoles += 1; return hit; }
    derivedRoles.push('border');
    return step(surface, 0.2);
  })();

  const textPrimary = (() => {
    const hit = readColor(vars, ['--text-normal', '--color-base-100'], unresolved, surface);
    if (hit) { resolvedRoles += 1; return hit; }
    derivedRoles.push('textPrimary');
    return dark ? { r: 212, g: 212, b: 212 } : { r: 38, g: 38, b: 38 };
  })();
  const textSecondary = (() => {
    const hit = readColor(vars, ['--text-muted', '--color-base-70'], unresolved, surface);
    if (hit) { resolvedRoles += 1; return hit; }
    derivedRoles.push('textSecondary');
    return shade(textPrimary, dark ? -0.28 : 0.28);
  })();
  const textTertiary = (() => {
    const hit = readColor(vars, ['--text-faint', '--color-base-50'], unresolved, surface);
    if (hit) { resolvedRoles += 1; return hit; }
    derivedRoles.push('textTertiary');
    return shade(textSecondary, dark ? -0.16 : 0.16);
  })();
  const textDisabled = role(
    'textDisabled',
    ['--color-base-40'],
    // Obsidian 没有 disabled 文字概念,从 faint 再弱一档。
    // 注意: --text-selection 是选区背景色而非前景色,不能用在这里。
    () => shade(textTertiary, dark ? -0.25 : 0.25),
  );

  const accentPrimary = role(
    'accentPrimary',
    ['--interactive-accent', '--color-accent', '--text-accent'],
    () => textPrimary,
  );
  const accentSoftHit = readColor(vars, ['--text-accent-hover', '--color-accent-2']);
  const accentSoft = accentSoftHit ?? shade(accentPrimary, dark ? 0.22 : -0.28);
  if (accentSoftHit) resolvedRoles += 1;
  else derivedRoles.push('accentSoft');
  const accentDeepHit = readColor(vars, ['--interactive-accent-hover', '--color-accent-1']);
  const accentDeep = accentDeepHit ?? shade(accentPrimary, dark ? -0.22 : -0.28);
  if (accentDeepHit) resolvedRoles += 1;
  else derivedRoles.push('accentDeep');
  const elevatedSoft = dark ? elevated : step(elevated, 0.08);
  derivedRoles.push('elevatedSoft');

  const headings = ['--h1-color', '--h2-color', '--h3-color', '--h4-color', '--h5-color', '--h6-color']
    .map((name) => readColor(vars, [name], unresolved));
  const strong = readColor(vars, ['--bold-color', '--text-bold'], unresolved);
  const markdown: MarkdownPalette = {
    ...(headings.some(Boolean) ? { headings } : {}),
    ...(strong ? { strong } : {}),
  };

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
    markdown,
    derivedRoles,
    resolvedRoles,
    unresolved,
  };
}
