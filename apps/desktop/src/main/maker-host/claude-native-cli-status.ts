/**
 * claude-native-cli-status —— 内置 Claude Code CLI 登录态的内存缓存(纯内存、无 IO)。
 *
 * 由 claude-native-cli 的 `claude auth status` 读取结果写入;只需要判断「连没连上」的
 * 模块读这里即可,不必连带加载 CLI 拉起 / 代理解析等依赖。
 */

import type { ClaudeCliLoginStatus } from '@cindy/model-providers/provider-auth/claude-cli-status';
export type { ClaudeCliLoginStatus };

let cachedStatus: ClaudeCliLoginStatus | null = null;
let cachedAt = 0;
const statusListeners = new Set<(status: ClaudeCliLoginStatus) => void>();
let onListenerError: (error: unknown) => void = () => {};

/** 最近一次读到的 CLI 登录态;尚未读过时为 null(调用方按未登录处理)。 */
export function peekClaudeCliLoginStatus(): ClaudeCliLoginStatus | null {
  return cachedStatus;
}

/** 缓存是否不超过 maxAgeMs(从未读到过 = 不新鲜)。 */
export function isClaudeCliLoginStatusFresh(maxAgeMs: number): boolean {
  return cachedStatus !== null && Date.now() - cachedAt <= maxAgeMs;
}

/** 登录态变化(含首次读到)时回调;返回取消订阅函数。 */
export function onClaudeCliLoginStatusChange(listener: (status: ClaudeCliLoginStatus) => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

/** @internal claude-native-cli 注入监听器异常的日志出口。 */
export function setClaudeCliLoginStatusListenerErrorHandler(handler: (error: unknown) => void): void {
  onListenerError = handler;
}

function sameStatus(a: ClaudeCliLoginStatus | null, b: ClaudeCliLoginStatus): boolean {
  return (
    a !== null &&
    a.loggedIn === b.loggedIn &&
    a.notSubscription === b.notSubscription &&
    a.email === b.email &&
    a.subscriptionType === b.subscriptionType &&
    a.authMethod === b.authMethod
  );
}

/** @internal 由 claude-native-cli 写入最新读取结果;变化时通知监听器。 */
export function publishClaudeCliLoginStatus(status: ClaudeCliLoginStatus): void {
  const changed = !sameStatus(cachedStatus, status);
  cachedStatus = status;
  cachedAt = Date.now();
  if (!changed) return;
  for (const listener of statusListeners) {
    try {
      listener(status);
    } catch (err) {
      onListenerError(err);
    }
  }
}

/** @internal 单测用。 */
export function resetClaudeCliLoginStatusForTest(): void {
  cachedStatus = null;
  cachedAt = 0;
  statusListeners.clear();
}
