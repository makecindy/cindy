// 交互页面生成手册（PAGE-GENERATION.md）的 CDN 路径约定。
//
// 路径同时带客户端版本号和手册字节的 sha256：版本号便于排查时看出对应哪个客户端，
// sha256 保证同一版本号若打出不同内容的手册（重新出包、各区域从不同提交出包）也不会
// 悄悄对上错的文件。发布脚本 scripts/publish-page-manual.mjs 使用本文件；客户端运行时用
// `app.getVersion()` 和内置手册的 sha256 拼地址时也从这里取路径，不另写一份。CDN 地址是
// `cdnBaseUrl + "/" + 相对路径`，OSS key 是 `prefix + "/" + 同一相对路径`。

/** 相对内置 system-skills 根目录的手册路径（打包后位于 Resources/system-skills 下同一相对路径）。 */
export const PLUGIN_PAGE_MANUAL_SKILL_PATH =
  'cindy-plugin-creator/references/examples/interactive-pages/PAGE-GENERATION.md';

/**
 * 校验进入路径的客户端版本号：x.y.z，可带预发布后缀；不允许斜杠、`..` 等路径字符。
 * 0.0.0（及 0.0.0-*）是仓库占位 / 开发版版本，没有发布的手册。
 */
export function assertPluginPageManualVersion(version) {
  if (
    typeof version !== 'string'
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(version)
    || version.includes('..')
  ) {
    throw new Error(`页面手册路径需要 x.y.z（可带预发布后缀）的客户端版本号，收到: ${String(version)}`);
  }
  if (version === '0.0.0' || version.startsWith('0.0.0-')) {
    throw new Error(`${version} 是仓库占位 / 开发版版本，没有发布的手册；请传本次发版的真实版本号`);
  }
}

/** 手册相对 CDN 根 / OSS 前缀的路径：`mcp-apps/manual/<版本号>/<sha256>.md`。 */
export function pluginPageManualCdnPath(version, sha256) {
  assertPluginPageManualVersion(version);
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`页面手册路径需要小写十六进制 sha256，收到: ${String(sha256)}`);
  }
  return `mcp-apps/manual/${version}/${sha256}.md`;
}
