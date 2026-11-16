/** Desktop locale discovery; translations and fallbacks are shared with Host. */
import { app } from 'electron';
import { createMainI18n } from './i18n.js';
const mainI18n = createMainI18n(() => {
  let languages: string[] = [];
  try { languages = app.getPreferredSystemLanguages(); } catch { /* not ready */ }
  if (!languages.length) {
    try { languages = [app.getLocale()]; } catch { /* not ready */ }
  }
  return languages;
});
export const { setMainLocale, setMainClassicalStyle, getMainClassicalStyle, getResolvedMainLocale, t, tCount, lookupWithFallbackForTest, rawMainString, mainStringKeysUnder } = mainI18n;
