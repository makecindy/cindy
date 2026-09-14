/**
 * 导出托管登录回调页模板,供 auth-server 渲染。
 *
 * 背景:托管回调链路把登录结果页从本机 loopback 挪到 auth-server 自有域名下
 * (见 docs/desktop-login-hosted-callback.md),页面因此要由服务端渲染。为了不让
 * 同一张品牌卡在两个仓库各写一遍、改文案就漂移,这里直接复用**生产同一个渲染器**
 * (renderAuthLoopbackPage → pageKind='desktop-login')把成品 HTML 导出交付。
 *
 * 产物特性:
 *  - 每份 HTML 自带 light / dark(不写 data-theme,页面用 prefers-color-scheme
 *    跟随系统),服务端不需要也不应该分主题挑文件;
 *  - 成功页带 3 秒倒计时并在倒计时结束时自动关闭;失败页留 `{{ERROR_DETAIL}}`
 *    一个占位符给错误码;
 *  - chibi 立绘等资源已是构建期 data URI,HTML 自包含,无外链依赖。
 *
 * 用法:
 *   pnpm --filter desktop run export:login-callback-template [-- --out <dir>]
 * 默认输出到 apps/desktop/dist/login-callback-template(dist 已 gitignore)。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BRAND_NAME } from '@cindy/maker-shared/branding';

import { renderAuthLoopbackPage } from '../src/main/authLoopbackCallback.js';
import {
  LOGIN_CALLBACK_LAYOUT_SCRIPT,
  OAUTH_RESULT_HTML_LANG,
  type OAuthResultPageLang,
} from '../src/main/oauthResultPage.js';
import { DEEP_LINK_URL_PREFIX } from '../src/shared/deepLinkSchemes.js';
import {
  loadLoginCallbackCopy,
  OAUTH_RESULT_LANGS,
} from './lib/loginCallbackCopy.js';

/**
 * 失败页错误码占位符。刻意选无需 HTML 转义的字面量:它会经渲染器的 escapeHtml,
 * 含特殊字符的占位符会被转义成服务端认不出的形态。服务端替换前请自行转义实际值。
 */
const ERROR_DETAIL_PLACEHOLDER = '{{ERROR_DETAIL}}';

/** 失败页回到客户端的 CTA。与生产 buildFocusDeepLink('desktop-login') 同形。 */
const FOCUS_DEEP_LINK = `${DEEP_LINK_URL_PREFIX}focus/desktop-login`;

const DEFAULT_OUT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../dist/login-callback-template',
);

function parseOutDir(argv: string[]): string {
  const flagIndex = argv.indexOf('--out');
  if (flagIndex === -1) return DEFAULT_OUT_DIR;
  const value = argv[flagIndex + 1];
  if (!value) throw new Error('--out 需要一个目录路径');
  return path.resolve(value);
}

interface ExportedPage {
  lang: OAuthResultPageLang;
  htmlLang: string;
  variant: 'success' | 'error';
  file: string;
  /** 该页内联脚本的 CSP sha256（含引号），供服务端直接拼进 script-src。 */
  scriptHashes: string[];
}

function renderPage(
  lang: OAuthResultPageLang,
  variant: 'success' | 'error',
): string {
  const copy = loadLoginCallbackCopy(lang);
  const isError = variant === 'error';
  return renderAuthLoopbackPage({
    htmlLang: OAUTH_RESULT_HTML_LANG[lang],
    variant,
    title: isError ? copy.errorTitle : copy.successTitle,
    body: isError ? copy.errorBody : copy.successBody,
    closeCountdown: isError ? undefined : copy.closeCountdown,
    detail: isError ? ERROR_DETAIL_PLACEHOLDER : undefined,
    action: isError ? { href: FOCUS_DEEP_LINK, label: copy.returnButton } : undefined,
  });
}

/**
 * 结果页内联脚本的 CSP sha256（含引号，可直接拼进 script-src）。
 *
 * 直接对渲染器导出的脚本常量取值,不从渲染完成的 HTML 里反向解析——那既依赖 HTML
 * 解析细节(结束标签的空白与垃圾属性等变体),也会被 CodeQL 判成「对渲染结果做哈希」。
 * 常量与模板里实际内联的是同一份文本,所以 hash 必然对得上。
 */
const LAYOUT_SCRIPT_HASH = `'sha256-${createHash('sha256')
  .update(LOGIN_CALLBACK_LAYOUT_SCRIPT, 'utf8')
  .digest('base64')}'`;

function main(): void {
  const outDir = parseOutDir(process.argv.slice(2));
  const pages: ExportedPage[] = [];

  for (const lang of OAUTH_RESULT_LANGS) {
    mkdirSync(path.join(outDir, lang), { recursive: true });
    for (const variant of ['success', 'error'] as const) {
      const file = path.join(lang, `${variant}.html`);
      const html = renderPage(lang, variant);
      writeFileSync(path.join(outDir, file), html, 'utf8');
      pages.push({
        lang,
        htmlLang: OAUTH_RESULT_HTML_LANG[lang],
        variant,
        // manifest 里统一用 POSIX 分隔符,免得 Windows 导出的清单在服务端对不上。
        file: file.split(path.sep).join('/'),
        scriptHashes: [LAYOUT_SCRIPT_HASH],
      });
    }
  }

  const manifest = {
    brandName: BRAND_NAME,
    source: 'apps/desktop/src/main/oauthResultPage.ts (pageKind=desktop-login)',
    contract: 'docs/desktop-login-hosted-callback.md',
    focusDeepLink: FOCUS_DEEP_LINK,
    placeholders: {
      [ERROR_DETAIL_PLACEHOLDER]:
        '失败页错误码;替换前需按 HTML 文本节点转义。无错误码时连同其 <p class="detail"> 一并删除。',
    },
    notes: [
      '每份 HTML 自带 light/dark(prefers-color-scheme),不要按主题拆分。',
      // 与 docs/desktop-login-hosted-callback.md §3.4 保持一致:登录事务在 provider
      // 回调阶段已被消费,托管回调这一步拿不到 authorize 时传的 ui_locale。
      '语言按浏览器 Accept-Language 选择(托管回调阶段已取不到 ui_locale);缺省回落 en。',
      '模板随客户端文案变更需重新导出,不要在服务端侧手改 HTML。',
      'pages[].scriptHashes 直接拼进结果页的 CSP script-src;该内联脚本负责布局、成功页 3 秒倒计时与自动关闭,不要改成 unsafe-inline,也不要自行解析 HTML 重算。',
    ],
    pages,
  };
  writeFileSync(
    path.join(outDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  process.stdout.write(`导出 ${pages.length} 个页面 → ${outDir}\n`);
}

main();
