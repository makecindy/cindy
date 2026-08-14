/**
 * Main-process minimal i18n.
 *
 * Used for dialogs that fire before any renderer window exists (e.g. the
 * macOS App Translocation prompt at app-ready). The renderer's localStorage
 * language preference is not reachable at that moment, so we fall back to
 * the OS preferred language list via resolvePreferredSystemLocale.
 *
 * Locale JSONs are imported from the renderer's i18n bundle to avoid
 * duplicating string tables. They are pure data, so the cross-layer import
 * does not violate the main/renderer logic separation. If main-process
 * strings ever grow beyond a couple of dialogs, move the locales to
 * shared/i18n/locales/ and update both call sites.
 */
import { app } from 'electron';
import { BRAND_NAME } from '@cindy/maker-shared/branding';

import {
  DEFAULT_LOCALE,
  resolvePreferredSystemLocale,
  type SupportedLocale,
} from '../shared/locale.js';

import enCommon from '../renderer/i18n/locales/en/common.json';
import zhCNCommon from '../renderer/i18n/locales/zh-CN/common.json';
import zhTWCommon from '../renderer/i18n/locales/zh-TW/common.json';
import jaCommon from '../renderer/i18n/locales/ja/common.json';
import koCommon from '../renderer/i18n/locales/ko/common.json';

const resources: Record<SupportedLocale, Record<string, unknown>> = {
  en: enCommon as Record<string, unknown>,
  'zh-CN': zhCNCommon as Record<string, unknown>,
  'zh-TW': zhTWCommon as Record<string, unknown>,
  ja: jaCommon as Record<string, unknown>,
  ko: koCommon as Record<string, unknown>,
};

/**
 * 与 renderer i18next 的 fallbackLng 对齐:缺 key 先落本 locale 再落 en。
 * 链尾统一由 t() 落回 key 本身。
 */
const FALLBACK_CHAIN: Record<SupportedLocale, readonly SupportedLocale[]> = {
  'zh-CN': ['zh-CN', 'en'],
  'zh-TW': ['zh-TW', 'zh-CN', 'en'],
  en: ['en'],
  ja: ['ja', 'en'],
  ko: ['ko', 'en'],
};

let cachedLocale: SupportedLocale | null = null;

function resolveOsLocale(): SupportedLocale {
  // app.getPreferredSystemLanguages() returns [] before app-ready. All
  // current callers fire after ready, but defend anyway so a stray early
  // t() call cannot throw.
  let langs: string[] = [];
  try {
    langs = app.getPreferredSystemLanguages();
  } catch {
    /* not ready */
  }
  if (langs.length === 0) {
    try {
      langs = [app.getLocale()];
    } catch {
      /* not ready */
    }
  }
  if (langs.length === 0) return DEFAULT_LOCALE;
  return resolvePreferredSystemLocale(langs);
}

function getMainLocale(): SupportedLocale {
  if (cachedLocale) return cachedLocale;
  cachedLocale = resolveOsLocale();
  return cachedLocale;
}

/**
 * Keep main-process native surfaces in sync with the renderer language
 * preference after the renderer has mounted.
 */
export function setMainLocale(locale: SupportedLocale): void {
  cachedLocale = locale;
}

/**
 * Resolved main-side locale (renderer preference after sync, OS fallback
 * before). learn-host 用它决定蒸馏自述的语言(跟随系统语言配置,规则 9:
 * 用代码注入确定性语言,不靠模型从请求里猜)。
 */
export function getResolvedMainLocale(): SupportedLocale {
  return getMainLocale();
}

function lookup(bundle: Record<string, unknown>, key: string): string | null {
  let cur: unknown = bundle;
  for (const part of key.split('.')) {
    if (typeof cur !== 'object' || cur === null) return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'string' ? cur : null;
}

/**
 * Translate a dot-path key (e.g. 'update.moveToApplications.title') using
 * the OS-resolved main-side locale, walking the locale's FALLBACK_CHAIN
 * (zh-TW → zh-CN → en; others → en), then falling back to the key itself.
 *
 * 与 renderer i18next 的 interpolation.defaultVariables 对齐:locale 文案里的
 * {{appName}} 由品牌常量注入(本迷你 i18n 不支持其它变量,main 消费的 key 若
 * 需要更多插值,应像 bootstrap 菜单那样在调用点自行 replace)。
 */
export function t(key: string): string {
  const loc = getMainLocale();
  let raw: string | null = null;
  for (const chainLocale of FALLBACK_CHAIN[loc]) {
    raw = lookup(resources[chainLocale], key);
    if (raw !== null) break;
  }
  raw ??= lookup(resources[DEFAULT_LOCALE], key) ?? key;
  return raw.replaceAll('{{appName}}', BRAND_NAME);
}

/**
 * 测试专用:用注入的资源表跑同一条 fallback 链(i18nFallback.test.ts 用人为
 * 删 key 的隔离负 fixture 验证 zh-TW → zh-CN → en → key,不污染真实资源)。
 */
export function lookupWithFallbackForTest(
  bundles: Partial<Record<SupportedLocale, Record<string, unknown>>>,
  locale: SupportedLocale,
  key: string,
): string {
  for (const chainLocale of FALLBACK_CHAIN[locale]) {
    const bundle = bundles[chainLocale];
    if (!bundle) continue;
    const raw = lookup(bundle, key);
    if (raw !== null) return raw;
  }
  const fallbackBundle = bundles[DEFAULT_LOCALE];
  return (fallbackBundle ? lookup(fallbackBundle, key) : null) ?? key;
}
