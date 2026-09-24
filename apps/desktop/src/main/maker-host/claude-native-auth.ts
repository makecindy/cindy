/**
 * claude-native-auth —— 「Cindy 能否使用本机 Claude Code 登录」的唯一判定(同步、只读缓存)。
 *
 * 两个条件同时成立才算已连接:
 *   1. 内置 CLI 已登录(claude-native-cli 的 `auth status` 结果,Cindy 不读凭证);
 *   2. 当前 owner 授权了 Cindy 使用这份登录(nativeProviderAuthBinding,可被「断开」撤销)。
 *
 * 断开只撤销第 2 条,CLI 的登录(也是终端里 `claude` 的登录)保持不动。需要重读登录态、
 * 连接 / 断开时用 claude-native-connection。
 */

import { isNativeProviderAuthBound } from './nativeProviderAuthBinding.js';
import { peekClaudeCliLoginStatus } from './claude-native-cli-status.js';

/** 已连接(CLI 已登录 + Cindy 已获使用许可)。同步读缓存,未读到过登录态时为 false。 */
export function hasClaudeNativeLogin(): boolean {
  // 先看内存缓存,未登录时不必读绑定文件。
  return peekClaudeCliLoginStatus()?.loggedIn === true && isNativeProviderAuthBound('anthropic');
}

/** CLI 是否已登录,不看 Cindy 的使用许可(自动认领 / 升级迁移用)。 */
export function hasClaudeNativeLoginUnbound(): boolean {
  return peekClaudeCliLoginStatus()?.loggedIn === true;
}
