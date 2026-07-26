/**
 * brandRegion — 本构建的区域身份(cn/global)与区域派生 appId 的运行时单点。
 *
 * 区域在**构建期**经 VITE_CINDY_AUTH_REGION 烘焙(main 走 vite.main.config.ts
 * 的 define,renderer 走标准 Vite env;生产由 desktopClientBuildEnv 注入,dev /
 * 未注入一律默认 global)。运行时不可切换——cn 与 global 是两个可并存的系统身份
 * (com.xd.cindycn / com.xd.cindy,与 mobile 同一套命名)。
 *
 * ⚠️ AUMID 三位一体:本文件的 CURRENT_APP_ID 必须与 NSIS appId(forge.config
 * 按同一 region 从 brandAppId() 取值)、快捷方式 AUMID 逐字符一致,否则
 * Windows toast 通知被静默丢弃。
 */

import {
  brandAppId,
  resolveCindyRegion,
  type CindyRegion,
} from '@cindy/maker-shared/brand-identity';

/** 本构建的区域(构建期烘焙;dev 默认 global)。 */
export const CURRENT_CINDY_REGION: CindyRegion = resolveCindyRegion(
  import.meta.env?.VITE_CINDY_AUTH_REGION,
);

/** 本构建的系统身份 id(Windows AUMID / macOS bundle id)。 */
export const CURRENT_APP_ID: string = brandAppId(CURRENT_CINDY_REGION);
