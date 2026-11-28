/**
 * legalLinks — 服务条款 / 隐私协议 / 礼品卡条款链接的区域分流单点。
 * 协议版本号见 legalTermsVersion.ts(不读区域,main 也能直接引用)。
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
  /** 礼品卡购买与使用条款(购买礼品卡确认区引用) */
  giftCardTerms: string;
}

// 礼品卡条款与 /terms、/privacy 同口径:官网域名下的固定路径,正文由法务在 protocol 域名维护,
// 官网 CDN 回源到对应页面(国内 protocol.xd.cn/cindy/sdk-agreement-1.0.html,国际
// protocol.xd.com/cindy/sdk-data-collection-1.0.html)。条款改版只换回源地址,客户端不发版。
const CN_LEGAL_LINKS: LegalLinks = {
  termsOfService: 'https://cindy.cn/terms',
  privacyPolicy: 'https://cindy.cn/privacy',
  giftCardTerms: 'https://cindy.cn/gift-card-terms',
};

const GLOBAL_LEGAL_LINKS: LegalLinks = {
  termsOfService: 'https://cindy.app/terms',
  privacyPolicy: 'https://cindy.app/privacy',
  giftCardTerms: 'https://cindy.app/gift-card-terms',
};

/** 本构建区域的协议链接(dev 区域归 cn 系,与登录 identifier 形态同口径)。 */
export const LEGAL_LINKS: LegalLinks =
  CURRENT_CINDY_REGION === 'global' ? GLOBAL_LEGAL_LINKS : CN_LEGAL_LINKS;

