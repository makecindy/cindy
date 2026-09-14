import type { AgentKind } from '../types/common.js';
import type { AgentCredentialMode } from '../interfaces/auth-adapter.js';

export interface ResolveAgentCredentialModeOptions {
  agentKind: AgentKind;
  providerId?: string | null;
  model?: string | null;
}

/** Cindy Provider 中由 Codex Responses 上游实现远程压缩的模型路由。 */
export function isCindyProviderCodexRemoteCompactionRoute(input: {
  providerId: string | null | undefined;
  model: string | null | undefined;
}): boolean {
  const providerId = input.providerId?.trim() || null;
  const model = input.model?.trim() ?? '';
  return (
    (providerId === null || providerId === 'xd') &&
    model.startsWith('codex/') &&
    model.length > 'codex/'.length
  );
}

/**
 * 根据本次会话的显式来源推导子进程凭证形态。
 *
 * XD 一律走网关 key,官方订阅来源走各自 runtime 的 OAuth。
 * 其它显式来源(内建 xAI、跨 runtime 的 OpenAI、自定义 API Key / OAuth)
 * 均由 host/proxy 按会话注入真实凭证,子进程只需要占位凭证。
 *
 * 未指定来源时只按有唯一归属的命名空间模型前缀推断;其它返回
 * undefined,由各 adapter 保持既有 fallback。
 */
export function resolveAgentCredentialMode(
  options: ResolveAgentCredentialModeOptions,
): AgentCredentialMode | undefined {
  const providerId = options.providerId?.trim() || null;
  if (providerId === 'xd') return 'gateway-key';
  if (options.agentKind === 'claude-code' && providerId === 'anthropic') return 'oauth-bearer';
  if (options.agentKind === 'codex' && providerId === 'openai') return 'oauth-bearer';
  if (providerId) return 'provider-oauth';

  const model = options.model?.trim() ?? '';
  if (model.startsWith('codex/')) return 'gateway-key';
  if (model.startsWith('chatgpt/') || model.startsWith('xai/')) return 'provider-oauth';
  return undefined;
}

/**
 * 把"未显式指定来源"(requested=undefined)归一化成 auth fallback 实际会用的凭证形态。
 *
 * 背景:providerId 为 null 的会话解析出 undefined,而共享 host 的复用比较是严格相等——
 * undefined 和"显式来源但实际同一种钥匙"会被误判成两种形态,触发不必要的进程重启;
 * 有任何会话在忙时重启永远等不到窗口,新会话表现为永远排队(2026-07-03 实报)。
 * fallback 的实际钥匙由 AuthState.authSource 决定(codex adapter:oauth 优先,其次网关 key),
 * 在比较前把 undefined 解析成它,同族会话即可共用现有进程。
 */
export function resolveEffectiveCredentialModeFromAuthSource(
  requested: AgentCredentialMode | undefined,
  authSource: 'oauth' | 'api-key' | undefined,
): AgentCredentialMode | undefined {
  if (requested) return requested;
  if (authSource === 'oauth') return 'oauth-bearer';
  if (authSource === 'api-key') return 'gateway-key';
  return undefined;
}

/**
 * 共享 host 复用判定:默认对**归一化后**的形态做严格相等。
 *
 * 消除误判靠的是入参先过 resolveEffectiveCredentialModeFromAuthSource(null-provider
 * 会话解析成 fallback 实际钥匙形态,再与登记形态比较);这里**刻意不**给 undefined 开
 * 绿灯——解析不出形态(未登录 / adapter 无 authSource / getState 失败)时保持既有
 * 保守语义:宁可要求重建,也不把意图不明的会话挂到显式凭证进程上(safety 不变量,
 * 见 codex/index.test.ts "does not reuse an explicit credential host")。
 *
 * provider-oauth 是特例(历史命名,亦包含 host 注入的 API key):子进程凭证只作
 * 占位,真实供应商凭证由 proxy 按 session 覆盖,
 * 所以 credential family 上可复用任意已存在的明确凭证 host;反过来不允许 provider-oauth
 * host 承载其它凭证形态。实际 Codex host 复用还必须额外确认该 host 的 loopback proxy
 * 可用,否则 provider-oauth 所需的 token 注入 / model rewrite 无法发生。
 */
export function canReuseHostForCredentialMode(
  currentMode: AgentCredentialMode | undefined,
  requestedMode: AgentCredentialMode | undefined,
): boolean {
  if (requestedMode === 'provider-oauth' && currentMode !== undefined) return true;
  return currentMode === requestedMode;
}

/**
 * Codex 专用的共享 host 复用判定:在通用规则之上增加「订阅超集 host」放宽 ——
 * oauth-bearer spawn 的本地 app-server 经 loopback proxy 具备按请求换网关 key 的
 * 能力(折扣模型分支与 per-session 显式 XD 路由均为已上线行为),因此 gateway-key
 * 诉求的会话可以直接复用 oauth-bearer host,不再触发全 host 重建 —— 这是消除
 * 「订阅/API 会话切换排队」的关键(方案 A,2026-07)。
 *
 * 反向不放宽:gateway-key(env-key spawn)进程不带 OAuth token,proxy 在 env-key
 * 注入态也不做 per-session 订阅路由,服务不了订阅会话。调用方仍需额外确认该 host
 * 的 proxy 出口可用(见 CodexAgent.canReuseHostForCredentialRequest):退化直连的
 * oauth host 上,key 会话的请求会带着 OAuth token 直打网关 → 401,必须重建。
 */
export function canReuseCodexHostForCredentialMode(
  currentMode: AgentCredentialMode | undefined,
  requestedMode: AgentCredentialMode | undefined,
): boolean {
  if (requestedMode === 'gateway-key' && currentMode === 'oauth-bearer') return true;
  return canReuseHostForCredentialMode(currentMode, requestedMode);
}
