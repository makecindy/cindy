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
} from '@cindy/device-link';

import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getAuthState } from '../authManager.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { serverApiFetch } from '../serverApiClient.js';
import type { IpcErrorCode } from '../../shared/ipc-errors.js';
import { throwIpcError } from '../utils/ipcValidate.js';

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
  return {
    isCurrent: () => getAuthState().isAuthenticated && !isAppSessionBoundaryPending()
      && activeOwnerScopeKey() === key && getClientEndpoint('deviceLinkApiBaseUrl') === endpoint,
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

export const providerShareApi = createProviderShareApi({
  captureScope,
  async request(path, options) {
    try {
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

/** Only the share's authenticated host device may authorize a same-account executor. */
export async function grantProviderShareDelegation(input: {
  shareId: string; memberId: string; guestDeviceId: string; executorDeviceId: string;
}): Promise<{ expiresAt: number; generation: string }> {
  const scope = captureScope();
  const value = await serverApiFetch<{ expiresAt?: unknown; generation?: unknown }>('/api/device-link/provider-shares/delegations', {
    method: 'POST', body: input,
    baseUrl: () => {
      if (!scope.isCurrent()) throw new ProviderShareScopeChangedError();
      return getClientEndpoint('deviceLinkApiBaseUrl');
    },
    timeoutMs: 15_000, cache: 'no-store',
    logLabel: '/api/device-link/provider-shares/delegations',
    redactErrorDetails: true, allowedRedactedErrorCodes: ALLOWED_REDACTED_CODES,
  });
  if (!Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) <= Date.now()
    || typeof value.generation !== 'string' || !/^[0-9a-f-]{36}$/.test(value.generation)) {
    throw new Error('Provider share delegation was not confirmed');
  }
  return { expiresAt: value.expiresAt as number, generation: value.generation };
}

export async function revokeProviderShareDelegation(input: {
  shareId: string; memberId: string; guestDeviceId: string; executorDeviceId: string; generation: string;
}): Promise<void> {
  const scope = captureScope();
  await serverApiFetch('/api/device-link/provider-shares/delegations/revoke', {
    method: 'POST', body: input,
    baseUrl: () => {
      if (!scope.isCurrent()) throw new ProviderShareScopeChangedError();
      return getClientEndpoint('deviceLinkApiBaseUrl');
    },
    timeoutMs: 15_000, cache: 'no-store',
    logLabel: '/api/device-link/provider-shares/delegations/revoke',
    redactErrorDetails: true, allowedRedactedErrorCodes: ALLOWED_REDACTED_CODES,
  });
}

/** M verifies that the server accepted O's delegation before trusting a cross-account guest. */
export async function checkProviderShareDelegation(input: {
  shareId: string; memberId: string; guestDeviceId: string; executorDeviceId: string;
}): Promise<{ active: boolean; ownerDeviceId?: string; expiresAt?: number; generation?: string }> {
  const scope = captureScope();
  const value = await serverApiFetch<{ active?: unknown; ownerDeviceId?: unknown;
    expiresAt?: unknown; generation?: unknown }>(
    '/api/device-link/provider-shares/delegations/check', {
      method: 'POST', body: input,
      baseUrl: () => {
        if (!scope.isCurrent()) throw new ProviderShareScopeChangedError();
        return getClientEndpoint('deviceLinkApiBaseUrl');
      },
      timeoutMs: 15_000, cache: 'no-store',
      logLabel: '/api/device-link/provider-shares/delegations/check',
      redactErrorDetails: true, allowedRedactedErrorCodes: ALLOWED_REDACTED_CODES,
    });
  if (value.active !== true || typeof value.ownerDeviceId !== 'string'
    || typeof value.generation !== 'string' || !/^[0-9a-f-]{36}$/.test(value.generation)
    || !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) <= Date.now()) return { active: false };
  return { active: true, ownerDeviceId: value.ownerDeviceId,
    expiresAt: value.expiresAt as number, generation: value.generation };
}

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
  return buildProviderShareLink(invitation, getClientEndpoint('deviceLinkApiBaseUrl'), providerShareLinkApp());
}
