/**
 * regionUserData — 按构建区域选择 Electron userData 目录。
 *
 * 背景:cn / global 是两个可同机并存的系统身份(appId / exe / 安装目录已按
 * 区域派生),但 Electron 默认 userData 目录由 package.json productName('Cindy')
 * 派生,两个区域的包会共用同一目录——数据库 / 登录态 / 单实例锁全部串台。
 * 因此 global 构建与 dev 启动都在 main 入口最早期(initLogger、crashReporter、
 * 单实例锁、一切 userData 读取之前)把 userData 切到当前区域目录。正式目录保持
 * 历史兼容：cn=`Cindy`、global=`CindyGlobal`；内部 dev 身份使用 `CindyDev`。
 *
 * 语义边界:
 *  - cn 构建的区域目录名 = productName 默认派生目录 → 返回 null,零改动,
 *    保持 Electron 原生行为(线上 cn 包与历史行为完全一致)。
 *  - 非 packaged 启动同样按区域选正式 profile；`--isolated` 再由 devCliFlags
 *    基于这个区域目录派生 `<区域目录>-dev2[-<名字>]`。
 *  - 命令行显式传了 Chromium 原生 `--user-data-dir` 时返回 null，尊重调用方。
 *    `XDT_USER_DATA_DIR` 是 devCliFlags 的最终覆写；这里仍先建立区域默认
 *    profile，确保隔离 epoch comparison 以 CindyGlobal / Cindy / CindyDev 为基线。
 *  - 只决定**目录名**,拼绝对路径(appData 基址)留给调用方——本模块保持
 *    零 Electron 依赖,可直接单测。
 */

import {
  BRAND_IDENTITY,
  brandUserDataDirName,
  type CindyRegion,
} from '@cindy/maker-shared/brand-identity';

/** argv 里是否显式指定了 Chromium 原生 --user-data-dir(= 与空格两种形态)。 */
function hasExplicitUserDataDir(argv: readonly string[]): boolean {
  return argv.some((a) => a === '--user-data-dir' || a.startsWith('--user-data-dir='));
}

/**
 * 解析本构建是否需要覆写 userData 目录。
 * 返回目录名(调用方拼到 appData 下)或 null(保持 Electron 默认)。
 */
export function resolveRegionUserDataDirName(input: {
  isPackaged: boolean;
  region: CindyRegion;
  argv: readonly string[];
  envUserDataDir?: string;
}): string | null {
  if (hasExplicitUserDataDir(input.argv)) return null;
  const dirName = brandUserDataDirName(input.region);
  // 与 productName 默认派生目录同名(cn)→ 不覆写,走 Electron 原生路径。
  if (dirName === BRAND_IDENTITY.userDataDirName) return null;
  return dirName;
}
