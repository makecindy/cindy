import { BRAND_NAME } from './branding.js';

export type RuntimeLocale = 'en' | 'zh-CN' | 'zh-TW' | 'ja' | 'ko';
type SupportedLocale = RuntimeLocale;
const DEFAULT_LOCALE: SupportedLocale = 'en';
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


/** Original main-side translation behavior, shared by GUI and Node hosts. */
export function createRuntimeTranslator(resources: Record<SupportedLocale, Record<string, unknown>>, getMainLocale: () => SupportedLocale) {
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
function t(key: string, locale?: SupportedLocale): string {
  const loc = locale ?? getMainLocale();
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
function lookupWithFallbackForTest(
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

/**
 * Raw template for `key` (no interpolation) walking the same fallback chain as t(), or null
 * when no locale has it. For native surfaces that fill their own placeholders.
 */
function rawMainString(key: string, locale?: SupportedLocale): string | null {
  const loc = locale ?? getMainLocale();
  for (const chainLocale of FALLBACK_CHAIN[loc]) {
    const raw = lookup(resources[chainLocale], key);
    if (raw !== null) return raw.replaceAll('{{appName}}', BRAND_NAME);
  }
  return null;
}

/** Leaf keys under `prefix` in the default locale, relative to `prefix` (dot-separated). */
function mainStringKeysUnder(prefix: string): string[] {
  let cur: unknown = resources[DEFAULT_LOCALE];
  for (const part of prefix.split('.')) {
    if (typeof cur !== 'object' || cur === null) return [];
    cur = (cur as Record<string, unknown>)[part];
  }
  const keys: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      keys.push(path);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    for (const [key, value] of Object.entries(node)) walk(value, path ? `${path}.${key}` : key);
  };
  walk(cur, '');
  return keys;
}

return { t, lookupWithFallbackForTest, rawMainString, mainStringKeysUnder };
}
