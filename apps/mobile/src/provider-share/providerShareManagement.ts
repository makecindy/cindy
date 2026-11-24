/**
 * 手机管理「我分享的供应商」(docs/product-rules/provider-sharing.md §7.6)：查看组内电脑与额度、生成分享链接、
 * 处理申请。全部经同账号管理通道(`provider-group:remote` 的 `manage-share` 与 `view`，协议记录见
 * docs/dev-rules/protocol-compatibility/provider-group-same-account-management.md)交给供应商所在电脑执行，
 * 手机不保存分享，也不直接访问分享服务；每个动作仍由那台电脑校验账号与归属。
 *
 * 这里只做请求构造与回包解析。回包来自另一台设备：字段不符就当作读取失败，不拼凑部分结果；
 * 写请求(生成链接、同意、拒绝)不重放，结果不明时由界面重新读取现状。
 */
import { PROVIDER_GROUP_REMOTE_CHANNEL, PROVIDER_SHARE_LINK_TTL_MS } from '@cindy/device-link';
import { formatRemoteError, isTransientRemoteError } from '@cindy/maker-shared/device-link-contract';

export type ShareManagementInvoke = <T = unknown>(
  deviceId: string,
  channel: string,
  args?: unknown[],
  opts?: { preSend?: () => void },
) => Promise<T>;

/**
 * - `needs-update`：那台电脑(或分享服务)的版本不认识这个操作；
 * - `offline`：那台电脑暂时连不上；
 * - `not-found`：申请已在别处处理、撤回或过期；
 * - `not-ready`：那台电脑的分享服务还没就绪(未登录、未连上分享服务)；
 * - `failed`：其余，包含回包格式不符。
 */
export type ShareManagementErrorCode = 'needs-update' | 'offline' | 'not-found' | 'not-ready' | 'failed';

export class ShareManagementError extends Error {
  constructor(readonly code: ShareManagementErrorCode) {
    super(`provider share management: ${code}`);
    this.name = 'ShareManagementError';
  }
}

export interface ShareManagementMember {
  memberId: string;
  displayName: string;
  avatarUrl: string | null;
  status: 'active' | 'paused';
  /** 分享者给这个人写的备注；有备注时优先显示，旧电脑没有。 */
  note: string | null;
  runningTasks: number;
}

export interface ShareManagementRequest {
  requestId: string;
  /** 这条申请用的是哪条链接(非秘密的摘要)；旧服务端没有。 */
  linkId: string | null;
  displayName: string;
  avatarUrl: string | null;
  pairingCode: string;
  createdAtMs: number;
}

export interface ShareManagementShare {
  shareId: string;
  providerId: string;
  providerLabel: string;
  members: ShareManagementMember[];
  requests: ShareManagementRequest[];
}

export interface ShareManagementLink {
  link: string;
  linkId: string;
  /** 按手机时钟换算的失效时刻：两台设备的时钟可能不同，不直接用那台电脑的绝对时间。 */
  expiresAtMs: number;
}

export type ShareGroupMemberState = 'available' | 'full' | 'paused' | 'cooling' | 'offline' | 'unavailable';
export type ShareGroupUnavailableReason = 'provider-off' | 'disconnected' | 'share-paused' | 'share-removed';

export interface ShareGroupMember {
  key: string;
  kind: 'local' | 'device' | 'share';
  /** 电脑名；分享来的电脑不显示电脑名，见 ownerName。 */
  label: string;
  /** 同一台电脑上有几个账号时用来区分。 */
  providerName: string | null;
  /** 分享来的电脑：分享者昵称。 */
  ownerName: string | null;
  state: ShareGroupMemberState;
  reason: ShareGroupUnavailableReason | null;
  running: number;
  coolingUntilMs: number | null;
  /** 可信的配额快照确认已用完(不是普通冷却)。 */
  quotaExhausted: boolean;
  /** 配额用完时已知的重置时刻；没有可信时刻为 null，界面不猜恢复时间。 */
  quotaResetAtMs: number | null;
  /** 这台的额度该问哪台电脑的哪个供应商；分享来的电脑不经手机读取额度。 */
  quotaTarget: { deviceId: string; providerId: string } | null;
}

export interface ShareGroupView {
  /** false = 这个供应商没有建组，只有所在电脑这一台。 */
  grouped: boolean;
  members: ShareGroupMember[];
}

export interface ShareQuotaWindow {
  kind: 'session' | 'week' | 'scoped';
  label: string | null;
  remainingPercent: number;
  resetsAtMs: number | null;
  windowMinutes: number | null;
}

export interface ShareQuotaAccount {
  state: 'ready' | 'unsupported' | 'unavailable' | 'offline' | 'needs-update' | 'unlimited';
  windows: ShareQuotaWindow[];
  balance: { remaining: number; total: number | null; currency: 'USD' | 'CNY' } | null;
}

const MAX_SHARES = 256;
const MAX_PEOPLE = 2_000;
const MAX_GROUP_MEMBERS = 512;
/** 一台电脑上一个供应商的订阅账号上限(与 Desktop 的账号池上限同量级)，只用来挡异常回包。 */
const MAX_QUOTA_ACCOUNTS = 32;
const MAX_QUOTA_WINDOWS = 32;
const LINK_ID = /^[a-f0-9]{64}$/;
const PAIRING_CODE = /^[0-9]{4}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown, max: number): string | null {
  // eslint-disable-next-line no-control-regex -- 控制字符是显式拒绝目标
  return typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function count(value: unknown): number {
  return finite(value) && value > 0 ? Math.min(Math.floor(value), 100_000) : 0;
}

/** 头像只接受 https 地址，其余按没有头像处理(与 Desktop 解析分享服务回包同口径)。 */
function avatar(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 2048) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

export function classifyShareManagementError(error: unknown): ShareManagementErrorCode {
  if (error instanceof ShareManagementError) return error.code;
  const message = formatRemoteError(error);
  if (/CHANNEL_NOT_ALLOWED|UNSUPPORTED_CAPABILITY|unknown provider group action|\[INVALID_PARAMS\] Unknown command/.test(message)) {
    return 'needs-update';
  }
  if (/\[NOT_FOUND\]/.test(message)) return 'not-found';
  if (/DEVICE_LINK_NOT_CONNECTED|\[UNAVAILABLE\]/.test(message)) return 'not-ready';
  if (/DEVICE_OFFLINE|NOT_CONNECTED|LINK_NOT_OPEN|INVOKE_TIMEOUT|DEVICE_UNRESPONSIVE/.test(message)
    || isTransientRemoteError(error)) {
    return 'offline';
  }
  return 'failed';
}

async function manageShare(
  invoke: ShareManagementInvoke,
  deviceId: string,
  command: Record<string, unknown>,
  preSend?: () => void,
): Promise<{ result: unknown; respondedAt: number }> {
  let reply: unknown;
  try {
    reply = await invoke(
      deviceId,
      PROVIDER_GROUP_REMOTE_CHANNEL,
      [{ action: 'manage-share', command }],
      preSend ? { preSend } : undefined,
    );
  } catch (error) {
    throw new ShareManagementError(classifyShareManagementError(error));
  }
  const value = record(reply);
  if (!value || !Object.hasOwn(value, 'result') || !finite(value.respondedAt)) throw new ShareManagementError('failed');
  return { result: value.result, respondedAt: value.respondedAt };
}

function parseMember(raw: unknown): ShareManagementMember | null {
  const value = record(raw);
  const memberId = text(value?.memberId, 128);
  const displayName = text(value?.displayName, 128);
  if (!value || !memberId || !displayName || (value.status !== 'active' && value.status !== 'paused')) return null;
  return {
    memberId,
    displayName,
    avatarUrl: avatar(value.avatarUrl),
    status: value.status,
    note: text(value.note, 160),
    runningTasks: count(value.runningTasks),
  };
}

function parseRequest(raw: unknown): ShareManagementRequest | null {
  const value = record(raw);
  const requestId = text(value?.requestId, 128);
  const displayName = text(value?.displayName, 128);
  const createdAtMs = typeof value?.createdAt === 'string' ? Date.parse(value.createdAt) : Number.NaN;
  if (!value || !requestId || !displayName || !Number.isFinite(createdAtMs)) return null;
  if (typeof value.pairingCode !== 'string' || !PAIRING_CODE.test(value.pairingCode)) return null;
  if (value.linkId !== undefined && (typeof value.linkId !== 'string' || !LINK_ID.test(value.linkId))) return null;
  return {
    requestId,
    linkId: typeof value.linkId === 'string' ? value.linkId : null,
    displayName,
    avatarUrl: avatar(value.avatarUrl),
    pairingCode: value.pairingCode,
    createdAtMs,
  };
}

/** `owned` 回包 → 这台电脑上的分享。有一条分享、成员或申请解析不了就整份作废，不显示半份名单。 */
export function parseOwnedShares(raw: unknown): { ready: boolean; shares: ShareManagementShare[] } | null {
  const value = record(raw);
  if (!value || typeof value.ready !== 'boolean' || !Array.isArray(value.shares) || value.shares.length > MAX_SHARES) {
    return null;
  }
  const shares: ShareManagementShare[] = [];
  for (const entry of value.shares) {
    const share = record(entry);
    const shareId = text(share?.shareId, 128);
    const providerId = text(share?.providerId, 256);
    const providerLabel = text(share?.providerLabel, 256);
    if (!share || !shareId || !providerId || !providerLabel) return null;
    if (!Array.isArray(share.members) || !Array.isArray(share.requests)) return null;
    if (share.members.length > MAX_PEOPLE || share.requests.length > MAX_PEOPLE) return null;
    const members = share.members.map(parseMember);
    const requests = share.requests.map(parseRequest);
    if (members.includes(null) || requests.includes(null)) return null;
    shares.push({
      shareId,
      providerId,
      providerLabel,
      members: members as ShareManagementMember[],
      requests: (requests as ShareManagementRequest[]).sort((a, b) => a.createdAtMs - b.createdAtMs),
    });
  }
  return { ready: value.ready, shares };
}

/**
 * 读那台电脑上的分享(成员与待处理申请)。`includeUsage: false`：手机不显示用量，不让那台电脑为此查历史与估价；
 * 旧电脑忽略这个参数、照旧附带用量，手机不读那些字段。
 */
export async function readOwnedShares(
  invoke: ShareManagementInvoke,
  deviceId: string,
): Promise<ShareManagementShare[]> {
  const { result } = await manageShare(invoke, deviceId, { action: 'owned', range: '7d', includeUsage: false });
  const owned = parseOwnedShares(result);
  if (!owned) throw new ShareManagementError('failed');
  if (!owned.ready) throw new ShareManagementError('not-ready');
  return owned.shares;
}

/**
 * `create-link` 回包 → 链接与按手机时钟换算的失效时刻。缺链接标识说明那台电脑或分享服务较旧：
 * 没有它就认不出哪条申请是这条链接带来的，按需要更新处理，不退回按供应商关注。
 */
export function parseCreatedShareLink(
  reply: { result: unknown; respondedAt: number },
  receivedAtMs: number,
): ShareManagementLink {
  const value = record(reply.result);
  if (!value) throw new ShareManagementError('failed');
  if (value.linkId === undefined) throw new ShareManagementError('needs-update');
  const link = typeof value.link === 'string' ? value.link : '';
  const expiresAt = typeof value.expiresAt === 'string' ? Date.parse(value.expiresAt) : Number.NaN;
  if (!link || link.length > 4096 || /\s/.test(link) || typeof value.linkId !== 'string' || !LINK_ID.test(value.linkId)
    || !Number.isFinite(expiresAt)) {
    throw new ShareManagementError('failed');
  }
  const remaining = Math.max(0, Math.min(PROVIDER_SHARE_LINK_TTL_MS, expiresAt - reply.respondedAt));
  return { link, linkId: value.linkId, expiresAtMs: receivedAtMs + remaining };
}

export async function createShareLink(
  invoke: ShareManagementInvoke,
  deviceId: string,
  providerId: string,
  preSend?: () => void,
): Promise<ShareManagementLink> {
  const reply = await manageShare(invoke, deviceId, { action: 'create-link', providerId }, preSend);
  return parseCreatedShareLink(reply, Date.now());
}

export async function decideShareRequest(
  invoke: ShareManagementInvoke,
  deviceId: string,
  requestId: string,
  decision: 'approve' | 'reject',
  preSend?: () => void,
): Promise<void> {
  const { result } = await manageShare(invoke, deviceId, { action: decision, requestId }, preSend);
  if (record(result)?.ok !== true) throw new ShareManagementError('failed');
}

const MEMBER_STATES: readonly ShareGroupMemberState[] = ['available', 'full', 'paused', 'cooling', 'offline', 'unavailable'];
const UNAVAILABLE_REASONS: readonly ShareGroupUnavailableReason[] = ['provider-off', 'disconnected', 'share-paused', 'share-removed'];

/**
 * 组视图 → 组内每台电脑的状态，以及它的额度该去问谁。没有组时返回 `grouped: false`，由界面只列供应商所在电脑。
 * 状态里有、组设置里没有的条目不采用(那台刚被移出)；格式不符整份作废。
 */
export function parseShareGroupView(raw: unknown, hostDeviceId: string): ShareGroupView | null {
  const value = record(raw);
  if (!value || !Array.isArray(value.members) || value.members.length > MAX_GROUP_MEMBERS) return null;
  if (value.config === null) return { grouped: false, members: [] };
  const config = record(value.config);
  if (!config || !Array.isArray(config.members) || config.members.length > MAX_GROUP_MEMBERS) return null;
  const targets = new Map<string, ShareGroupMember['quotaTarget']>();
  for (const entry of config.members) {
    const member = record(entry);
    const key = text(member?.key, 512);
    const providerId = text(member?.providerId, 256);
    if (!member || !key || !providerId) return null;
    if (member.kind === 'local') targets.set(key, { deviceId: hostDeviceId, providerId });
    else if (member.kind === 'device') {
      const deviceId = text(member.agentDeviceId, 128);
      if (!deviceId) return null;
      targets.set(key, { deviceId, providerId });
    } else if (member.kind === 'share') targets.set(key, null);
    else return null;
  }
  const members: ShareGroupMember[] = [];
  for (const entry of value.members) {
    const status = record(entry);
    const key = text(status?.key, 512);
    const label = text(status?.label, 256);
    if (!status || !key || !label) return null;
    if (status.kind !== 'local' && status.kind !== 'device' && status.kind !== 'share') return null;
    if (!MEMBER_STATES.includes(status.state as ShareGroupMemberState)) return null;
    if (!targets.has(key)) continue;
    const usageLimit = record(status.usageLimit);
    members.push({
      key,
      kind: status.kind,
      label,
      providerName: text(status.providerName, 256),
      ownerName: text(status.ownerName, 128),
      state: status.state as ShareGroupMemberState,
      reason: UNAVAILABLE_REASONS.includes(status.reason as ShareGroupUnavailableReason)
        ? status.reason as ShareGroupUnavailableReason
        : null,
      running: count(status.running),
      coolingUntilMs: finite(status.coolingUntil) && status.coolingUntil > 0 ? status.coolingUntil : null,
      quotaExhausted: usageLimit !== null,
      quotaResetAtMs: usageLimit && finite(usageLimit.resetAtMs) && usageLimit.resetAtMs > 0 ? usageLimit.resetAtMs : null,
      quotaTarget: targets.get(key) ?? null,
    });
  }
  return { grouped: true, members };
}

/** 读组视图(只读，同一通道的 `view`)。那台电脑没对这个供应商开放远程调用时回的也是「没有组」。 */
export async function readShareGroupView(
  invoke: ShareManagementInvoke,
  deviceId: string,
  providerId: string,
): Promise<ShareGroupView> {
  let reply: unknown;
  try {
    reply = await invoke(deviceId, PROVIDER_GROUP_REMOTE_CHANNEL, [{ action: 'view', providerId }]);
  } catch (error) {
    throw new ShareManagementError(classifyShareManagementError(error));
  }
  const view = parseShareGroupView(reply, deviceId);
  if (!view) throw new ShareManagementError('failed');
  return view;
}

const QUOTA_STATES: readonly ShareQuotaAccount['state'][] = ['ready', 'unsupported', 'unavailable', 'offline', 'needs-update', 'unlimited'];
const QUOTA_WINDOW_KINDS: readonly ShareQuotaWindow['kind'][] = ['session', 'week', 'scoped'];

function parseQuotaAccount(raw: unknown): ShareQuotaAccount | null {
  const value = record(raw);
  if (!value || !QUOTA_STATES.includes(value.state as ShareQuotaAccount['state']) || !Array.isArray(value.windows)) {
    return null;
  }
  const windows: ShareQuotaWindow[] = [];
  for (const entry of value.windows.slice(0, MAX_QUOTA_WINDOWS)) {
    const window = record(entry);
    if (!window || !QUOTA_WINDOW_KINDS.includes(window.kind as ShareQuotaWindow['kind'])
      || !finite(window.remainingPercent)) {
      continue;
    }
    windows.push({
      kind: window.kind as ShareQuotaWindow['kind'],
      label: text(window.label, 128),
      remainingPercent: Math.min(100, Math.max(0, window.remainingPercent)),
      resetsAtMs: finite(window.resetsAt) && window.resetsAt > 0 ? window.resetsAt : null,
      windowMinutes: finite(window.windowMinutes) && window.windowMinutes > 0 ? window.windowMinutes : null,
    });
  }
  const balance = record(value.balance);
  return {
    state: value.state as ShareQuotaAccount['state'],
    windows,
    balance: balance && finite(balance.remaining) && (balance.currency === 'USD' || balance.currency === 'CNY')
      ? {
          remaining: balance.remaining,
          total: finite(balance.total) && balance.total > 0 ? balance.total : null,
          currency: balance.currency,
        }
      : null,
  };
}

/**
 * `quota-account` 回包 → 这台电脑上这个供应商每个账号的额度。新电脑在 `accounts` 里逐个账号列出，
 * 旧电脑只回默认账号那一份。没有读数的状态(离线、不支持等)保留状态，不当成零额度。
 */
export function parseShareQuotaAccounts(raw: unknown): ShareQuotaAccount[] | null {
  const value = record(raw);
  if (!value) return null;
  const listed = Array.isArray(value.accounts) && value.accounts.length > 0
    ? value.accounts.slice(0, MAX_QUOTA_ACCOUNTS)
    : [value];
  const accounts = listed.map(parseQuotaAccount);
  return accounts.includes(null) ? null : accounts as ShareQuotaAccount[];
}

/** 读一台电脑上一个供应商的账号额度(只读；那台电脑对同一份读取有 30 秒缓存并合并在途请求)。 */
export async function readShareQuota(
  invoke: ShareManagementInvoke,
  deviceId: string,
  providerId: string,
): Promise<ShareQuotaAccount[]> {
  const { result } = await manageShare(invoke, deviceId, { action: 'quota-account', providerId });
  const accounts = parseShareQuotaAccounts(result);
  if (!accounts) throw new ShareManagementError('failed');
  return accounts;
}
