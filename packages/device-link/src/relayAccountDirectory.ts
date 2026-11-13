/**
 * 同账号设备之间的中转目录与免链接加入(docs/self-hosted-relay-plan.md §5.4)。
 *
 * 两份记录存在 Chat Server 账号私有的 preferences 里,只有同一账号的设备能读写:
 * - `relay.offers.v1`:每台主人电脑正在用的自有中转——名字、地址、主人公钥,不含任何秘密。
 *   同账号的其他电脑和手机据此在线路列表里列出「我的中转」。
 * - `relay.join.v1`:加入方写申请(设备 ID、设备名、事先生成的签名公钥),主人电脑回写一条
 *   一次性分享链接;之后照常经中转加入,主人电脑只放行申请里那把公钥,不弹配对码。
 *
 * 信任来源是官方账号:能写这两份记录的就是同一账号的设备(与官方线路同级)。连不上账号服务时
 * 仍可用分享链接加入。这里只有格式与合并规则,读写由 Desktop / Mobile 各自完成。
 */
import { isRelayPublicKey } from './selfHostedRelayAuth.js';
import { normalizeRelayBaseUrl, parseRelayJoinLink } from './selfHostedRelay.js';

export const RELAY_OFFERS_PREFERENCE = 'relay.offers.v1';
export const RELAY_JOIN_PREFERENCE = 'relay.join.v1';
/** 申请与回写的链接都只保留这么久;过期的条目在下次写入时清掉。 */
export const RELAY_ACCOUNT_JOIN_TTL_MS = 10 * 60 * 1000;
/** 加入方等主人电脑回写链接的时间;超过就提示对方可能不在线。 */
export const RELAY_ACCOUNT_INVITE_WAIT_MS = 45 * 1000;
/**
 * 主人电脑一读到申请就先回一声「收到」(`pending`),再去中转要加入码。加入方这么久没等到这一声,
 * 就说明那台电脑没开 Cindy 或没联网,直接提示,不必等满 `RELAY_ACCOUNT_INVITE_WAIT_MS`。
 */
export const RELAY_ACCOUNT_ACK_WAIT_MS = 12 * 1000;

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const RELAY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_ENTRIES = 32;

/** `shared`:别人分享给本账号的中转,本账号在上面有自己的网络(只走 V2,§5.5)。 */
export type RelayAccountOfferKind = 'server' | 'host' | 'shared';

export interface RelayAccountOffer {
  /** 主人电脑的设备 ID;一台电脑同时只提供它正在用的那一个中转。 */
  ownerDeviceId: string;
  ownerDeviceName: string;
  /** 网络 ID:自有中转是中转 ID,别人分享的是本账号在那台中转上的网络 ID。 */
  relayId: string;
  name: string;
  /** 其他设备访问这个中转用的地址(与分享链接里的地址相同)。 */
  baseUrl: string;
  /** 这个网络的根公钥(自有中转是主人公钥,别人分享的是本账号自己的根公钥)。 */
  ownerPublicKey: string;
  kind: RelayAccountOfferKind;
  /** `shared` 时分享者的显示名(可能没有)。 */
  sharedBy?: string | null;
  updatedAt: number;
}

export interface RelayAccountJoinRequest {
  requestId: string;
  deviceId: string;
  deviceName: string;
  platform: string;
  relayId: string;
  ownerDeviceId: string;
  /** 加入方事先生成的签名公钥;主人电脑只自动放行这把公钥的申请。 */
  publicKey: string;
  createdAt: number;
}

export type RelayAccountInviteError = 'RELAY_UNAVAILABLE';

export interface RelayAccountJoinInvite {
  requestId: string;
  relayId: string;
  /** 一次性分享链接;主人电脑没有在用这个中转时改为 `error`。 */
  link?: string;
  error?: RelayAccountInviteError;
  /** 主人电脑已收到申请、正在准备链接(之后同一条会换成 `link` 或 `error`)。 */
  pending?: true;
  expiresAt: number;
}

export interface RelayAccountJoinBoard {
  /** 按加入方设备 ID;一台设备同时只有一条申请。 */
  requests: Record<string, RelayAccountJoinRequest>;
  invites: Record<string, RelayAccountJoinInvite>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() && value.length <= max ? value : null;
}

function time(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function parseOffer(ownerDeviceId: string, raw: unknown): RelayAccountOffer | null {
  if (!ID_PATTERN.test(ownerDeviceId) || !isRecord(raw)) return null;
  const ownerDeviceName = text(raw.ownerDeviceName, 128);
  const relayId = typeof raw.relayId === 'string' && RELAY_ID_PATTERN.test(raw.relayId) ? raw.relayId : null;
  const name = text(raw.name, 64);
  const baseUrl = typeof raw.baseUrl === 'string' ? normalizeRelayBaseUrl(raw.baseUrl) : null;
  const kind = raw.kind === 'server' || raw.kind === 'host' || raw.kind === 'shared' ? raw.kind : null;
  const updatedAt = time(raw.updatedAt);
  if (!ownerDeviceName || !relayId || !name || !baseUrl || !kind || !updatedAt || !isRelayPublicKey(raw.ownerPublicKey)) return null;
  return {
    ownerDeviceId, ownerDeviceName, relayId, name, baseUrl, ownerPublicKey: raw.ownerPublicKey, kind,
    ...(kind === 'shared' ? { sharedBy: text(raw.sharedBy, 64) } : {}),
    updatedAt,
  };
}

/** 读 `relay.offers.v1`;不认识或不合法的条目丢掉,不让一条坏数据挡住其余的。 */
export function parseRelayAccountOffers(value: unknown): RelayAccountOffer[] {
  const offers = isRecord(value) && value.v === 1 && isRecord(value.offers) ? value.offers : {};
  return Object.entries(offers)
    .slice(0, MAX_ENTRIES)
    .flatMap(([deviceId, raw]) => {
      const offer = parseOffer(deviceId, raw);
      return offer ? [offer] : [];
    });
}

/** 写入或撤下这台电脑的那一条,其他电脑的条目原样保留。 */
export function withRelayAccountOffer(
  value: unknown,
  ownerDeviceId: string,
  offer: Omit<RelayAccountOffer, 'ownerDeviceId' | 'updatedAt'> | null,
  now: number,
): { v: 1; offers: Record<string, Omit<RelayAccountOffer, 'ownerDeviceId'>> } {
  const offers: Record<string, Omit<RelayAccountOffer, 'ownerDeviceId'>> = {};
  for (const item of parseRelayAccountOffers(value)) {
    if (item.ownerDeviceId === ownerDeviceId) continue;
    const { ownerDeviceId: _id, ...rest } = item;
    offers[item.ownerDeviceId] = rest;
  }
  if (offer) offers[ownerDeviceId] = { ...offer, updatedAt: now };
  return { v: 1, offers };
}

function parseRequest(deviceId: string, raw: unknown): RelayAccountJoinRequest | null {
  if (!ID_PATTERN.test(deviceId) || !isRecord(raw)) return null;
  const requestId = typeof raw.requestId === 'string' && RELAY_ID_PATTERN.test(raw.requestId) ? raw.requestId : null;
  const deviceName = text(raw.deviceName, 128);
  const platform = text(raw.platform, 32);
  const relayId = typeof raw.relayId === 'string' && RELAY_ID_PATTERN.test(raw.relayId) ? raw.relayId : null;
  const ownerDeviceId = typeof raw.ownerDeviceId === 'string' && ID_PATTERN.test(raw.ownerDeviceId) ? raw.ownerDeviceId : null;
  const createdAt = time(raw.createdAt);
  if (!requestId || !deviceName || !platform || !relayId || !ownerDeviceId || !createdAt || !isRelayPublicKey(raw.publicKey)) return null;
  return { requestId, deviceId, deviceName, platform, relayId, ownerDeviceId, publicKey: raw.publicKey, createdAt };
}

function parseInvite(raw: unknown): RelayAccountJoinInvite | null {
  if (!isRecord(raw)) return null;
  const requestId = typeof raw.requestId === 'string' && RELAY_ID_PATTERN.test(raw.requestId) ? raw.requestId : null;
  const relayId = typeof raw.relayId === 'string' && RELAY_ID_PATTERN.test(raw.relayId) ? raw.relayId : null;
  const expiresAt = time(raw.expiresAt);
  if (!requestId || !relayId || !expiresAt) return null;
  if (raw.error === 'RELAY_UNAVAILABLE') return { requestId, relayId, error: raw.error, expiresAt };
  if (raw.pending === true && raw.link === undefined) return { requestId, relayId, pending: true, expiresAt };
  const link = typeof raw.link === 'string' ? parseRelayJoinLink(raw.link) : null;
  return link ? { requestId, relayId, link: raw.link as string, expiresAt } : null;
}

/** 读 `relay.join.v1`,去掉过期与不合法的条目。 */
export function parseRelayAccountJoinBoard(value: unknown, now: number): RelayAccountJoinBoard {
  const board: RelayAccountJoinBoard = { requests: {}, invites: {} };
  if (!isRecord(value) || value.v !== 1) return board;
  const requests = isRecord(value.requests) ? Object.entries(value.requests).slice(0, MAX_ENTRIES) : [];
  for (const [deviceId, raw] of requests) {
    const request = parseRequest(deviceId, raw);
    if (request && request.createdAt + RELAY_ACCOUNT_JOIN_TTL_MS > now) board.requests[deviceId] = request;
  }
  const invites = isRecord(value.invites) ? Object.entries(value.invites).slice(0, MAX_ENTRIES) : [];
  for (const [deviceId, raw] of invites) {
    const invite = ID_PATTERN.test(deviceId) ? parseInvite(raw) : null;
    if (invite && invite.expiresAt > now) board.invites[deviceId] = invite;
  }
  return board;
}

export function serializeRelayAccountJoinBoard(board: RelayAccountJoinBoard): { v: 1 } & RelayAccountJoinBoard {
  return { v: 1, requests: board.requests, invites: board.invites };
}
