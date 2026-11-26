/**
 * The main process's copy of the cloud strings (see shared/cloudStrings.ts). Native surfaces
 * such as the cloud sign-in window's title read them through the usual main-process t().
 */
import type { SupportedLocale } from '../shared/locale.js';
import { mergeCloudStrings } from '../shared/cloudStrings.js';

import deCloud from '../renderer/i18n/locales/de/cloud.json';
import enCloud from '../renderer/i18n/locales/en/cloud.json';
import esCloud from '../renderer/i18n/locales/es/cloud.json';
import frCloud from '../renderer/i18n/locales/fr/cloud.json';
import idCloud from '../renderer/i18n/locales/id/cloud.json';
import jaCloud from '../renderer/i18n/locales/ja/cloud.json';
import koCloud from '../renderer/i18n/locales/ko/cloud.json';
import ptBRCloud from '../renderer/i18n/locales/pt-BR/cloud.json';
import ptPTCloud from '../renderer/i18n/locales/pt-PT/cloud.json';
import zhCNCloud from '../renderer/i18n/locales/zh-CN/cloud.json';
import zhHansLzhCloud from '../renderer/i18n/locales/zh-Hans-x-lzh/cloud.json';
import zhHantLzhCloud from '../renderer/i18n/locales/zh-Hant-x-lzh/cloud.json';
import zhTWCloud from '../renderer/i18n/locales/zh-TW/cloud.json';

type Bundle = Record<string, unknown>;

const CLOUD: Record<SupportedLocale, Bundle> = {
  de: deCloud,
  en: enCloud,
  es: esCloud,
  fr: frCloud,
  id: idCloud,
  ja: jaCloud,
  ko: koCloud,
  'pt-BR': ptBRCloud,
  'pt-PT': ptPTCloud,
  'zh-CN': zhCNCloud,
  'zh-Hans-x-lzh': zhHansLzhCloud,
  'zh-Hant-x-lzh': zhHantLzhCloud,
  'zh-TW': zhTWCloud,
};

/** Each language's common bundle with its cloud copy folded in. common.json keys win. */
export function withCloudStrings(
  resources: Record<SupportedLocale, Bundle>,
): Record<SupportedLocale, Bundle> {
  return Object.fromEntries(
    Object.entries(resources).map(([locale, common]) => [
      locale,
      mergeCloudStrings(common, CLOUD[locale as SupportedLocale]),
    ]),
  ) as Record<SupportedLocale, Bundle>;
}
