import { describe, expect, it } from 'vitest';

import { cindyDark } from '../builtin/cindy-dark';
import { cindyLight } from '../builtin/cindy-light';
import { renderOAuthResultPage } from '../../../main/oauthResultPage';
import { colorRegistry } from '../color-registry';
import '../colors';

/**
 * 登录页文字并入墨水阶梯(2026-10-23 用户裁决,DESIGN §16.1)。
 *
 * `login-*` 仍是独立 token 族(只跟随 light / dark,不被扩展主题覆盖),但文字类
 * token 的值与 CINDY 皮肤主界面的墨水档逐字相同。规则只写一处:改主界面墨水
 * 档时登录页必须一起改,反之亦然,不允许两边再各自取一套灰。
 */
const LOGIN_TEXT_TIERS: ReadonlyArray<readonly [loginId: string, inkTierId: string]> = [
  ['login-title-text', 'text-primary'],
  ['login-control-text', 'text-primary'],
  ['login-callback-title', 'text-primary'],
  ['login-secondary-text', 'text-secondary'],
  ['login-callback-body', 'text-secondary'],
  ['login-control-placeholder', 'text-placeholder'],
];

describe('登录页文字档 = 主界面墨水阶梯', () => {
  for (const [mode, theme] of [
    ['light', cindyLight],
    ['dark', cindyDark],
  ] as const) {
    it.each(LOGIN_TEXT_TIERS)(`${mode}: %s 与 %s 同值`, (loginId, inkTierId) => {
      const ink = theme.colors[inkTierId];
      expect(ink, `${theme.id} 缺少 ${inkTierId}`).toMatch(/^rgba\((0, 0, 0|255, 255, 255), 0\.\d+\)$/);
      expect(colorRegistry.resolveDefault(loginId, mode)).toBe(ink);
    });
  }
});

/**
 * 浏览器登录回调页(`oauthResultPage.ts`)在系统浏览器里打开,拿不到 renderer 的 token,
 * 颜色以内联 CSS 变量写在三段规则里:浅色、强制深色(`data-theme="dark"`)、系统深色回退
 * (`prefers-color-scheme: dark` 且未指定主题)。只比较注册 token 会漏掉这里,
 * 所以直接解析生成的页面。标题 = 正文档,正文 = 次要档,错误码细节 = 三级档。
 */
const CALLBACK_VARS: ReadonlyArray<readonly [cssVar: string, inkTierId: string]> = [
  ['--title', 'text-primary'],
  ['--body', 'text-secondary'],
  ['--detail', 'text-tertiary'],
];

function normalizeRgba(value: string): string {
  const match = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/.exec(value.trim());
  if (!match) throw new Error(`不是 rgba 墨水色: ${value}`);
  return `${match[1]},${match[2]},${match[3]},${Number(match[4])}`;
}

function callbackPageVars(theme: 'light' | 'dark' | undefined) {
  const html = renderOAuthResultPage({
    htmlLang: 'zh-CN',
    theme,
    pageKind: 'desktop-login',
    copyKind: 'login.browserCallback',
    variant: 'error',
    title: 'title',
    body: 'body',
    detail: 'STATE_MISMATCH',
    action: { href: 'cindy://login', label: 'back' },
  });
  const block = (pattern: RegExp) => {
    const body = pattern.exec(html)?.[1];
    if (body === undefined) throw new Error(`回调页缺少 CSS 规则: ${pattern}`);
    return Object.fromEntries(
      body
        .split(';')
        .map((declaration) => declaration.split(/:(.+)/))
        .filter(([name, value]) => name?.startsWith('--') && value)
        .map(([name, value]) => [name, value]),
    ) as Record<string, string>;
  };
  return {
    light: block(/:root\{([^}]*)\}/),
    dark: block(/:root\[data-theme="dark"\]\{([^}]*)\}/),
    systemDark: block(/@media\(prefers-color-scheme:dark\)\{:root:not\(\[data-theme\]\)\{([^}]*)\}/),
  };
}

describe('浏览器登录回调页文字 = 主界面墨水阶梯', () => {
  const vars = callbackPageVars(undefined);
  for (const [rule, theme] of [
    ['light', cindyLight],
    ['dark', cindyDark],
    ['systemDark', cindyDark],
  ] as const) {
    it.each(CALLBACK_VARS)(`${rule}: %s 与 %s 同值`, (cssVar, inkTierId) => {
      const ink = theme.colors[inkTierId];
      const actual = vars[rule][cssVar];
      if (ink === undefined) throw new Error(`${theme.id} 缺少 ${inkTierId}`);
      if (actual === undefined) throw new Error(`${rule} 规则缺少 ${cssVar}`);
      expect(normalizeRgba(actual)).toBe(normalizeRgba(ink));
    });
  }
});
