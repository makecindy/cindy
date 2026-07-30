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

/** 读取某会话的供应商;未设置或已清除返回 null(调用方据此走默认路由)。 */
export function getSessionProvider(sessionId: string): string | null {
  return bySession.get(sessionId) ?? null;
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
