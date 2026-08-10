/**
 * i18n 入口 —— 同步 init i18next，导出常量与类型。
 *
 * 设计要点：
 * - 资源同步 import (零网络/零 IO)，i18n.init 同步完成 → React 首屏不闪。
 * - 单 namespace 'common'，后续按 feature 切分时再加 (cc-agent / scheduler / ...)。
 * - fallbackLng：缺 key 时不显示 key 本身,直接回退英文。
 * - 不接 LanguageDetector backend，用户偏好全部在 useLocale 里走 localStorage。
 *   'system' 的实际语言由 main 侧读取 OS 首选语言后传入 renderer。
 */

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { BRAND_NAME } from '@cindy/maker-shared/branding';

import enCommon from './locales/en/common.json';
import zhCNCommon from './locales/zh-CN/common.json';
import zhTWCommon from './locales/zh-TW/common.json';
import jaCommon from './locales/ja/common.json';
import koCommon from './locales/ko/common.json';
import { DEFAULT_LOCALE } from '../../shared/locale';

export {
  DEFAULT_LOCALE,
  resolvePreferredSystemLocale,
  resolveSystemLocale,
  SUPPORTED_LOCALES,
} from '../../shared/locale';
export type { LocalePreference, SupportedLocale } from '../../shared/locale';

const resources = {
  en: { common: enCommon },
  'zh-CN': { common: zhCNCommon },
  'zh-TW': { common: zhTWCommon },
  ja: { common: jaCommon },
  ko: { common: koCommon },
} as const;

// 同步 init —— 没有 backend / detector / suspense，i18n.init 立即返回。
// 不 await 也安全：所有 t() 调用之前 init 已经完成 (本文件 import 即 init)。
void i18n.use(initReactI18next).init({
  resources,
  lng: DEFAULT_LOCALE,
  // 缺 key 回退英文。
  fallbackLng: { default: [DEFAULT_LOCALE] },
  defaultNS: 'common',
  ns: ['common'],
  interpolation: {
    escapeValue: false, // React 已转义
    // 品牌名单一事实源:locale 文案里的 {{appName}} 全部由此注入,改名只改
    // @cindy/maker-shared/branding 的 BRAND_NAME(见该文件对"不跟随改名"标识符的说明)。
    defaultVariables: { appName: BRAND_NAME },
  },
  returnNull: false,
});

export { i18n };
export default i18n;
