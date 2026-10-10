/**
 * 供应商分享的 REST 客户端(`/api/device-link/provider-shares`)。契约见
 * docs/provider-sharing-contract.md §3。只做请求与严格解析，鉴权、重试由调用方的
 * serverApiFetch / apiFetch 负责；响应在账号或区域切换后作废。
 */
import { scrubProviderShareLabel } from './providerShareCatalog.js';
import { providerShareIdentifier, sharedTaskDeviceId } from './protocol.js';

export type ProviderShareRegion = 'cn' | 'global';

export interface ProviderSharePerson {
  displayName: string;
  avatarUrl: string | null;
  region: ProviderShareRegion;
}

export interface ProviderShareMember extends ProviderSharePerson {
  memberId: string;
  status: 'active' | 'paused';
  joinedAt: string;
}

export interface ProviderShareRequestItem extends ProviderSharePerson {
  requestId: string;
  pairingCode: string;
  createdAt: string;
  expiresAt: string;
}

export interface ProviderShareOwned {
  shareId: string;
  providerId: string;
  providerLabel: string;
  hostDeviceId: string;
  createdAt: string;
  members: ProviderShareMember[];
  requests: ProviderShareRequestItem[];
}

export interface ProviderShareLinkPreview {
  shareId: string;
  providerId: string;
  providerLabel: string;
  deviceName: string;
  owner: ProviderSharePerson;
  state: 'unused' | 'used' | 'expired';
  expiresAt: string;
}

export type ProviderShareRequestStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'expired';

export interface ProviderShareRequestState {
  requestId: string;
  status: ProviderShareRequestStatus;
  pairingCode: string;
  expiresAt: string;
  shareId?: string;
  memberId?: string;
}

export interface ProviderShareReceived {
  shareId: string;
  memberId: string;
  providerId: string;
  providerLabel: string;
  hostDeviceId: string;
  deviceName: string;
  owner: ProviderSharePerson;
  status: 'active' | 'paused';
  hostOnline: boolean;
  hostCapable: boolean;
}

export interface ProviderShareApiOptions {
  /** Desktop serverApiFetch / Mobile apiFetch; no independent auth or retry stack. */
  request(path: string, options: { method: 'GET' | 'POST'; body?: unknown; isCurrent(): boolean }): Promise<unknown>;
  /** Captures account AND region generation; false rejects late success after logout/switch. */
  captureScope(): { isCurrent(): boolean };
}

export class ProviderShareScopeChangedError extends Error {
  constructor() { super('Provider share account or region changed'); this.name = 'ProviderShareScopeChangedError'; }
}

const INVITATION = /^[A-Za-z0-9_-]{43}$/;
const PAIRING_CODE = /^[0-9]{4}$/;

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provider share response');
  return value as Record<string, unknown>;
}
function list(value: unknown, max = 10_000): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('Invalid provider share list');
  return value;
}
function text(value: unknown, max = 256): string {
  // eslint-disable-next-line no-control-regex -- 控制字符是显式拒绝目标
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Invalid provider share text');
  }
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error('Invalid provider share time');
  return value;
}
function avatar(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid provider share avatar');
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
function region(value: unknown): ProviderShareRegion {
  if (value === 'cn' || value === 'global') return value;
  throw new Error('Invalid provider share region');
}
function person(value: unknown): ProviderSharePerson {
  const item = row(value);
  return { displayName: text(item.displayName, 128), avatarUrl: avatar(item.avatarUrl), region: region(item.region) };
}
function oneOf<T extends string>(value: unknown, options: readonly T[]): T {
  if (typeof value === 'string' && (options as readonly string[]).includes(value)) return value as T;
  throw new Error('Invalid provider share status');
}
function pairing(value: unknown): string {
  if (typeof value !== 'string' || !PAIRING_CODE.test(value)) throw new Error('Invalid provider share pairing code');
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Invalid provider share flag');
  return value;
}

export function isProviderShareInvitation(value: unknown): value is string {
  return typeof value === 'string' && INVITATION.test(value);
}

function parseOwned(value: unknown): ProviderShareOwned {
  const item = row(value);
  return {
    shareId: providerShareIdentifier(item.shareId),
    providerId: text(item.providerId, 256),
    providerLabel: scrubProviderShareLabel(text(item.providerLabel, 256)),
    hostDeviceId: sharedTaskDeviceId(item.hostDeviceId),
    createdAt: timestamp(item.createdAt),
    members: list(item.members).map((raw) => {
      const member = row(raw);
      return {
        ...person(member),
        memberId: providerShareIdentifier(member.memberId),
        status: oneOf(member.status, ['active', 'paused'] as const),
        joinedAt: timestamp(member.joinedAt),
      };
    }),
    requests: list(item.requests).map((raw) => {
      const request = row(raw);
      return {
        ...person(request),
        requestId: providerShareIdentifier(request.requestId),
        pairingCode: pairing(request.pairingCode),
        createdAt: timestamp(request.createdAt),
        expiresAt: timestamp(request.expiresAt),
      };
    }),
  };
}

function parseRequestState(value: unknown): ProviderShareRequestState {
  const item = row(value);
  return {
    requestId: providerShareIdentifier(item.requestId),
    status: oneOf(item.status, ['pending', 'approved', 'rejected', 'withdrawn', 'expired'] as const),
    pairingCode: pairing(item.pairingCode),
    expiresAt: timestamp(item.expiresAt),
    ...(item.shareId !== undefined && item.shareId !== null ? { shareId: providerShareIdentifier(item.shareId) } : {}),
    ...(item.memberId !== undefined && item.memberId !== null ? { memberId: providerShareIdentifier(item.memberId) } : {}),
  };
}

function parsePreview(value: unknown): ProviderShareLinkPreview {
  const item = row(value);
  return {
    shareId: providerShareIdentifier(item.shareId),
    providerId: text(item.providerId, 256),
    providerLabel: scrubProviderShareLabel(text(item.providerLabel, 256)),
    deviceName: text(item.deviceName, 256),
    owner: person(item.owner),
    state: oneOf(item.state, ['unused', 'used', 'expired'] as const),
    expiresAt: timestamp(item.expiresAt),
  };
}

function parseReceived(value: unknown): ProviderShareReceived {
  const item = row(value);
  return {
    shareId: providerShareIdentifier(item.shareId),
    memberId: providerShareIdentifier(item.memberId),
    providerId: text(item.providerId, 256),
    providerLabel: scrubProviderShareLabel(text(item.providerLabel, 256)),
    hostDeviceId: sharedTaskDeviceId(item.hostDeviceId),
    deviceName: text(item.deviceName, 256),
    owner: person(item.owner),
    status: oneOf(item.status, ['active', 'paused'] as const),
    hostOnline: bool(item.hostOnline),
    hostCapable: bool(item.hostCapable),
  };
}

export function createProviderShareApi(options: ProviderShareApiOptions) {
  async function request(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<Record<string, unknown>> {
    const scope = options.captureScope();
    if (!scope.isCurrent()) throw new ProviderShareScopeChangedError();
    const value = await options.request(`/api/device-link/provider-shares${path}`, {
      method,
      ...(body === undefined ? {} : { body }),
      isCurrent: () => scope.isCurrent(),
    });
    if (!scope.isCurrent()) throw new ProviderShareScopeChangedError();
    return row(value);
  }
  const segment = (value: string) => `/${encodeURIComponent(providerShareIdentifier(value))}`;
  return {
    async listOwned(): Promise<ProviderShareOwned[]> {
      const value = await request('');
      return list(value.shares).map(parseOwned);
    },
    async createLink(input: { providerId: string; providerLabel: string; deviceName: string; identityCard: string }) {
      const value = await request('/links', 'POST', {
        providerId: text(input.providerId, 256),
        providerLabel: text(input.providerLabel, 256),
        deviceName: text(input.deviceName, 256),
        identityCard: text(input.identityCard, 8192),
      });
      if (!isProviderShareInvitation(value.invitation)) throw new Error('Invalid provider share invitation');
      return { shareId: providerShareIdentifier(value.shareId), invitation: value.invitation, expiresAt: timestamp(value.expiresAt) };
    },
    async approve(requestId: string) {
      const value = await request(`/requests${segment(requestId)}/approve`, 'POST', {});
      return { shareId: providerShareIdentifier(value.shareId), memberId: providerShareIdentifier(value.memberId) };
    },
    async reject(requestId: string) {
      await request(`/requests${segment(requestId)}/reject`, 'POST', {});
    },
    async setMember(memberId: string, action: 'pause' | 'resume' | 'remove') {
      const value = await request(`/members${segment(memberId)}/${action}`, 'POST', {});
      return { memberId: providerShareIdentifier(value.memberId), status: oneOf(value.status, ['active', 'paused', 'removed'] as const) };
    },
    async preview(invitation: string): Promise<ProviderShareLinkPreview> {
      if (!isProviderShareInvitation(invitation)) throw new Error('Invalid provider share invitation');
      return parsePreview(await request('/preview', 'POST', { invitation }));
    },
    async sendRequest(invitation: string, identityCard: string): Promise<ProviderShareRequestState> {
      if (!isProviderShareInvitation(invitation)) throw new Error('Invalid provider share invitation');
      const value = await request('/requests', 'POST', { invitation, identityCard: text(identityCard, 8192) });
      return parseRequestState(value);
    },
    async getRequest(requestId: string): Promise<ProviderShareRequestState> {
      return parseRequestState(await request(`/requests${segment(requestId)}`));
    },
    async withdraw(requestId: string) {
      await request(`/requests${segment(requestId)}/withdraw`, 'POST', {});
    },
    async listReceived(): Promise<ProviderShareReceived[]> {
      const value = await request('/received');
      return list(value.shares).map(parseReceived);
    },
    async leave(memberId: string) {
      await request(`/received${segment(memberId)}/leave`, 'POST', {});
    },
  };
}

export type ProviderShareApi = ReturnType<typeof createProviderShareApi>;

/**
 * 严格解析器，供跨区域(P3)接口复用：响应形状与同区域一致(契约 §6.2)。
 * 解析失败抛错，不返回部分结果。
 */
export const providerShareParsers = {
  preview: parsePreview,
  requestState: parseRequestState,
  received: parseReceived,
  receivedList(value: unknown): ProviderShareReceived[] {
    return list(row(value).shares).map(parseReceived);
  },
  /** 一次性令牌与凭证同口令格式：43 位 base64url。 */
  secret(value: unknown): string {
    if (typeof value !== 'string' || !INVITATION.test(value)) throw new Error('Invalid provider share secret');
    return value;
  },
  timestamp,
  deviceId: sharedTaskDeviceId,
};

/** Server error codes the client distinguishes; anything else is shown as a generic failure. */
export const PROVIDER_SHARE_ERROR_CODES = [
  'NOT_FOUND',
  'PROVIDER_SHARE_LINK_USED',
  'PROVIDER_SHARE_LINK_EXPIRED',
  'PROVIDER_SHARE_SELF',
  'PROVIDER_SHARE_ALREADY_MEMBER',
  'PROVIDER_SHARE_IDENTITY_INVALID',
  'PROVIDER_SHARE_NOT_HOST_DEVICE',
  'PROVIDER_SHARE_CROSS_REGION_DISABLED',
] as const;
export type ProviderShareErrorCode = typeof PROVIDER_SHARE_ERROR_CODES[number];
