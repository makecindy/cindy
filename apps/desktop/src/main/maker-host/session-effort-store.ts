/**
 * session-effort-store —— 每个会话当前的 effort(思维深度)档与 Fast 模式开关,供
 * responses-bridge 路由注入用(bridge 会话态的单一入口,两者同生命周期、同注入路径)。
 *
 * 背景:Claude Code 子进程**不会**把非 Anthropic 模型(chatgpt/ / xai/ 前缀,经 bridge)的 effort
 * 放进请求体(实测请求里无 thinking / reasoning 字段);Fast 模式在 cc 二进制里是 Anthropic Opus
 * 专属 beta,对 bridge 模型同样不落请求体。所以用户选的思维深度 / Fast 都无法经请求体流到 bridge。
 * 这里在 host 侧记下每个会话的档位(SET_EFFORT / SET_FAST_MODE 时写,bootstrapSession 时从 DB
 * hydrate),compat-proxy 的 routingTransform 在路由决策点读出、闭包进订阅直连 handler 的
 * prefs;handler 再分别映射成 Responses 的 reasoning.effort / service_tier。不走任何伪 header。
 *
 * 纯内存;keyed by xdt sessionId(与 session-provider-store 同键)。未记录的会话 → effort 读到
 * null(bridge 回退默认档)、fast 读到 false(不发 service_tier)。条目是 sessionId → 短字符串 /
 * 布尔,量级 = 本次运行触过的会话数。普通进程关闭不清理,使 runtime override 能跨 lazy
 * rehydrate 保留；任务归档/删除的终态边界会清理,复开后由 bootstrapSession / IM turnRunner
 * 从 DB baseline 重新 hydrate。
 */

const bySession = new Map<string, string>();
const fastBySession = new Set<string>();

/** 记下某会话当前 effort(SET_EFFORT / hydrate 时调用); nullish/空值显式清除。 */
export function setSessionEffort(sessionId: string, effort: string | null | undefined): void {
  const normalized = effort?.trim();
  if (normalized) bySession.set(sessionId, normalized);
  else bySession.delete(sessionId);
}

/** 读取某会话 effort;未记录返回 null(bridge 走默认档)。 */
export function getSessionEffort(sessionId: string): string | null {
  return bySession.get(sessionId) ?? null;
}

/** 记下某会话 Fast 模式开关(SET_FAST_MODE / hydrate 时调用;false 即清除)。 */
export function setSessionFastMode(sessionId: string, enabled: boolean): void {
  if (enabled) fastBySession.add(sessionId);
  else fastBySession.delete(sessionId);
}

/** 读取某会话 Fast 模式;未记录返回 false(bridge 不发 service_tier)。 */
export function getSessionFastMode(sessionId: string): boolean {
  return fastBySession.has(sessionId);
}

/** 账户 / app-session 边界清理全部 owner-scoped 运行时轴。 */
export function clearAllSessionRuntimeAxes(): void {
  bySession.clear();
  fastBySession.clear();
}
