/**
 * legalLinks — 服务条款 / 隐私协议链接的区域分流单点(consent PR,与桌面
 * shared/legalLinks.ts 同 URL 权威源)。
 *
 * 区域 = 构建期 EXPO_PUBLIC_CINDY_AUTH_REGION(env.ts AUTH_REGION);dev 归 cn 系
 * (与登录 identifier 形态同口径)。国内走 protocol.xd.cn,国际走 protocol.xd.com;
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
  termsOfService: 'https://protocol.xd.cn/cindy/agreement.html',
  privacyPolicy: 'https://protocol.xd.cn/cindy/privacy-1.0.html',
};

const GLOBAL_LEGAL_LINKS: LegalLinks = {
  termsOfService: 'https://protocol.xd.com/cindy/agreement-1.0.html',
  privacyPolicy: 'https://protocol.xd.com/cindy/privacy.html',
};

/** 本构建区域的协议链接(dev 归 cn 系)。 */
export const LEGAL_LINKS: LegalLinks =
  AUTH_REGION === 'global' ? GLOBAL_LEGAL_LINKS : CN_LEGAL_LINKS;
