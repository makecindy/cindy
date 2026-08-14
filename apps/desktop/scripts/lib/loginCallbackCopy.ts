/**
 * 登录回调页文案的脚本侧读取单点。
 *
 * 文案正本与生产完全同源:renderer locale JSON 的 `login.browserCallback.*`
 * (运行期由 authManager 经 main 迷你 i18n 取用)。脚本跑在 Electron 之外,拿不到
 * 那套 i18n,只能直接读同一批 JSON 文件——所以这里刻意不另建文案表。
 *
 * preview-oauth-pages(本地预览)与 export-login-callback-template(交付服务端的
 * 托管回调模板)共用本模块:两个出口读同一份文案,避免任何一侧悄悄漂移。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BRAND_NAME } from '@cindy/maker-shared/branding';

import type { OAuthResultPageLang } from '../../src/main/oauthResultPage.js';

const LOCALE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/renderer/i18n/locales',
);

/** 页面语言 → renderer locale 候选。 */
export const OAUTH_LANG_TO_APP_LOCALES: Record<OAuthResultPageLang, string[]> = {
  zh: ['zh-CN'],
  'zh-TW': ['zh-TW', 'zh-CN'],
  en: ['en'],
  ja: ['ja'],
  ko: ['ko'],
};

/** 页面语言全集,与 OAUTH_LANG_TO_APP_LOCALES 保持同源。 */
export const OAUTH_RESULT_LANGS = Object.keys(OAUTH_LANG_TO_APP_LOCALES) as OAuthResultPageLang[];

export interface LoginBrowserCallbackCopy {
  successTitle: string;
  successBody: string;
  errorTitle: string;
  errorBody: string;
  returnButton: string;
}

/** 读取生产 `login.browserCallback.*` 文案,并插值 {{appName}}。 */
export function loadLoginCallbackCopy(lang: OAuthResultPageLang): LoginBrowserCallbackCopy {
  for (const locale of OAUTH_LANG_TO_APP_LOCALES[lang]) {
    const file = path.join(LOCALE_DIR, locale, 'common.json');
    if (!existsSync(file)) continue;
    const common = JSON.parse(readFileSync(file, 'utf8')) as {
      login?: { browserCallback?: Record<string, unknown> };
    };
    const raw = common.login?.browserCallback;
    if (!raw) continue;
    const resolve = (key: keyof LoginBrowserCallbackCopy): string => {
      const value = raw[key];
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`login.browserCallback.${key} missing in ${locale}/common.json`);
      }
      return value.replaceAll('{{appName}}', BRAND_NAME);
    };
    return {
      successTitle: resolve('successTitle'),
      successBody: resolve('successBody'),
      errorTitle: resolve('errorTitle'),
      errorBody: resolve('errorBody'),
      returnButton: resolve('returnButton'),
    };
  }
  throw new Error(`No locale file provides login.browserCallback for lang=${lang}`);
}
