/**
 * session-provider-store —— 每个会话显式选定的供应商 id(per-session 路由用)。
 *
 * 写入:`SET_MODEL` 携带 providerId 时。读取:路由层(loopback proxy 的 routingTransform
 * 经 host resolver)决定本会话请求发去哪个上游、用哪把钥匙。
 *
 * 语义:
 *   - 有 providerId  → 路由按 catalog 的 RoutingDescriptor(统一路由器,见 provider-route.ts)。
 *   - 无 / null      → 路由走**默认**(cc: spawn-aware 默认 / codex: decideCodexRoute),
 *                      与未升级行为逐字节一致(no-break)。
 *
 * 内存为主(运行中会话即时生效,支持会话中途切换);持久化到 `sessions.provider_id`
 * 由 renderer 经 local-db sessions:update 落盘(与 model/effort 同模式),进程重启后
 * 由 hydrate 回填(老会话该列为空 → 不写入 → 默认路由)。
 */

const bySession = new Map<string, string | null>();

/** Canonical provider id used by runtime routing and every persistence adapter. */
export function normalizeSessionProviderId(
  providerId: string | null | undefined,
): string | null | undefined {
  if (providerId === undefined) return undefined;
  if (typeof providerId !== 'string') return null;
  return providerId.trim() || null;
}

/** 设定某会话的供应商(SET_MODEL 携带 providerId 时调用)。null/'' = 清除显式选择。 */
export function setSessionProvider(sessionId: string, providerId: string | null): void {
  bySession.set(sessionId, normalizeSessionProviderId(providerId) ?? null);
}

/**
 * 启动派发边界(`prepareStartOptions` 钩子)冻结调用方携带的来源:登记须早于第一次
 * send 且不经 DB 往返 —— renderer 那份排在 createSession 之后、落库失败只记日志,
 * 会让会话永久未登记而恒走默认路由。`undefined` = 调用方未携带选择,不写入:
 * learn-host 等路径自己在 createSession 前写好 store,写 null 会清掉它们的选择。
 * proxy 在 createSession 返回前反解不到 sessionId,首 turn 误路由(#4154)不在此闭合。
 */
export function freezeSessionProviderAtStart(
  sessionId: string,
  providerId: string | null | undefined,
): void {
  if (providerId !== undefined) setSessionProvider(sessionId, providerId);
}

/** 读取某会话的供应商;未设置或已清除返回 null(调用方据此走默认路由)。 */
export function getSessionProvider(sessionId: string): string | null {
  return bySession.get(sessionId) ?? null;
}

/** 内存里是否已有该会话的来源条目(含显式 null)。未 hydrate 时为 false。 */
export function hasSessionProvider(sessionId: string): boolean {
  return bySession.has(sessionId);
}

/**
 * 从持久化值回填(会话加载时调用)。仅在内存尚无该会话条目时写入,
 * 不覆盖运行中已有的更新值(避免 DB 旧值盖掉本次 turn 刚切的供应商)。
 */
export function hydrateSessionProvider(sessionId: string, providerId: string | null): void {
  if (!bySession.has(sessionId)) {
    bySession.set(sessionId, normalizeSessionProviderId(providerId) ?? null);
  }
}

/** 会话关闭/销毁时清理内存条目。 */
export function clearSessionProvider(sessionId: string): void {
  bySession.delete(sessionId);
}

/** 账户 / app-session 边界清理全部 owner-scoped 路由。 */
export function clearAllSessionProviders(): void {
  bySession.clear();
}
