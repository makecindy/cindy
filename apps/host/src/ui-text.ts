import { createMainI18n } from '../../desktop/src/main/i18n.js';
import { configureUiText } from '../../desktop/src/main/uiText.ts';

/**
 * Main-process copy that reaches the user from background services (uiText.ts: the database startup
 * failure, MCP app history titles), in the locale, as bootstrap-electron.ts binds it: a key the
 * catalog lacks keeps the English fallback. The Host reads the process's system language, as its other
 * main-side copy does (release table section 二, item Pi 提示与对话框的语言).
 */
export function bindHostUiText(
  resolveSystemLanguages: () => string[] = () => [Intl.DateTimeFormat().resolvedOptions().locale],
): void {
  const { t } = createMainI18n(resolveSystemLanguages);
  configureUiText((key, fallback) => {
    const localized = t(key);
    return localized === key ? fallback : localized;
  });
}
