/**
 * 移动端 i18n 入口 —— 同步 init i18next,导出常量与类型(镜像 desktop renderer/i18n)。
 *
 * 设计要点:
 * - 资源同步 import(零网络/零 IO),i18n.init 同步完成 → 首屏不闪 key。
 * - 首选语言取系统语言(而非 DEFAULT_LOCALE):用户未设置 override 时首帧即正确;
 *   持久化的 override 由 LocaleProvider 挂载后异步读出再切换,切换发生在启动
 *   splash 覆盖层之下,不产生可见闪变。
 * - 单 namespace 'common';fallbackLng = en,缺 key 不显示 key 本身。
 * - 不接 LanguageDetector backend,偏好全部走 languagePreferenceStore(AsyncStorage)。
 */

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { BRAND_NAME } from '@cindy/maker-shared/branding';

import enCommon from './locales/en';
import zhCNCommon from './locales/zh-CN';
import jaCommon from './locales/ja';
import koCommon from './locales/ko';
import { DEFAULT_LOCALE } from './locale';
import { detectSystemLocale } from './systemLocale';

export {
  DEFAULT_LOCALE,
  isLocalePreference,
  isSupportedLocale,
  resolveSystemLocale,
  SUPPORTED_LOCALES,
} from './locale';
export type { LocalePreference, SupportedLocale } from './locale';
export { detectSystemLocale } from './systemLocale';

const resources = {
  en: { common: enCommon },
  'zh-CN': { common: zhCNCommon },
  ja: { common: jaCommon },
  ko: { common: koCommon },
} as const;

// 同步 init —— 没有 backend / detector / suspense,i18n.init 立即返回。
void i18n.use(initReactI18next).init({
  resources,
  lng: detectSystemLocale(),
  // 缺 key 回退英文(主干 4 语,无繁体 catalog)。
  fallbackLng: { default: [DEFAULT_LOCALE] },
  defaultNS: 'common',
  ns: ['common'],
  interpolation: {
    escapeValue: false, // React 已转义
    // 品牌名单一事实源:文案里的 {{appName}} 全部由此注入(与 desktop 同约定)。
    defaultVariables: { appName: BRAND_NAME },
  },
  returnNull: false,
});

export { i18n };
export default i18n;
