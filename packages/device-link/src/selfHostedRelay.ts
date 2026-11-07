/**
 * 自建中转:加入链接与加入流程(Desktop / Mobile 共用,fetch 由宿主注入)。
 *
 * 加入链接 `<app>://relay/join?u=<中转地址>&c=<一次性加入码>&o=<主人公钥>&s=<配对秘密>`:主人电脑生成,
 * 另一台电脑粘贴,手机用系统相机扫二维码打开。加入码只能用一次、10 分钟有效;拿到它还要主人在自己的电脑上
 * 同意,新设备才会拿到只对这个中转有效的凭证(`Authorization: CindyRelay <凭证>`),从不发送账号 token。
 *
 * `o` 与 `s` 只在链接里,不发给中转:新设备用 `s` 证明自己的签名公钥(主人核对后签发证书),
 * 用 `o` 核对中转转交的证书确实出自主人。设备签名见 selfHostedRelayAuth.ts。
 *
 * 中转端契约见 `packages/device-link-relay`(`/api/device-link/relay/*`)与 docs/self-hosted-relay-plan.md §6.3。
 */
import type { SharedTaskInvitationApp } from './sharedTaskInvitation.js';
import {
  computeRelayPairProof,
  createRelaySigningKey,
  isRelayPublicKey,
  verifyRelayDeviceCert,
  type RelayAuthCrypto,
  type RelayDeviceCert,
} from './selfHostedRelayAuth.js';

export const RELAY_JOIN_HOST = 'relay';
export const RELAY_JOIN_PATH = '/join';
const RELAY_APPS: ReadonlySet<string> = new Set(['cindy', 'cindycn', 'cindydev']);
const MAX_LINK_LENGTH = 2048;
const JOIN_CODE_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const PAIR_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** 支持设备签名的中转在 `/relay/info` 里声明的能力。 */
export const RELAY_SIGNATURES_FEATURE = 'device-signatures-v1';
const API_PREFIX = '/api/device-link';

export interface RelayJoinLink {
  /** 中转的基础地址(不含 `/api/...`),如 `http://192.168.1.20:47820`。 */
  baseUrl: string;
  code: string;
  /** 主人公钥(base64url):核对中转转交的设备证书。 */
  ownerPublicKey: string;
  /** 一次性配对秘密(base64url):新设备用它证明自己的公钥。 */
  pairSecret: string;
}

/** 规范化中转地址:只接受 http(s)、不带账号密码 / 查询 / 片段;去掉末尾斜杠。 */
export function normalizeRelayBaseUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash || !url.hostname) return null;
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname.startsWith(API_PREFIX)) return null;
  return `${url.protocol}//${url.host}${pathname}`;
}

export function buildRelayJoinLink(input: {
  baseUrl: string;
  code: string;
  ownerPublicKey: string;
  pairSecret: string;
  app: SharedTaskInvitationApp;
}): string {
  const baseUrl = normalizeRelayBaseUrl(input.baseUrl);
  if (
    !baseUrl ||
    !JOIN_CODE_PATTERN.test(input.code) ||
    !isRelayPublicKey(input.ownerPublicKey) ||
    !PAIR_SECRET_PATTERN.test(input.pairSecret) ||
    !RELAY_APPS.has(input.app)
  ) {
    throw new Error('Invalid relay join link');
  }
  const query = new URLSearchParams({ u: baseUrl, c: input.code, o: input.ownerPublicKey, s: input.pairSecret });
  return `${input.app}://${RELAY_JOIN_HOST}${RELAY_JOIN_PATH}?${query.toString()}`;
}

/**
 * 解析加入链接。同时接受完整链接 `cindy://relay/join?...` 与路由层收到的路径形态 `/relay/join?...`
 * (Expo Router 的 native intent 只给 path)。不合法一律返回 null。
 */
export function parseRelayJoinLink(value: string): RelayJoinLink | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_LINK_LENGTH) return null;
  const match = /^(?:([a-z]+):\/\/relay|\/relay)\/join\/?\?(.*)$/i.exec(trimmed);
  if (!match) return null;
  if (match[1] && !RELAY_APPS.has(match[1].toLowerCase())) return null;
  const params = new URLSearchParams(match[2]);
  const rawBase = params.get('u');
  const code = params.get('c');
  const ownerPublicKey = params.get('o');
  const pairSecret = params.get('s');
  if (!rawBase || !code || !JOIN_CODE_PATTERN.test(code)) return null;
  if (!isRelayPublicKey(ownerPublicKey) || !pairSecret || !PAIR_SECRET_PATTERN.test(pairSecret)) return null;
  const baseUrl = normalizeRelayBaseUrl(rawBase);
  return baseUrl ? { baseUrl, code, ownerPublicKey, pairSecret } : null;
}

// ─── 加入流程 ────────────────────────────────────────────────────────────────

export interface RelayFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type RelayFetch = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<RelayFetchResponse>;

export type RelayJoinErrorCode =
  /** 连不上这个地址(网络不通、地址写错、中转没开)。 */
  | 'UNREACHABLE'
  /** 地址能访问,但不是 Cindy 中转。 */
  | 'NOT_A_RELAY'
  /** 中转的协议版本与本机不兼容。 */
  | 'INCOMPATIBLE'
  /** 中转属于另一个 Cindy 账号。 */
  | 'ACCOUNT_MISMATCH'
  /** 加入码无效、已用过或已过期。 */
  | 'CODE_INVALID'
  | 'RATE_LIMITED'
  /** 主人拒绝了这次加入。 */
  | 'REJECTED'
  /** 等待主人同意超时。 */
  | 'EXPIRED'
  /** 中转转交的证书不是加入链接里那位主人签发的:中转可能被人替换,不要加入。 */
  | 'OWNER_MISMATCH'
  | 'CANCELLED'
  | 'FAILED';

export class RelayJoinError extends Error {
  constructor(
    readonly code: RelayJoinErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RelayJoinError';
  }
}

export interface RelayInfo {
  relayId: string;
  name: string;
  protocolVersion: number;
  relayVersion: string;
}

export interface RelayPairRequest {
  requestId: string;
  pollToken: string;
  /** 4 位核对码:与主人电脑上显示的一致才应同意。 */
  verifyCode: string;
}

export interface RelayPairResult {
  credential: string;
  deviceId: string;
  /** 主人签发的设备证书(未核对,用 `acceptRelayDeviceCert` 核对)。 */
  cert: unknown;
}

async function call(
  fetchFn: RelayFetch,
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
): Promise<{ status: number; ok: boolean; body: Record<string, unknown> | null }> {
  let res: RelayFetchResponse;
  try {
    res = await fetchFn(url, init);
  } catch (error) {
    if (init.signal?.aborted) throw new RelayJoinError('CANCELLED', 'cancelled');
    throw new RelayJoinError('UNREACHABLE', error instanceof Error ? error.message : 'request failed');
  }
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = await res.json();
    body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  return { status: res.status, ok: res.ok, body };
}

function errorCodeOf(body: Record<string, unknown> | null): string | undefined {
  const error = body?.error as { code?: unknown } | undefined;
  return typeof error?.code === 'string' ? error.code : undefined;
}

/** 加入前探测:地址可达、确实是 Cindy 中转、协议版本兼容。 */
export async function fetchRelayInfo(fetchFn: RelayFetch, baseUrl: string, signal?: AbortSignal): Promise<RelayInfo> {
  const { ok, body } = await call(fetchFn, `${baseUrl}${API_PREFIX}/relay/info`, { method: 'GET', signal });
  if (!ok || !body || typeof body.relayId !== 'string' || typeof body.name !== 'string') {
    throw new RelayJoinError('NOT_A_RELAY', 'address is not a Cindy relay');
  }
  if (
    body.protocolVersion !== 1 ||
    !Array.isArray(body.features) ||
    !body.features.includes('pairing-v1') ||
    !body.features.includes(RELAY_SIGNATURES_FEATURE)
  ) {
    throw new RelayJoinError('INCOMPATIBLE', 'relay protocol is not supported');
  }
  return {
    relayId: body.relayId,
    name: body.name,
    protocolVersion: body.protocolVersion,
    relayVersion: typeof body.relayVersion === 'string' ? body.relayVersion : '',
  };
}

export async function submitRelayPairRequest(
  fetchFn: RelayFetch,
  link: RelayJoinLink,
  device: {
    deviceId: string;
    deviceName: string;
    platform: string;
    appVersion: string;
    accountUserId: string;
    /** 新设备的签名公钥与配对证明,见 `createRelayJoinIdentity`。 */
    publicKey: string;
    proof: string;
  },
  signal?: AbortSignal,
): Promise<RelayPairRequest> {
  const { ok, status, body } = await call(fetchFn, `${link.baseUrl}${API_PREFIX}/relay/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: link.code, ...device, deviceName: device.deviceName.slice(0, 64) }),
    signal,
  });
  if (ok && body && typeof body.requestId === 'string' && typeof body.pollToken === 'string' && typeof body.verifyCode === 'string') {
    return { requestId: body.requestId, pollToken: body.pollToken, verifyCode: body.verifyCode };
  }
  const code = errorCodeOf(body);
  if (code === 'ACCOUNT_MISMATCH') throw new RelayJoinError('ACCOUNT_MISMATCH', 'relay belongs to another account');
  if (status === 429) throw new RelayJoinError('RATE_LIMITED', 'too many attempts');
  if (status === 403) throw new RelayJoinError('CODE_INVALID', 'join code is invalid or expired');
  throw new RelayJoinError('FAILED', `pairing request failed (${status})`);
}

/**
 * 等主人同意:反复长轮询直到同意、拒绝、过期或超过 `deadlineMs`。
 * 凭证只返回一次;拿到后调用方必须立即保存到安全存储。
 */
export async function waitForRelayApproval(
  fetchFn: RelayFetch,
  link: RelayJoinLink,
  request: RelayPairRequest,
  options: { signal?: AbortSignal; deadlineMs?: number; now?: () => number } = {},
): Promise<RelayPairResult> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.deadlineMs ?? 10 * 60 * 1000);
  let failures = 0;
  while (now() < deadline) {
    if (options.signal?.aborted) throw new RelayJoinError('CANCELLED', 'cancelled');
    let result: Awaited<ReturnType<typeof call>>;
    try {
      result = await call(
        fetchFn,
        `${link.baseUrl}${API_PREFIX}/relay/pair/${encodeURIComponent(request.requestId)}?wait=20`,
        { method: 'GET', headers: { 'X-Cindy-Relay-Poll-Token': request.pollToken }, signal: options.signal },
      );
    } catch (error) {
      // 等待期间网络抖一下不算失败;连续多次连不上才放弃。
      if (error instanceof RelayJoinError && error.code === 'UNREACHABLE' && ++failures < 5) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        continue;
      }
      throw error;
    }
    failures = 0;
    const status = result.body?.status;
    if (status === 'approved' && typeof result.body?.credential === 'string' && typeof result.body?.deviceId === 'string') {
      return { credential: result.body.credential, deviceId: result.body.deviceId, cert: result.body.cert };
    }
    if (status === 'rejected') throw new RelayJoinError('REJECTED', 'the owner rejected this device');
    if (status === 'expired') throw new RelayJoinError('EXPIRED', 'the request expired');
    if (status !== 'pending') throw new RelayJoinError('FAILED', `unexpected pairing state (${result.status})`);
  }
  throw new RelayJoinError('EXPIRED', 'timed out waiting for approval');
}

// ─── 设备签名相关 ────────────────────────────────────────────────────────────

export interface RelayJoinIdentity {
  /** 本机签名私钥种子(base64url),加入成功后存进安全存储。 */
  seed: string;
  publicKey: string;
  /** 用链接里的配对秘密对公钥做的证明,随申请提交。 */
  proof: string;
}

/** 为这次加入生成本机签名密钥,并用链接里的配对秘密做公钥证明。 */
export function createRelayJoinIdentity(
  crypto: RelayAuthCrypto,
  link: RelayJoinLink,
  relayId: string,
  deviceId: string,
): RelayJoinIdentity {
  const key = createRelaySigningKey(crypto);
  return {
    seed: key.seed,
    publicKey: key.publicKey,
    proof: computeRelayPairProof(crypto, link.pairSecret, { relayId, deviceId, publicKey: key.publicKey }),
  };
}

/** 核对主人签发的证书:必须出自链接里的主人、发给本机这把公钥。 */
export function acceptRelayDeviceCert(
  crypto: RelayAuthCrypto,
  link: RelayJoinLink,
  input: { relayId: string; deviceId: string; publicKey: string; cert: unknown },
): RelayDeviceCert {
  const cert = verifyRelayDeviceCert(crypto, link.ownerPublicKey, input.relayId, input.cert);
  if (!cert || cert.deviceId !== input.deviceId || cert.publicKey !== input.publicKey || cert.role !== 'member') {
    throw new RelayJoinError('OWNER_MISMATCH', 'the relay returned a certificate the owner did not issue');
  }
  return cert;
}

/** 取中转上全部设备证书(未核对;交给 `RelayFrameAuthenticator.setCertificates` 用主人公钥逐个核对)。 */
export async function fetchRelayCertificates(
  fetchFn: RelayFetch,
  baseUrl: string,
  credential: string,
  signal?: AbortSignal,
): Promise<unknown[]> {
  const { ok, status, body } = await call(fetchFn, `${baseUrl}${API_PREFIX}/relay/certs`, {
    method: 'GET',
    headers: { Authorization: `CindyRelay ${credential}` },
    signal,
  });
  if (!ok || !body || !Array.isArray(body.certs)) throw new RelayJoinError('FAILED', `certificate list unavailable (${status})`);
  return body.certs;
}
