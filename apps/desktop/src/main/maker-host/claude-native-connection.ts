/**
 * claude-native-connection —— 本机 Claude Code 登录的连接 / 断开与按需重读。
 *
 * 登录本身由内置 CLI 完成(claude-native-cli);这里只管 Cindy 的使用许可
 * (nativeProviderAuthBinding)与供应商展示态。判定是否已连接用 claude-native-auth。
 */

import {
  bindNativeProviderAuth,
  isNativeProviderAuthBound,
  unbindNativeProviderAuth,
} from './nativeProviderAuthBinding.js';
import { retainProviderPresentationAfterAuthChange } from './provider-presentation-store.js';
import { readClaudeCliLoginStatus, type ClaudeCliLoginStatus } from './claude-native-cli.js';

/** 按需重读 CLI 登录态。已连接时返回登录态,否则 null。 */
export async function readClaudeNativeLogin(options?: { maxAgeMs?: number }): Promise<ClaudeCliLoginStatus | null> {
  if (!isNativeProviderAuthBound('anthropic')) return null;
  const status = await readClaudeCliLoginStatus(options);
  return status.loggedIn ? status : null;
}

/** 授权 Cindy 使用本机 Claude Code 登录(登录由 CLI 完成,这里只记使用许可)。 */
export function connectClaudeNativeLogin(): void {
  bindNativeProviderAuth('anthropic', { sharedSystem: true });
  void retainProviderPresentationAfterAuthChange('anthropic');
}

/** 撤销 Cindy 的使用许可;不登出 CLI。 */
export async function disconnectClaudeNativeLogin(): Promise<void> {
  unbindNativeProviderAuth('anthropic', { revoked: true });
  await retainProviderPresentationAfterAuthChange('anthropic');
}
