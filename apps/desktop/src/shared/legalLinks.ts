/**
 * legalLinks — 服务条款 / 隐私协议链接的区域分流单点。
 *
 * 区域与 brandRegion 同口径:构建期 VITE_CINDY_AUTH_REGION 烘焙,运行时不可
 * 切换(cn 与 global 是两个可并存的系统身份)。国内走 cindy.cn,国际走
 * cindy.app;链接一律经系统默认浏览器打开(renderer 走
 * `window.electronAPI.openExternal`,channel `shell:open-external` 只放行 http(s))。
 */

import { CURRENT_CINDY_REGION } from './brandRegion';

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

/** 本构建区域的协议链接(dev 区域归 cn 系,与登录 identifier 形态同口径)。 */
export const LEGAL_LINKS: LegalLinks =
  CURRENT_CINDY_REGION === 'global' ? GLOBAL_LEGAL_LINKS : CN_LEGAL_LINKS;
