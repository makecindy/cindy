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
 * 面板、控件、描边、主按钮与链接并入主界面墨水口径(2026-10-27 用户裁决,DESIGN §16.1 /
 * §16.5)。和文字档同理:值与 CINDY 皮肤主界面对应角色逐字相同,只写一处。
 * 深色面板取主界面卡片档 #1F1F1F(用户选方案 A)。
 */
const LOGIN_SURFACE_ROLES: ReadonlyArray<readonly [loginId: string, mainId: string]> = [
  ['login-panel-bg', 'surface-elevated'],
  ['login-callback-card-bg', 'surface-elevated'],
  ['login-deletion-bubble-bg', 'surface-elevated'],
  ['login-control-bg', 'surface-chip'],
  ['login-action-control-bg', 'surface-chip'],
  ['login-disabled-button-bg', 'surface-chip'],
  ['login-secondary-button-bg', 'surface-chip'],
  ['login-consent-radio-bg', 'surface-chip'],
  ['login-panel-border', 'border-default'],
  ['login-callback-card-border', 'border-default'],
  ['login-deletion-bubble-border', 'border-default'],
  ['login-control-border', 'border-default'],
  ['login-back-border', 'border-default'],
  ['login-secondary-button-border', 'border-default'],
  ['login-primary-button-bg', 'accent-cta-bg-pure'],
  ['login-primary-button-border', 'accent-cta-bg-pure'],
  ['login-callback-cta-bg', 'accent-cta-bg-pure'],
  ['login-callback-cta-border', 'accent-cta-bg-pure'],
  ['login-consent-radio-checked-bg', 'accent-cta-bg-pure'],
  ['login-primary-button-text', 'accent-pure-cta-fg'],
  ['login-callback-cta-text', 'accent-pure-cta-fg'],
  ['login-consent-radio-check', 'accent-pure-cta-fg'],
  ['login-control-border-active', 'text-primary'],
  ['login-link-text', 'text-primary'],
  ['login-secondary-button-text', 'text-primary'],
  ['login-link-hover', 'text-secondary-mid'],
  ['login-link-pressed', 'text-primary-emphasis'],
  ['login-consent-radio-border', 'text-secondary'],
  ['login-disabled-button-text', 'text-placeholder'],
  ['login-bg-base', 'surface'],
];

describe('登录页面板 / 控件 / 主按钮 = 主界面墨水口径', () => {
  for (const [mode, theme] of [
    ['light', cindyLight],
    ['dark', cindyDark],
  ] as const) {
    it.each(LOGIN_SURFACE_ROLES)(`${mode}: %s 与 %s 同值`, (loginId, mainId) => {
      const main = theme.colors[mainId];
      if (main === undefined) throw new Error(`${theme.id} 缺少 ${mainId}`);
      expect(colorRegistry.resolveDefault(loginId, mode)).toBe(main);
    });
  }
});

/**
 * 浏览器登录回调页(`oauthResultPage.ts`)在系统浏览器里打开,拿不到 renderer 的 token,
 * 颜色以内联 CSS 变量写在三段规则里:浅色、强制深色(`data-theme="dark"`)、系统深色回退
 * (`prefers-color-scheme: dark` 且未指定主题)。只比较注册 token 会漏掉这里,
 * 所以直接解析生成的页面。标题 = 正文档,正文 = 次要档,错误码细节 = 三级档;
 * 页面底 / 卡片 / 描边 / CTA 与登录页同取主界面对应角色(2026-10-27)。
 */
const CALLBACK_VARS: ReadonlyArray<readonly [cssVar: string, inkTierId: string]> = [
  ['--title', 'text-primary'],
  ['--body', 'text-secondary'],
  ['--detail', 'text-tertiary'],
  ['--page', 'surface'],
  ['--card', 'surface-elevated'],
  ['--card-border', 'border-default'],
  ['--cta', 'accent-cta-bg-pure'],
  ['--cta-border', 'accent-cta-bg-pure'],
  ['--cta-text', 'accent-pure-cta-fg'],
];

/** 归一成 `r,g,b,a`:回调页 CSS 用小写短写(#fdfdf8、rgba(0,0,0,.08)),主题用大写全写。 */
function normalizeColor(value: string): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const n = hex[1] ?? '';
    return `${parseInt(n.slice(0, 2), 16)},${parseInt(n.slice(2, 4), 16)},${parseInt(n.slice(4, 6), 16)},1`;
  }
  const match = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/.exec(value.trim());
  if (!match) throw new Error(`无法识别的颜色: ${value}`);
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

describe('浏览器登录回调页 = 主界面墨水口径', () => {
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
      expect(normalizeColor(actual)).toBe(normalizeColor(ink));
    });
  }
});

/** 回调页 CTA 的悬停 / 按下叠层是登录主按钮叠层(`login-overlay-button-*`)的内联副本。 */
const CALLBACK_OVERLAYS: ReadonlyArray<readonly [cssVar: string, loginId: string]> = [
  ['--cta-hover', 'login-overlay-button-hover'],
  ['--cta-active', 'login-overlay-button-pressed'],
];

describe('浏览器登录回调页 CTA 叠层 = 登录主按钮叠层', () => {
  const vars = callbackPageVars(undefined);
  for (const [rule, mode] of [
    ['light', 'light'],
    ['dark', 'dark'],
    ['systemDark', 'dark'],
  ] as const) {
    it.each(CALLBACK_OVERLAYS)(`${rule}: %s 与 %s 同值`, (cssVar, loginId) => {
      const actual = vars[rule][cssVar];
      if (actual === undefined) throw new Error(`${rule} 规则缺少 ${cssVar}`);
      const expected = colorRegistry.resolveDefault(loginId, mode);
      if (expected === null) throw new Error(`${loginId} 缺少 ${mode} 默认值`);
      expect(normalizeColor(actual)).toBe(normalizeColor(expected));
    });
  }
});
