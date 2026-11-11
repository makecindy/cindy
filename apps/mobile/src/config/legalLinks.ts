/**
 * legalLinks — 服务条款 / 隐私协议链接的区域分流单点(consent PR,与桌面
 * shared/legalLinks.ts 同 URL 权威源)。
 *
 * 区域 = 构建期 EXPO_PUBLIC_CINDY_AUTH_REGION(env.ts AUTH_REGION);dev 归 cn 系
 * (与登录 identifier 形态同口径)。国内走 cindy.cn,国际走 cindy.app;
 * 链接一律 `Linking.openURL` 交系统默认浏览器打开。
 */

import { AUTH_REGION } from '@/config/env';

export interface LegalLinks {
  /** 服务条款 */
  termsOfService: string;
  /** 隐私协议 */
  privacyPolicy: string;
}

const CN_LEGAL_LINKS: LegalLinks = {
  termsOfService: 'https://cindy.cn/terms',
  privacyPolicy: 'https://cindy.cn/privacy',
};

const GLOBAL_LEGAL_LINKS: LegalLinks = {
  termsOfService: 'https://cindy.app/terms',
  privacyPolicy: 'https://cindy.app/privacy',
};

/** 本构建区域的协议链接(dev 归 cn 系)。 */
export const LEGAL_LINKS: LegalLinks =
  AUTH_REGION === 'global' ? GLOBAL_LEGAL_LINKS : CN_LEGAL_LINKS;
