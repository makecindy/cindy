import {
  chatEligibleSourcesForModel,
  getModel,
  isAgentSelectableModel,
  nativeDefaultSourceId,
  type ProviderView,
} from '@cindy/model-providers';
import type { AgentKind } from '@cindy/maker-core';

import type { ImSessionRow } from './sessionRepo';

type AuthRow = Pick<ImSessionRow, 'agentKind' | 'model' | 'providerId'>;

export type ImAuthMissing =
  'gateway-key' | 'agent-oauth' | 'provider-key' | 'provider-disconnected';

export type ImAuthCheckResult = { ok: boolean; missing: ImAuthMissing | null };

/** 鉴权检查的可解释结果，供 IM 渠道生成准确的错误提示。 */
export interface ImAuthRouteStatus extends ImAuthCheckResult {
  providerId: string | null;
  providerLabel: string | null;
}

export interface ImAuthCheckDeps {
  readXdGatewayApiKey(): string | null;
  hasCustomProviderKey(providerId: string, agentKind: AgentKind): boolean;
  getAgentAuthState(agentKind: AgentKind): Promise<{ authenticated: boolean }>;
  listProviders(): Promise<ProviderView[]>;
  warn(message: string): void;
}

export async function hasAuthForImRoute(
  row: AuthRow,
  providerSnapshot: ProviderView[] | null | undefined,
  deps: ImAuthCheckDeps,
): Promise<boolean> {
  return (await checkImRouteAuth(row, providerSnapshot, deps)).ok;
}

export async function checkImRouteAuth(
  row: AuthRow,
  providerSnapshot: ProviderView[] | null | undefined,
  deps: ImAuthCheckDeps,
): Promise<ImAuthCheckResult> {
  const resolution = resolveEffectiveProvider(
    row,
    providerSnapshot === undefined ? await listProvidersForAuth(deps) : providerSnapshot,
  );
  return checkImRouteAuthWithResolution(row, resolution, deps);
}

async function checkImRouteAuthWithResolution(
  row: AuthRow,
  resolution: ProviderResolution,
  deps: ImAuthCheckDeps,
): Promise<ImAuthCheckResult> {
  if (resolution.kind === 'provider') {
    const routing = resolution.provider.routing[row.agentKind];
    if (routing?.authStrategy === 'gateway-key') {
      return deps.readXdGatewayApiKey()
        ? { ok: true, missing: null }
        : { ok: false, missing: 'gateway-key' };
    }
    if (routing?.authStrategy === 'oauth-passthrough') {
      return resolution.provider.connected
        ? { ok: true, missing: null }
        : { ok: false, missing: 'provider-disconnected' };
    }
    // provider-oauth-header(bespoke,如 xAI)与 oauth-token(通用 OAuth Runner)同属
    // 「host 注入供应商 OAuth token」策略:鉴权与子进程自带凭证无关,connected(= 本机
    // 已有该供应商凭证)即可通行,不落 fallback(否则无 XD key / 无 agent OAuth 的环境下
    // 已连接的自定义 OAuth 供应商会被误判未鉴权、IM 轮次被无谓阻断)。
    if (
      routing?.authStrategy === 'provider-oauth-header' ||
      routing?.authStrategy === 'oauth-token'
    ) {
      return resolution.provider.connected
        ? { ok: true, missing: null }
        : { ok: false, missing: 'provider-disconnected' };
    }
    if (routing?.authStrategy === 'none') {
      return resolution.provider.connected
        ? { ok: true, missing: null }
        : { ok: false, missing: 'provider-disconnected' };
    }
    if (routing?.authStrategy === 'api-key-header') {
      if (!resolution.provider.connected) return { ok: false, missing: 'provider-disconnected' };
      return hasCustomProviderAuth(resolution.provider, row.agentKind, deps)
        ? { ok: true, missing: null }
        : { ok: false, missing: 'provider-key' };
    }
  }
  if (resolution.kind === 'explicit-invalid') {
    return { ok: false, missing: 'provider-disconnected' };
  }
  return fallbackAuthCheckForImRoute(row, deps);
}

/**
 * 检查 IM 会话实际持久化路由的鉴权状态，并保留供应商上下文。
 *
 * `checkImRouteAuth` 保持只返回兼容旧调用方的布尔/原因结果；新调用方
 * 使用本函数即可避免把存量会话的供应商误报成 Cindy AI。
 */
export async function checkImRouteAuthDetailed(
  row: AuthRow,
  providerSnapshot: ProviderView[] | null | undefined,
  deps: ImAuthCheckDeps,
): Promise<ImAuthRouteStatus> {
  const providers =
    providerSnapshot === undefined ? await listProvidersForAuth(deps) : providerSnapshot;
  const resolution = resolveEffectiveProvider(row, providers);
  const result = await checkImRouteAuthWithResolution(row, resolution, deps);
  const explicitProvider = row.providerId
    ? providers?.find((provider) => provider.id === row.providerId)
    : undefined;
  const effectiveProvider =
    explicitProvider ?? (resolution.kind === 'provider' ? resolution.provider : undefined);
  return {
    ...result,
    providerId: row.providerId ?? effectiveProvider?.id ?? null,
    providerLabel: effectiveProvider?.name ?? null,
  };
}

export function hasCustomProviderAuth(
  provider: ProviderView,
  agentKind: AgentKind,
  deps: ImAuthCheckDeps,
): boolean {
  const routing = provider.routing[agentKind];
  return (
    deps.hasCustomProviderKey(provider.id, agentKind) ||
    hasAuthHeaderOverride(routing?.headerOverride)
  );
}

export function hasAuthHeaderOverride(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  return Object.keys(headers).some((key) => {
    const lower = key.toLowerCase();
    return lower === 'authorization' || lower === 'x-api-key';
  });
}

export type ProviderResolution =
  { kind: 'provider'; provider: ProviderView } | { kind: 'explicit-invalid' } | { kind: 'none' };

export async function listProvidersForAuth(deps: ImAuthCheckDeps): Promise<ProviderView[] | null> {
  try {
    return await deps.listProviders();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.warn(`provider auth route check failed: ${msg}`);
    return null;
  }
}

export function resolveEffectiveProvider(
  row: AuthRow,
  providers: ProviderView[] | null,
): ProviderResolution {
  if (!providers) return row.providerId ? { kind: 'explicit-invalid' } : { kind: 'none' };
  if (row.providerId) {
    // 显式 providerId 命中的这个具体来源上,当前 model id 必须真的是聊天模型才接受
    // (issue #882 第 3 点,2026-07 review):否则鉴权检查会去校验一个非聊天来源的
    // 凭证,校验"通过"也不代表这个会话真能发聊天请求。
    const explicit = providers.find((p) => {
      if (p.id !== row.providerId || !p.connected || !p.agents.includes(row.agentKind)) {
        return false;
      }
      const model = getModel(p, row.model, row.agentKind);
      return (
        model !== undefined &&
        isAgentSelectableModel(model, { userProvider: p.source === 'user' })
      );
    });
    return explicit ? { kind: 'provider', provider: explicit } : { kind: 'explicit-invalid' };
  }
  const sources = chatEligibleSourcesForModel(providers, row.model, row.agentKind);
  const nativeId = nativeDefaultSourceId(sources, row.agentKind);
  const provider = (nativeId ? sources.find((p) => p.id === nativeId) : sources[0]) ?? null;
  return provider ? { kind: 'provider', provider } : { kind: 'none' };
}

export async function fallbackAuthForImRoute(
  row: AuthRow,
  deps: ImAuthCheckDeps,
): Promise<boolean> {
  return (await fallbackAuthCheckForImRoute(row, deps)).ok;
}

async function fallbackAuthCheckForImRoute(
  row: AuthRow,
  deps: ImAuthCheckDeps,
): Promise<ImAuthCheckResult> {
  const hasGatewayKey = Boolean(deps.readXdGatewayApiKey());
  if (row.providerId === 'xd') {
    return hasGatewayKey ? { ok: true, missing: null } : { ok: false, missing: 'gateway-key' };
  }
  if (row.agentKind === 'claude-code') {
    if (!row.model.startsWith('claude-')) {
      return hasGatewayKey ? { ok: true, missing: null } : { ok: false, missing: 'gateway-key' };
    }
    if (hasGatewayKey) return { ok: true, missing: null };
  }
  if (row.agentKind === 'codex' && row.model.startsWith('codex/')) {
    return hasGatewayKey ? { ok: true, missing: null } : { ok: false, missing: 'gateway-key' };
  }
  try {
    return (await deps.getAgentAuthState(row.agentKind)).authenticated
      ? { ok: true, missing: null }
      : { ok: false, missing: 'agent-oauth' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.warn(`auth state check failed for agent=${row.agentKind}: ${msg}`);
    return { ok: false, missing: 'agent-oauth' };
  }
}
