/**
 * 文字档位纪律(DESIGN.md §10 规则 6、§7;用户裁决 2026-10-22)。
 *
 * CINDY 的中性文字是一条墨水阶梯,层级只靠档位区分:
 * 1. 占位文字只用占位档(`--text-placeholder` 及其输入框别名),不借三级、说明或次要档——
 *    借来的档比占位档深,读起来像已经填了内容;
 * 2. 中性文字不靠 `opacity-*` 假装层级:同一组 class 里不同时写墨水文字色与静态透明度。
 *    禁用态(DESIGN §4,disabled 60%)和悬停显隐(opacity-0 ↔ 100)不在此列。
 *
 * 判定按真实主题解析:某个颜色 token 在 CINDY 下解析为墨水(浅色黑 / 深色白 + 透明度)
 * 就算中性文字档,不维护手写名单。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { cindyDark } from '../themes/builtin/cindy-dark';
import { cindyLight } from '../themes/builtin/cindy-light';
import '../themes/colors';
import { resolveThemeValue } from '../themes/theme-service';
import type { Theme } from '../themes/types';

const RENDERER = resolve(__dirname, '..');

/** Tailwind 具名颜色 → token(tailwind.config.ts 里的 HSL 槽位)。 */
const NAMED: Record<string, string> = {
  foreground: 'foreground',
  'muted-foreground': 'muted-foreground',
  'secondary-foreground': 'secondary-foreground',
  'accent-foreground': 'accent-foreground',
  'popover-foreground': 'popover-foreground',
  'sidebar-muted': 'sidebar-muted',
  'sidebar-action-icon': 'sidebar-action-icon',
  'titlebar-icon': 'titlebar-icon',
  'welcome-text': 'welcome-text',
};

/** 已登记的例外:按文件 + 精确 class 片段匹配,写明理由。 */
const OPACITY_EXCEPTIONS = [
  {
    file: 'features/right-sidebar/plugins/web-browser/BrowserChrome.tsx',
    snippet: "'text-[var(--text-tertiary)] opacity-40'",
    reason: '浏览器工具栏按钮的禁用分支(disabled 透明度),条件写在 class 外面',
  },
];

function resolveIn(theme: Theme, id: string, depth = 0): string {
  const value = resolveThemeValue(theme, id) ?? '';
  const alias = /^(?:hsl\()?var\(--([a-z0-9-]+)\)\)?$/.exec(value)?.[1];
  return alias && depth < 10 ? resolveIn(theme, alias, depth + 1) : value;
}

/** 墨水透明度;不是墨水返回 null。 */
function inkAlpha(id: string): { light: number; dark: number } | null {
  const light = resolveIn(cindyLight, id);
  const dark = resolveIn(cindyDark, id);
  const l = /^rgba\(0, 0, 0, ([0-9.]+)\)$/.exec(light) ?? /^0\.0 0\.0% 0\.0% \/ ([0-9.]+)$/.exec(light);
  const d = /^rgba\(255, 255, 255, ([0-9.]+)\)$/.exec(dark) ?? /^0\.0 0\.0% 100\.0% \/ ([0-9.]+)$/.exec(dark);
  return l && d ? { light: Number(l[1]), dark: Number(d[1]) } : null;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'vendor' || name === 'node_modules') continue;
    const file = join(dir, name);
    if (statSync(file).isDirectory()) sourceFiles(file, out);
    else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) out.push(file);
  }
  return out;
}

interface ClassLiteral {
  file: string;
  line: number;
  literal: string;
  classes: string[];
}

function classLiterals(): ClassLiteral[] {
  const out: ClassLiteral[] = [];
  for (const file of sourceFiles(RENDERER)) {
    // 豁免表和诊断使用 `/` 分隔的仓库逻辑路径;实际文件读取仍保留宿主路径。
    const rel = relative(RENDERER, file).split(sep).join('/');
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((text, index) => {
        for (const literal of text.match(/(['"`])(?:(?!\1).)*\1/g) ?? []) {
          out.push({ file: rel, line: index + 1, literal, classes: literal.slice(1, -1).split(/\s+/) });
        }
      });
  }
  return out;
}

function tokenOf(className: string): string | null {
  const arbitrary = /^text-\[(?:hsl\()?var\(--([a-z0-9-]+)\)\)?\]$/.exec(className);
  if (arbitrary) return arbitrary[1];
  const named = /^text-([a-z-]+)$/.exec(className);
  return named ? (NAMED[named[1]] ?? null) : null;
}

const literals = classLiterals();
const placeholder = inkAlpha('text-placeholder')!;

describe('文字档位纪律(CINDY 墨水阶梯)', () => {
  it('占位文字只用占位档', () => {
    const violations: string[] = [];
    for (const { file, line, classes } of literals) {
      for (const className of classes) {
        const match = /^placeholder:(text-.+)$/.exec(className);
        if (!match) continue;
        const token = tokenOf(match[1]);
        if (token?.startsWith('login-')) continue; // 登录页整族豁免(DESIGN §10/§16)
        const alpha = token ? inkAlpha(token) : null;
        if (alpha?.light === placeholder.light && alpha?.dark === placeholder.dark) continue;
        violations.push(`${file}:${line} ${className}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('中性文字不叠 opacity-* 假装层级', () => {
    const violations: string[] = [];
    for (const { file, line, literal, classes } of literals) {
      const opacity = classes.find((className) => /^opacity-(\d+)$/.test(className));
      if (!opacity || opacity === 'opacity-0' || opacity === 'opacity-100') continue;
      if (/disabled|cursor-not-allowed/.test(literal)) continue;
      const token = classes.map(tokenOf).find((id) => id && inkAlpha(id));
      if (!token) continue;
      if (OPACITY_EXCEPTIONS.some((entry) => entry.file === file && literal.includes(entry.snippet))) continue;
      violations.push(`${file}:${line} ${token} + ${opacity}`);
    }
    expect(violations).toEqual([]);
  });

  it('自证伪:借三级档的占位与叠透明度的说明文字都会被拦下', () => {
    expect(inkAlpha('text-tertiary')).not.toEqual(placeholder);
    expect(inkAlpha('settings-section-sublabel')).not.toBeNull();
    expect(tokenOf('text-[var(--settings-section-sublabel)]')).toBe('settings-section-sublabel');
    expect(tokenOf('text-muted-foreground')).toBe('muted-foreground');
  });
});
