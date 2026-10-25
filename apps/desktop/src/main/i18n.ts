import { app } from 'electron';
import { createRuntimeTranslator } from '@cindy/maker-shared/runtime-i18n';
import { mainLocaleResources } from '../shared/mainLocaleResources.js';
import { DEFAULT_LOCALE, resolvePreferredSystemLocale, type SupportedLocale } from '../shared/locale.js';

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


export const { t, lookupWithFallbackForTest, rawMainString, mainStringKeysUnder } = createRuntimeTranslator(mainLocaleResources, getMainLocale);
