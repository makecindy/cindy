/**
 * Cloud Cindy copy lives in `locales/<locale>/cloud.json`, not in `common.json`.
 * It joins the `common` namespace when a language loads, so call sites keep their keys.
 * common.json wins on a key with the same path; `cloudStrings.test` reports that.
 */
import { mergeCloudStrings } from '../../shared/cloudStrings';
import enCloud from './locales/en/cloud.json';

export { mergeCloudStrings };

type JsonModule = { default: Record<string, unknown> };
type Bundle = Record<string, unknown>;

// Literal paths so Vite splits each language and the ui:check bundle can resolve them.
const CLOUD_LOADERS: Record<string, () => Promise<JsonModule>> = {
  'zh-CN': () => import('./locales/zh-CN/cloud.json'),
  'zh-TW': () => import('./locales/zh-TW/cloud.json'),
  ja: () => import('./locales/ja/cloud.json'),
  ko: () => import('./locales/ko/cloud.json'),
  es: () => import('./locales/es/cloud.json'),
  fr: () => import('./locales/fr/cloud.json'),
  de: () => import('./locales/de/cloud.json'),
  'pt-PT': () => import('./locales/pt-PT/cloud.json'),
  'pt-BR': () => import('./locales/pt-BR/cloud.json'),
  'zh-Hant-x-lzh': () => import('./locales/zh-Hant-x-lzh/cloud.json'),
  'zh-Hans-x-lzh': () => import('./locales/zh-Hans-x-lzh/cloud.json'),
};

/** The statically bundled English fallback with its cloud copy. */
export function withEnglishCloudStrings(common: Bundle): Bundle {
  return mergeCloudStrings(common, enCloud);
}

/** Wraps a lazy `common` loader so the language's cloud copy arrives in the same bundle. */
export function withCloudLoader(
  locale: string,
  namespace: string,
  load: (() => Promise<JsonModule>) | undefined,
): (() => Promise<JsonModule>) | undefined {
  const cloud = CLOUD_LOADERS[locale];
  if (!load || namespace !== 'common' || !cloud) return load;
  return async () => {
    const [common, extra] = await Promise.all([load(), cloud()]);
    return { default: mergeCloudStrings(common.default, extra.default) };
  };
}
