/**
 * 供应商分享的主进程 REST 适配(契约 docs/provider-sharing-contract.md §3、§4)。
 * 令牌只在既有的已鉴权 HTTP 客户端里；账号或区域切换后迟到的结果作废。
 */
import { createHash } from 'node:crypto';

import {
  ProviderShareScopeChangedError,
  buildProviderShareLink,
  createProviderShareApi,
  type SharedTaskInvitationApp,
  type ProviderShareApi,
} from '@cindy/device-link';

import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getAuthState, getDeviceId } from '../authManager.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { serverApiFetch } from '../serverApiClient.desktop.js';
import type { IpcErrorCode } from '../../shared/ipc-errors.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { createProviderShareDelegationChecks, type DelegationCheckInput,
  type DelegationCheckResult } from './providerShareDelegationChecks.js';
import { agentNetSelectionKey, isAgentNetActive, agentNetAllowsLegacy, agentNetOnlyEncryptedByUser } from './agentNetRuntime.js';
import { agentNetSharingAlias, agentNetSharingInvitation, agentNetSharingInvitationRoute, agentNetSharingRoute,
  listAgentNetProviderShares, rememberAgentNetSharingAliases, rememberAgentNetSharingGuest, rememberAgentNetSharingHost,
  rememberAgentNetSharingService, requestAgentNetSharing, retireAgentNetSharingGuest, selectedAgentNetSharingRoute,
  type AgentNetSharingRoute } from './agentNetSharing.js';
import { grantAgentNetProviderExecutor, revokeAgentNetProviderExecutor, checkAgentNetProviderExecutor } from './agentNetSharing.js';

/** 服务端错误码 → 本机 IPC 错误码(Renderer 据此给出可行动的提示)。 */
const ACTIONABLE_CODES: Readonly<Record<string, IpcErrorCode>> = {
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'PRECONDITION_FAILED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  INVALID_PARAMS: 'INVALID_PARAMS',
  BAD_REQUEST: 'INVALID_PARAMS',
  RATE_LIMITED: 'PRECONDITION_FAILED',
  PROVIDER_SHARE_LINK_USED: 'PROVIDER_SHARE_LINK_USED',
  PROVIDER_SHARE_LINK_EXPIRED: 'PROVIDER_SHARE_LINK_EXPIRED',
  PROVIDER_SHARE_SELF: 'PROVIDER_SHARE_SELF',
  PROVIDER_SHARE_ALREADY_MEMBER: 'PROVIDER_SHARE_ALREADY_MEMBER',
  PROVIDER_SHARE_IDENTITY_INVALID: 'PROVIDER_SHARE_IDENTITY_INVALID',
  PROVIDER_SHARE_NOT_HOST_DEVICE: 'PROVIDER_SHARE_NOT_HOST_DEVICE',
  PROVIDER_SHARE_CROSS_REGION_DISABLED: 'PROVIDER_SHARE_CROSS_REGION_DISABLED',
};
const ALLOWED_REDACTED_CODES = Object.keys(ACTIONABLE_CODES);

function captureScope() {
  const key = activeOwnerScopeKey();
  const endpoint = getClientEndpoint('deviceLinkApiBaseUrl');
  const selection = agentNetSelectionKey();
  return {
    key: JSON.stringify([key, endpoint]),
    isCurrent: () => getAuthState().isAuthenticated && !isAppSessionBoundaryPending()
      && activeOwnerScopeKey() === key && getClientEndpoint('deviceLinkApiBaseUrl') === endpoint && agentNetSelectionKey() === selection,
  };
}

export function rethrowProviderShareError(error: unknown): never {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  // Error 属性过不了 Electron 序列化：只保留可行动的错误码，不带服务端原文与口令。
  const mapped = typeof code === 'string' && Object.hasOwn(ACTIONABLE_CODES, code) ? ACTIONABLE_CODES[code] : undefined;
  if (mapped) throwIpcError(mapped, 'Provider share request rejected');
  if (code === 'NETWORK_ERROR') throwIpcError('DEVICE_LINK_NOT_CONNECTED', 'Provider share service unreachable');
  throw error;
}

const legacyProviderShareApi = createProviderShareApi({
  captureScope,
  async request(path, options) {
    try {
      if (!agentNetAllowsLegacy()) throwIpcError('DEVICE_LINK_NOT_CONNECTED', 'Encrypted sharing route required');
      return await serverApiFetch<unknown>(path, {
        method: options.method,
        body: options.body,
        // 每次物理请求(含自动刷新令牌后重试)前复验：换了账号或区域不能提交旧口令。
        baseUrl: () => {
          if (!options.isCurrent()) throw new ProviderShareScopeChangedError();
          return getClientEndpoint('deviceLinkApiBaseUrl');
        },
        timeoutMs: 15_000,
        cache: 'no-store',
        logLabel: '/api/device-link/provider-shares',
        redactErrorDetails: true,
        allowedRedactedErrorCodes: ALLOWED_REDACTED_CODES,
      });
    } catch (error) {
      rethrowProviderShareError(error);
    }
  },
});

function scopedApi(route: AgentNetSharingRoute): ProviderShareApi {
  return createProviderShareApi({ captureScope, async request(path, options) {
    if (!options.isCurrent()) throw new ProviderShareScopeChangedError();
    try { return await requestAgentNetSharing(route, path, options); }
    catch (error) { rethrowProviderShareError(error); }
  } });
}
function aliasApi(category: 'members' | 'requests' | 'invitations', id: string) {
  const route = agentNetSharingAlias('provider-share', category, id);
  return { route, api: route ? scopedApi(route) : legacyProviderShareApi };
}
function addAlias(route: AgentNetSharingRoute, category: 'members' | 'requests' | 'invitations', id: string): void {
  const latest = agentNetSharingRoute('provider-share', route.resourceId) ?? route;
  rememberAgentNetSharingAliases(latest, { [category]: [...new Set([...(latest.aliases?.[category] ?? []), id])] });
}
const listingApi = createProviderShareApi({ captureScope, request: async (path, options) => {
  const received = path.endsWith('/received');
  const legacy = () => serverApiFetch<unknown>(path, { method: options.method, body: options.body,
    baseUrl: () => { if (!options.isCurrent()) throw new ProviderShareScopeChangedError(); return getClientEndpoint('deviceLinkApiBaseUrl'); },
    timeoutMs: 1500, cache: 'no-store', logLabel: '/api/device-link/provider-shares', redactErrorDetails: true,
    allowedRedactedErrorCodes: ALLOWED_REDACTED_CODES });
  return await listAgentNetProviderShares(received, legacy) ?? legacy();
} });
export const providerShareApi: ProviderShareApi = {
  ...legacyProviderShareApi,
  listOwned: () => listingApi.listOwned(),
  listReceived: () => listingApi.listReceived(),
  async createLink(input) {
    const route = selectedAgentNetSharingRoute('provider-share');
    if (!route) {
      if (isAgentNetActive()) throwIpcError('DEVICE_LINK_NOT_CONNECTED', 'Agent-Net is not ready');
      return legacyProviderShareApi.createLink(input);
    }
    rememberAgentNetSharingService(route);
    const result = await scopedApi(route).createLink(input);
    rememberAgentNetSharingHost('provider-share', result.shareId, route);
    addAlias({ ...route, resourceId: result.shareId }, 'invitations', sha256Hex(result.invitation));
    return result;
  },
  preview: invitation => aliasApi('invitations', sha256Hex(invitation)).api.preview(invitation),
  async sendRequest(invitation, card) {
    const { route, api } = aliasApi('invitations', sha256Hex(invitation));
    const result = await api.sendRequest(invitation, card);
    if (route) addAlias(route, 'requests', result.requestId);
    return result;
  },
  async getRequest(id) {
    const { route, api } = aliasApi('requests', id), result = await api.getRequest(id);
    if (route && result.status === 'approved') {
      if (result.shareId !== route.resourceId || !result.memberId) throw new Error('INVALID_AGENT_NET_SHARING_ADMISSION');
      const next = route.hostDeviceId !== getDeviceId() ? rememberAgentNetSharingGuest(route, result.memberId) : route;
      addAlias(next, 'members', result.memberId);
    }
    return result;
  },
  async approve(id) {
    const { route, api } = aliasApi('requests', id), result = await api.approve(id);
    if (route) {
      if (result.shareId !== route.resourceId) throw new Error('AGENT_NET_SHARING_ROUTE_CONFLICT');
      addAlias(route, 'members', result.memberId);
    }
    return result;
  },
  reject: id => aliasApi('requests', id).api.reject(id),
  withdraw: id => aliasApi('requests', id).api.withdraw(id),
  setMember: (id, action) => aliasApi('members', id).api.setMember(id, action),
  async leave(id) {
    const { route, api } = aliasApi('members', id); await api.leave(id);
    if (route) retireAgentNetSharingGuest('provider-share', route.resourceId);
  },
};

/** 「仅使用 Agent-Net」keeps every V1 share out of the received list: a missing share that was
 * never pinned to V2 is blocked by that switch on this computer, not removed by its owner. */
export function providerShareHiddenByEncryptedOnly(shareId: string): boolean {
  return agentNetOnlyEncryptedByUser() && !agentNetSharingRoute('provider-share', shareId);
}

/** A V2 invitation carries its public root and service. Validate before pinning;
 * no account token, private root or transport seed is sent to that service. */
export function resolveAgentNetProviderShareLink(input: string): { invitation: string; api: ProviderShareApi } | null {
  const parsed = agentNetSharingInvitationRoute(input, 'provider-share'); if (!parsed) return null;
  const api = scopedApi(parsed.route);
  return { invitation: parsed.invitation, api: { ...api,
    async preview(invitation) {
      const result = await api.preview(invitation);
      if (result.shareId !== parsed.route.resourceId) throw new Error('AGENT_NET_SHARING_ROUTE_CONFLICT');
      const route = rememberAgentNetSharingGuest(parsed.route);
      addAlias(route, 'invitations', sha256Hex(invitation)); return result;
    },
    async sendRequest(invitation, card) {
      await this.preview(invitation);
      return providerShareApi.sendRequest(invitation, card);
    },
  } };
}

/** Only the share's authenticated host device may authorize a same-account executor. */
export async function grantProviderShareDelegation(input: {
  shareId: string; memberId: string; guestDeviceId: string; executorDeviceId: string;
}, options: { background?: boolean; signal?: AbortSignal } = {}): Promise<{ expiresAt: number; generation: string }> {
  const privateGrant = await grantAgentNetProviderExecutor(input); if (privateGrant) return privateGrant;
  if (!agentNetAllowsLegacy()) throwIpcError('DEVICE_LINK_NOT_CONNECTED', 'Encrypted sharing route required');
  const body = { ...input };
  return delegationChecks.run(JSON.stringify(['grant', body.shareId, body.memberId, body.guestDeviceId, body.executorDeviceId]), async (scope, timeoutMs, signal) => {
    const value = await serverApiFetch<{ expiresAt?: unknown; generation?: unknown }>('/api/device-link/provider-shares/delegations', {
      method: 'POST', body,
      baseUrl: () => {
        if (!scope.isCurrent()) throw new ProviderShareScopeChangedError();
        return getClientEndpoint('deviceLinkApiBaseUrl');
      },
      timeoutMs, signal, cache: 'no-store',
      logLabel: '/api/device-link/provider-shares/delegations',
      redactErrorDetails: true, allowedRedactedErrorCodes: ALLOWED_REDACTED_CODES,
    });
    if (!Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) <= Date.now()
      || typeof value.generation !== 'string' || !/^[0-9a-f-]{36}$/.test(value.generation)) {
      throw new Error('Provider share delegation was not confirmed');
    }
    return { expiresAt: value.expiresAt as number, generation: value.generation };
  }, options);
}

export async function revokeProviderShareDelegation(input: {
  shareId: string; memberId: string; guestDeviceId: string; executorDeviceId: string; generation: string;
}, options: { background?: boolean; signal?: AbortSignal } = {}): Promise<void> {
  if (await revokeAgentNetProviderExecutor(input)) return;
  if (!agentNetAllowsLegacy()) throwIpcError('DEVICE_LINK_NOT_CONNECTED', 'Encrypted sharing route required');
  const body = { ...input };
  return delegationChecks.run(JSON.stringify(['revoke', body.shareId, body.memberId, body.guestDeviceId, body.executorDeviceId, body.generation]), async (scope, timeoutMs, signal) => {
    await serverApiFetch('/api/device-link/provider-shares/delegations/revoke', {
      method: 'POST', body,
      baseUrl: () => {
        if (!scope.isCurrent()) throw new ProviderShareScopeChangedError();
        return getClientEndpoint('deviceLinkApiBaseUrl');
      },
      timeoutMs, signal, cache: 'no-store',
      logLabel: '/api/device-link/provider-shares/delegations/revoke',
      redactErrorDetails: true, allowedRedactedErrorCodes: ALLOWED_REDACTED_CODES,
    });
  }, options);
}

/** M verifies that the server accepted O's delegation before trusting a cross-account guest. */
const delegationChecks = createProviderShareDelegationChecks({
  // Only the delegation budget survives an owner generation change. Ordinary
  // sharing and private invitations keep their existing scope dependency.
  captureScope: () => ({ ...captureScope(),
    key: JSON.stringify([providerShareOwnerKey(), getClientEndpoint('deviceLinkApiBaseUrl')]) }),
  scopeChanged: () => new ProviderShareScopeChangedError(),
  async request(input, scope, timeoutMs, signal) {
    const privateCheck = await checkAgentNetProviderExecutor(input, signal); if (privateCheck) return privateCheck;
    if (!agentNetAllowsLegacy()) return { active: false };
    const value = await serverApiFetch<{ active?: unknown; ownerDeviceId?: unknown;
      expiresAt?: unknown; generation?: unknown }>(
      '/api/device-link/provider-shares/delegations/check', {
        method: 'POST', body: input,
        baseUrl: () => {
          if (!scope.isCurrent()) throw new ProviderShareScopeChangedError();
          return getClientEndpoint('deviceLinkApiBaseUrl');
        },
        timeoutMs, signal, cache: 'no-store',
        logLabel: '/api/device-link/provider-shares/delegations/check',
        redactErrorDetails: true, allowedRedactedErrorCodes: ALLOWED_REDACTED_CODES,
      });
    if (value.active !== true || typeof value.ownerDeviceId !== 'string'
      || typeof value.generation !== 'string' || !/^[0-9a-f-]{36}$/.test(value.generation)
      || !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) <= Date.now()) return { active: false };
    return { active: true, ownerDeviceId: value.ownerDeviceId,
      expiresAt: value.expiresAt as number, generation: value.generation };
  },
});

export function checkProviderShareDelegation(input: DelegationCheckInput,
  generation?: string, options: { background?: boolean; signal?: AbortSignal } = {}): Promise<DelegationCheckResult> {
  return delegationChecks.check(input, generation, options);
}

export function clearProviderShareDelegationChecks(): void {
  delegationChecks.clear();
}

/** Local shared account/endpoint cooldown, not a claim about the server's quota. */
export function providerShareDelegationRetryAt(): number { return delegationChecks.retryAt(); }

/**
 * 供应商分享运行时的账号作用域：模式 + 数据所有者，不含代次。同一账号的投影修复会推进代次但不
 * 重连设备互联，不能因此让分享失效；换账号时数据所有者变化，且登出 / 换号会先停掉运行时。
 */
export function providerShareOwnerKey(): string {
  const session = getActiveAppSession();
  return `${session.mode}:${session.dataOwnerId ?? 'none'}`;
}

export type IdentityCardPurpose = 'share-link' | 'share-request' | 'share-session';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * 向本区域账号服务换一张只含昵称与头像的短期签名身份名片(只用自己的登录凭证)。
 * nonce 把名片绑定到这次链接或申请，不能挪作他用。
 */
export async function fetchIdentityCard(purpose: IdentityCardPurpose, nonce: string): Promise<string> {
  const scope = captureScope();
  try {
    const value = await serverApiFetch<{ card?: unknown }>('/api/me/identity-card', {
      method: 'POST',
      body: { audience: 'cindy-provider-share', purpose, nonce },
      baseUrl: () => {
        if (!scope.isCurrent()) throw new ProviderShareScopeChangedError();
        return getClientEndpoint('authApiBaseUrl');
      },
      timeoutMs: 15_000,
      cache: 'no-store',
      logLabel: '/api/me/identity-card',
      redactErrorDetails: true,
      allowedRedactedErrorCodes: ['RATE_LIMITED', 'UNAUTHORIZED'],
    });
    if (typeof value?.card !== 'string' || !value.card || value.card.length > 8192) {
      throwIpcError('PROVIDER_SHARE_IDENTITY_INVALID', 'Identity card unavailable');
    }
    return value.card;
  } catch (error) {
    rethrowProviderShareError(error);
  }
}

/** 链接里给手机网页选用的 App scheme 与本机构建身份一致。 */
export function providerShareLinkApp(): SharedTaskInvitationApp {
  const region = import.meta.env.VITE_CINDY_AUTH_REGION;
  return region === 'cn' ? 'cindycn' : region === 'dev' ? 'cindydev' : 'cindy';
}

export function providerShareLinkFor(invitation: string): string {
  const route = agentNetSharingAlias('provider-share', 'invitations', sha256Hex(invitation));
  if (route) return agentNetSharingInvitation('provider-share', route.resourceId, invitation, providerShareLinkApp())!;
  return buildProviderShareLink(invitation, getClientEndpoint('deviceLinkApiBaseUrl'), providerShareLinkApp());
}
