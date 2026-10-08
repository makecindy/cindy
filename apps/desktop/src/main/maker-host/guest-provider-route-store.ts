/**
 * 供应商分享受邀者会话的出站边界：受邀者的任务只能经分享给它的那一个供应商发请求。
 *
 * 远程 Agent host 启动受邀者任务前登记(release 在任务结束时调用)：
 *  - 会话来源(session-provider-store)写成分享的供应商，proxy 按会话显式来源路由；
 *  - 签发路由令牌。托管会话不在 Maker 的活跃会话表里，Claude Code 的请求经自定义请求头
 *    带上令牌，Claude proxy 据此认出这条会话；Codex / Pi 的请求按会话 id 找到登记。
 * proxy 对受邀者请求只放行这个供应商、且是它提供的模型；其余一律本地拒绝，不改道。
 * 只对受邀者生效，本机用户自己的任务不经过这里。
 */
import { randomBytes } from 'node:crypto';

import type { AgentKind } from '@cindy/model-providers';

import { getActiveCatalog } from './active-catalog.js';
import { clearSessionProvider, getSessionProvider, setSessionProvider } from './session-provider-store.js';

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

interface Binding extends GuestProviderRoute {
  token: string;
}

const byToken = new Map<string, Binding>();
const bySession = new Map<string, Binding>();

/**
 * 登记一条受邀者会话。同一任务重新打开时新登记取代旧的；release 只撤销自己这一次登记。
 */
export function registerGuestProviderRoute(
  sessionId: string,
  providerId: string,
): { token: string; release(): void } {
  const token = randomBytes(32).toString('base64url');
  const binding: Binding = { sessionId, providerId, token };
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

/** 1M 通道后缀只是窗口标记，不是另一个模型。 */
function bareModelId(model: string): string {
  return model.trim().replace(/\[1m\]$/i, '');
}

/** 分享的供应商是否为这个 Agent 提供这个模型(请求里的模型串，忽略 1M 通道后缀)。 */
export function guestProviderOffersModel(providerId: string, agent: AgentKind, wireModel: string): boolean {
  const requested = bareModelId(wireModel);
  if (!requested) return false;
  const provider = getActiveCatalog().providers.find((candidate) => candidate.id === providerId);
  return (provider?.models[agent] ?? []).some((model) => bareModelId(model.id) === requested);
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
