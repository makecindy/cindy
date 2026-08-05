/**
 * 共享的请求 header 读取工具。
 *
 * transform.ts 与 server.ts 都要从 flatten 后的 headers 里按名取值(大小写不敏感),
 * 收口到这里避免两份相同实现随时间漂移。
 */

/**
 * 取 threadId 的默认 header 候选名(按序取第一个非空)。收口到一处,避免
 * server.ts / transform.ts / host 各写一份字面量随时间漂移。
 *
 * 顺序按"稳定性"排:
 *   - x-claude-code-session-id —— Claude Code 每个会话稳定(cc-code client.ts 注入),
 *     Layer-2 主动剥离要靠它跨 turn 命中同一会话的标记。
 *   - thread-id                —— Codex app-server 每个 thread 稳定。
 *   - x-client-request-id      —— **每请求唯一**,只作最后兜底;命中它时 Layer-2 标记
 *     跨不过下一请求(但 Layer-1 反应式仍每轮兜底,功能不受影响,只是少省一次往返)。
 */
export const DEFAULT_THREAD_ID_HEADERS = [
  'x-claude-code-session-id',
  'thread-id',
  'x-client-request-id',
] as const;

/** 取单个 header 值(大小写不敏感),取不到返回空串。 */
export function headerValue(headers: Readonly<Record<string, string>>, name: string): string {
  const direct = headers[name];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && value.trim()) return value.trim();
  }
  return '';
}

/** 按候选名顺序取第一个非空 header 值,都没有则返回空串。 */
export function selectedHeaderValue(
  headers: Readonly<Record<string, string>>,
  names: readonly string[],
): string {
  for (const name of names) {
    const value = headerValue(headers, name);
    if (value) return value;
  }
  return '';
}
