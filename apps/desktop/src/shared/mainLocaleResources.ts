import type { SupportedLocale } from './locale.js';
import enCommon from '../renderer/i18n/locales/en/common.json';
import zhCNCommon from '../renderer/i18n/locales/zh-CN/common.json';
import zhTWCommon from '../renderer/i18n/locales/zh-TW/common.json';
import jaCommon from '../renderer/i18n/locales/ja/common.json';
import koCommon from '../renderer/i18n/locales/ko/common.json';

export const mainLocaleResources: Record<SupportedLocale, Record<string, unknown>> = {
  en: enCommon as Record<string, unknown>,
  'zh-CN': zhCNCommon as Record<string, unknown>,
  'zh-TW': zhTWCommon as Record<string, unknown>,
  ja: jaCommon as Record<string, unknown>,
  ko: koCommon as Record<string, unknown>,
};

