import type { SupportedLocale } from '../../../src/shared/locale';
export type UiPageTheme = 'light' | 'dark';

/** Serialized by the runner into the page; identical shape for every engine. */
export interface UiPageContext {
  page: string;
  case: string;
  theme: UiPageTheme;
  locale: SupportedLocale;
  platform: 'darwin' | 'win32' | 'linux';
  viewport: { width: number; height: number };
  /** JSON data declared by the page case; the fixture and the Playwright checks read the same values. */
  data: Record<string, unknown>;
  storage?: Record<string, string>;
}

export interface UiPageRuntime {
  ctx: UiPageContext;
  /** Host API paths the product read but the scenario did not provide (resolved as undefined). */
  hostMissing: string[];
  /** Host writes attempted through `forbid()` handlers; a check fails if any exist. */
  mutations: string[];
  /** `${locale}:${key}` entries i18next could not resolve in the active locale. */
  missingTranslations: string[];
  ready: boolean;
  /** Deliver a host event to listeners registered through `subscription(name)`; returns listener count. */
  emit?: (name: string, payload: unknown) => number;
  t?: (key: string, options?: Record<string, unknown>) => string;
  /** True when `text` is a key the page requested through t() or one the resources define. */
  isTranslationKey?: (text: string) => boolean;
  cases?: string[];
}
