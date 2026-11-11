/**
 * 供应商分享受邀者会话的出站边界：受邀者的任务只能经分享给它的那一个供应商发请求。
 *
 * 远程 Agent host 启动受邀者任务前登记(release 在任务结束时调用)：
 *  - 会话来源(session-provider-store)写成分享的供应商，proxy 按会话显式来源路由；
 *  - 签发路由令牌。托管会话不在 Maker 的活跃会话表里，Claude Code 的请求经自定义请求头
 *    带上令牌，Claude proxy 据此认出这条会话；Codex / Pi 的请求按会话 id 找到登记。
 * proxy 对受邀者请求只放行这个供应商、且是它提供的模型；其余一律本地拒绝，不改道。
 * 同账号远程任务复用下方的目录模型匹配，通过独立的 owner 登记校验实时授权；本机任务不受限制。
 */
import { randomBytes } from 'node:crypto';

import { findCatalogModel, type AgentKind } from '@cindy/model-providers';

import { getActiveCatalog } from './active-catalog.js';
import { clearSessionProvider, getSessionProvider, hasHostedSessionModelAccess, hostedSessionModelAllowed, setSessionProvider } from './session-provider-store.js';

/**
 * Claude Code 请求带上的路由令牌请求头。与 maker-core 的 DEVICE_HOSTED_GUEST_ROUTE_HEADER 同值
 * (单测守护)；proxy 在启动早期加载，不为一个常量引入 maker-core。
 */
export const GUEST_ROUTE_HEADER = 'x-cindy-guest-route';

export interface GuestProviderRoute {
  /** 本机侧任务 id(远程 Agent host 的 hostSessionId)。 */
  sessionId: string;
  /** 分享给受邀者的供应商。 */
  providerId: string;
}

export interface GuestRequestUsage {
  model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number;
}
interface Binding extends GuestProviderRoute {
  token: string;
  recordUsage?: (sample: GuestRequestUsage) => void;
  allowsModel?: (model: string) => boolean | Promise<boolean>;
  modelAccessRestricted?: () => boolean;
  modelDenial?: (model: string) => { code: string; message: string } | null;
}

const byToken = new Map<string, Binding>();
const bySession = new Map<string, Binding>();

/**
 * 登记一条受邀者会话。同一任务重新打开时新登记取代旧的；release 只撤销自己这一次登记。
 */
export function registerGuestProviderRoute(
  sessionId: string,
  providerId: string,
  allowsModel?: (model: string) => boolean | Promise<boolean>,
  modelAccessRestricted?: () => boolean,
  modelDenial?: (model: string) => { code: string; message: string } | null,
  recordUsage?: (sample: GuestRequestUsage) => void,
): { token: string; release(): void } {
  const token = randomBytes(32).toString('base64url');
  const binding: Binding = { sessionId, providerId, token, allowsModel, modelAccessRestricted, modelDenial, recordUsage };
  const previous = bySession.get(sessionId);
  if (previous) byToken.delete(previous.token);
  byToken.set(token, binding);
  bySession.set(sessionId, binding);
  setSessionProvider(sessionId, providerId);
  let released = false;
  return {
    token,
    release: () => {
      if (released) return;
      released = true;
      byToken.delete(token);
      if (bySession.get(sessionId) !== binding) return;
      bySession.delete(sessionId);
      clearSessionProvider(sessionId);
    },
  };
}

/**
 * 按令牌找受邀者会话。会话来源被清掉(例如账号边界清空了全部会话来源)后不再认这条登记：
 * proxy 没有可靠的来源可路由，按拒绝处理。
 */
export function guestProviderRouteForToken(token: string): GuestProviderRoute | null {
  const binding = byToken.get(token);
  if (!binding || bySession.get(binding.sessionId) !== binding) return null;
  return getSessionProvider(binding.sessionId) === binding.providerId
    ? { sessionId: binding.sessionId, providerId: binding.providerId }
    : null;
}

/** 按本机侧任务 id 找受邀者会话(Codex / Pi 的请求按会话 id 找到它)。 */
export function guestProviderRouteForSession(sessionId: string): GuestProviderRoute | null {
  const binding = bySession.get(sessionId);
  return binding ? { sessionId: binding.sessionId, providerId: binding.providerId } : null;
}

/** Legacy SDK aliases may differ by the 1M suffix when the catalog has only one profile. */
function bareModelId(model: string): string {
  return model.trim().replace(/\[1m\]$/i, '');
}

/** 核对目录与授权时优先匹配请求的窗口档位；单条目的旧 SDK 后缀别名仍兼容。 */
export async function guestProviderOffersModel(providerId: string, agent: AgentKind, wireModel: string, sessionId?: string): Promise<boolean> {
  const models: string[] = [];
  providerOffersModel(providerId, agent, wireModel, model => { models.push(model); return false; });
  for (const model of models) {
    if (!sessionId || await guestProviderModelAllowed(providerId, model, sessionId)) return true;
  }
  return false;
}

/** Same-account remote tasks authorize each root/child request without pinning children to the parent provider. */
export function hostedProviderOffersModel(sessionId: string | null | undefined, providerId: string | null | undefined, agent: AgentKind, wireModel: string): boolean {
  if (!sessionId || !hasHostedSessionModelAccess(sessionId)) return true;
  return !!providerId && providerOffersModel(providerId, agent, wireModel,
    model => hostedSessionModelAllowed(sessionId, providerId, model));
}

function providerOffersModel(providerId: string, agent: AgentKind, wireModel: string, allowsModel?: (model: string) => boolean): boolean {
  const requested = bareModelId(wireModel);
  if (!requested) return false;
  const provider = getActiveCatalog().providers.find((candidate) => candidate.id === providerId);
  if (agent === 'pi') {
    // Pi native subscriptions send bare wire ids; grants use the catalog's namespaced ids.
    // Keep distinct context profiles exact so one profile cannot borrow another's grant.
    const model = findCatalogModel(provider, wireModel, agent, { exact: true });
    return Boolean(model && !model.disabled && (!allowsModel || allowsModel(model.id)));
  }
  const profiles = (provider?.models[agent] ?? []).filter(model => bareModelId(model.id) === requested);
  const longContext = /\[1m\]$/i.test(wireModel.trim());
  const exactProfiles = profiles.filter(model => /\[1m\]$/i.test(model.id.trim()) === longContext);
  // Select the catalog profile before checking grants or disabled state; neither
  // a denied nor a disabled profile may borrow access from its sibling.
  return (exactProfiles.length ? exactProfiles : profiles).some((model) => !model.disabled
    && (!allowsModel || allowsModel(model.id)));
}

/** A shared proxy without a task identity cannot bypass an active member's model restrictions. */
export async function guestProviderModelAllowed(providerId: string, model: string, sessionId: string | null | undefined): Promise<boolean> {
  if (sessionId) {
    const binding = bySession.get(sessionId);
    if (binding?.providerId !== providerId) return false;
    try {
      const allowed = !binding.allowsModel || await binding.allowsModel(model);
      return allowed && bySession.get(sessionId) === binding && getSessionProvider(sessionId) === providerId;
    } catch { return false; }
  }
  return ![...bySession.values()].some((binding) => binding.providerId === providerId && binding.modelAccessRestricted?.());
}

/**
 * 受邀者任务的 Codex host 只登记分享的那个供应商的自定义路由(分享的不是自定义供应商时一条也不登记)。
 * 本机用户自己的任务(guestProviderId 缺省)原样返回。
 */
export function restrictCodexRoutesToGuestProvider<T extends { providerId: string }>(
  routes: T[],
  guestProviderId: string | undefined,
): T[] {
  return guestProviderId === undefined ? routes : routes.filter((route) => route.providerId === guestProviderId);
}

/** 只供单测：清空全部登记。 */
export function resetGuestProviderRoutesForTest(): void {
  for (const binding of bySession.values()) clearSessionProvider(binding.sessionId);
  byToken.clear();
  bySession.clear();
}

/** Only the authenticated, still-current binding may explain a member refusal. */
export function guestProviderModelDenial(sessionId: string | null | undefined, model: string, kind?: AgentKind) {
  if (!sessionId) return null;
  const binding = bySession.get(sessionId);
  if (!binding || getSessionProvider(sessionId) !== binding.providerId) return null;
  try {
    const provider = getActiveCatalog().providers.find(item => item.id === binding.providerId);
    const catalogModel = kind ? findCatalogModel(provider, model, kind)?.id ?? model : model;
    return binding.modelDenial?.(catalogModel) ?? null;
  } catch { return null; }
}

/** Request-scoped native usage, including child requests. No response content is retained. */
export function captureGuestRequestUsage(sessionId: string | null | undefined, model: string) {
  const binding = sessionId ? bySession.get(sessionId) : undefined;
  if (!binding?.recordUsage || !model) return undefined;
  let settled = false;
  return (value: unknown) => {
    if (settled || bySession.get(binding.sessionId) !== binding || getSessionProvider(binding.sessionId) !== binding.providerId) return;
    const record = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
    const frame = record(value);
    if (!frame || (typeof frame.type === 'string' && frame.type.startsWith('response.')
      && frame.type !== 'response.completed' && frame.type !== 'response.incomplete')) return;
    const response = record(frame.response) ?? frame;
    const usage = record(response.usage);
    if (!usage) return;
    const input = usage.input_tokens ?? usage.prompt_tokens;
    const output = usage.output_tokens ?? usage.completion_tokens;
    const cache = record(usage.input_tokens_details)?.cached_tokens ?? record(usage.prompt_tokens_details)?.cached_tokens ?? 0;
    const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
    if (!valid(input) || !valid(output) || !valid(cache) || cache > input) return;
    settled = true;
    binding.recordUsage!({ model, inputTokens: input - cache, outputTokens: output, cacheReadTokens: cache, cacheCreateTokens: 0 });
  };
}
