// 交互页面生成手册（PAGE-GENERATION.md）的 CDN 路径约定。
//
// 手册按内容寻址：对象名是手册字节的 sha256，客户端用自己内置手册的 sha256 拼出地址，
// 内容相同的多个版本共用同一个文件。发布脚本 scripts/publish-page-manual.mjs 使用本文件；
// 客户端运行时拼手册地址时也从这里取路径，不另写一份。CDN 地址是
// `cdnBaseUrl + "/" + 相对路径`，OSS key 是 `prefix + "/" + 同一相对路径`（与壁纸的
// `wallpapers/<sha256>.<ext>` 约定一致）。

/** 相对内置 system-skills 根目录的手册路径（打包后位于 Resources/system-skills 下同一相对路径）。 */
export const PLUGIN_PAGE_MANUAL_SKILL_PATH =
  'cindy-plugin-creator/references/examples/interactive-pages/PAGE-GENERATION.md';

/** 手册相对 CDN 根 / OSS 前缀的路径：`plugin-pages/manual/<sha256>.md`。 */
export function pluginPageManualCdnPath(sha256) {
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`页面手册路径需要小写十六进制 sha256，收到: ${String(sha256)}`);
  }
  return `plugin-pages/manual/${sha256}.md`;
}
