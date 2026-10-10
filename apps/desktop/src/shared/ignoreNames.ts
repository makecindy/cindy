/**
 * ignoreNames — 内置忽略名单(纯数据)。
 *
 * 真源已迁至 @cindy/file-browser-core:desktop main / renderer 与远端
 * file-service daemon 三处共享同一份定义,避免名单在客户端与 daemon 之间漂移。
 * renderer 侧用它做「关掉『显示被忽略的目录』时,立刻滤掉 reveal 态根列表里的
 * 一级忽略目录」(见 useFileTree 的 seed 说明)——慢通道下不这样滤,关开关后
 * node_modules / build 这些行会在「已隐藏」的视图里滞留数秒。
 *
 * ⚠️ 必须走 /ignoreNames 子路径导出而不是包根:本文件被 renderer 消费,包根
 * barrel 会把 scanner / RipgrepSearcher 等 Node-only 实现(node:fs、node:path)
 * 一起拖进浏览器 bundle(同类说明见 shared/textFileExts.ts)。
 */

export {
  BUILTIN_IGNORE_ALWAYS,
  BUILTIN_IGNORE_REVEALABLE,
  REVEALABLE_IGNORE_DIR_NAMES,
} from '@cindy/file-browser-core/ignoreNames';
