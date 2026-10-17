// First module of every UI page bundle: runs before any product module is evaluated, so
// product code that reads storage, platform or window.electronAPI at import time sees the
// scenario environment instead of a missing host.
import { writeStoredLocale } from '../../../src/renderer/lib/localePreference';
import { installHost } from './host';
import type { UiPageContext, UiPageRuntime } from './types';

// Startup failures end the wait for readiness immediately instead of at the variant timeout.
const fail = (message: string) => {
  if (!(window as unknown as { __uiPage?: UiPageRuntime }).__uiPage?.ready)
    document.documentElement.dataset.uiPageError ||= message;
};
addEventListener('error', (event) => fail(event.message));
addEventListener('unhandledrejection', (event) =>
  fail(String(event.reason?.stack ?? event.reason)),
);

const ctx = JSON.parse(document.getElementById('ui-page-context')!.textContent!) as UiPageContext;

const runtime: UiPageRuntime = {
  ctx,
  hostMissing: [],
  mutations: [],
  missingTranslations: [],
  ready: false,
};
(window as unknown as { __uiPage: UiPageRuntime }).__uiPage = runtime;

localStorage.clear();
// Same preference keys the product reads on startup (useTheme STORAGE_KEY, localePreference),
// plus the first-launch marker so the login light-mode gate does not override the theme.
localStorage.setItem('theme', ctx.theme);
localStorage.setItem('login.firstLaunchLightShown', '1');
writeStoredLocale(ctx.locale);
for (const [key, value] of Object.entries(ctx.storage ?? {})) localStorage.setItem(key, value);
document.documentElement.lang = ctx.locale;
document.documentElement.dataset.platform = ctx.platform;
document.documentElement.dataset.windowBackdropMaterial = 'none';
installHost(runtime, { platform: ctx.platform, windowBackdropMaterial: 'none' });
