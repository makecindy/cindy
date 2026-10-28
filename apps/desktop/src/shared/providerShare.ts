/**
 * 供应商分享的 Renderer ↔ Main 契约(只在本机进程之间；服务端契约见
 * docs/provider-sharing-contract.md)。身份只有昵称与头像。
 */
import type { RemoteAgentLimits, RemoteAgentLimitsView } from './remoteAgentLimits';
import type { RemoteModelAccessView, RemoteModelSelection } from './remoteModelAccess';

import type {
  ProviderShareLinkPreview,
  ProviderShareMember,
  ProviderShareReceived,
  ProviderShareRequestItem,
  ProviderShareRequestState,
} from '@cindy/device-link';
import type { DataOwnerPushStamp } from './dataOwnerPush';
import type { ProviderShareInsights, ProviderShareQuotaAccount, ProviderShareVisibility } from './providerShareInsights';

/** 本机收藏清理依据。未加载、断线和账号切换的空列表不能用于撤权清理。 */
export interface ProviderShareReceivedSnapshot {
  ownerStamp: DataOwnerPushStamp;
  /** 仅这些区域的名单完整，可据此清理已撤权收藏；其它区域不受影响。 */
  confirmedRegions: readonly ProviderShareReceived['owner']['region'][];
  received: readonly ProviderShareReceived[];
}

/** 本机收藏作为重启后的查询线索，不作为授权或撤权依据。 */
export interface ProviderShareFavoriteRecovery {
  ownerStamp: DataOwnerPushStamp;
  regions: readonly ProviderShareReceived['owner']['region'][];
}

export const PROVIDER_SHARE_IPC = {
  /** Renderer → Main：全部操作走同一个命令通道。 */
  COMMAND: 'provider-share:command',
  /** 分享者：分享快照变化(管理页按当前时间段重新读取)。 */
  OWNED_CHANGED: 'provider-share:owned-changed',
  /** 受邀者：已收到的分享变化(模型列表)。payload: ProviderShareReceived[] */
  RECEIVED_CHANGED: 'provider-share:received-changed',
  /** 分享者：新的待审批申请。payload: ProviderShareRequestedEvent */
  REQUESTED: 'provider-share:requested',
  /** 受邀者：发出的申请有了结果。payload: ProviderShareSettledEvent */
  SETTLED: 'provider-share:settled',
  /** 打开分享链接(深链或系统通知点击)。payload: { link: string } */
  OPEN_JOIN: 'provider-share:open-join',
  /** 打开某个供应商的分享管理页(系统通知点击)。payload: { providerId: string } */
  OPEN_MANAGE: 'provider-share:open-manage',
  /** 分享者：有人把这里分享的供应商放进了自己的供应商组，请求转给别人用(待处理一栏重读)。payload: null */
  RESHARE_REQUESTED: 'provider-share:reshare-requested',
} as const;

export type ProviderShareUsageRange = '7d' | 'month' | 'all';

export interface ProviderShareMoney {
  amount: number;
  currency: 'USD' | 'CNY';
}

export interface ProviderShareModelUsageView {
  kind: string;
  providerId: string | null;
  /**
   * 这一部分在哪台组内电脑运行(供应商组的组内电脑稳定键，本机为 `local`)；「用量」块据此按组内电脑展开。
   * 这一字段加上之前记的用量没有区分，为 null。
   */
  memberKey: string | null;
  model: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  /** 按本地单价估算；拿不到单价时为 null。 */
  amount: ProviderShareMoney | null;
}

/**
 * 转分享(provider-sharing.md §4.3)：这个成员把分享来的供应商放进了自己的供应商组，又把组分享给了别人。
 * 每一项是他分享的一个人；昵称与头像由他的电脑转述。
 */
export interface ProviderShareReshareView {
  id: string;
  name: string;
  avatarUrl: string | null;
  state: 'pending' | 'approved' | 'rejected';
  requestedAt: number;
  decidedAt: number | null;
}

export interface ProviderShareMemberView extends ProviderShareMember {
  /** 分享者给这个成员设置的备注；只用于管理页，不向受邀者公开。旧电脑可能缺省。 */
  note?: string | null;
  lastUsedAt: number | null;
  runningTasks: number;
  models: ProviderShareModelUsageView[];
  /** 经这个成员的供应商组转给别人用的请求；没有时为空(旧快照可能缺省)。 */
  reshares?: ProviderShareReshareView[];
}

export interface ProviderShareOwnedView {
  shareId: string;
  providerId: string;
  providerLabel: string;
  createdAt: string;
  members: ProviderShareMemberView[];
  requests: ProviderShareRequestItem[];
}

/** 「远程与分享」页按使用方的用量里一个使用方(本机、同账号的另一台电脑，或经那台转来的受邀者任务)。 */
export interface ProviderPartyUsageView {
  /** null = 本机。 */
  deviceId: string | null;
  /** 那台电脑的名字；读不到或本机时为 null。 */
  deviceName: string | null;
  lastUsedAt: number;
  models: ProviderShareModelUsageView[];
}

/**
 * 某个供应商按使用方的用量里，这台电脑自己能记到的部分(provider-groups.md §7)：本机自己的任务(含归本机
 * 供应商组、在组里其他电脑上运行的)，与同账号其他电脑经这台电脑的任务。分享的人在 owned 的成员里。
 * 界面把本机与我的其他电脑合成「自己」一行(当前登录的账号)。
 */
export interface ProviderOwnUsageView {
  providerId: string;
  /** 本机自己的任务；没用过时为 null。 */
  local: ProviderPartyUsageView | null;
  /** 同账号的其他电脑自己的任务，每台一项，最近用过的在前。 */
  devices: ProviderPartyUsageView[];
  /** 同账号的组所在电脑替它的受邀者转到本机运行的任务，每台组所在电脑一项(本机看不到最终使用者)。 */
  relays: ProviderPartyUsageView[];
}

/** 按天明细里的一行：那台电脑本地日期的一天，按(Agent、供应商、模型、组内电脑)分行。 */
export interface ProviderUsageDayView extends ProviderShareModelUsageView {
  /** YYYY-MM-DD，供应商所在电脑的本地日期。 */
  day: string;
}

/** 一个使用方按天的用量；最近使用时间与 own-usage / owned 同口径。 */
export interface ProviderUsageHistoryPartyView {
  lastUsedAt: number | null;
  /** 新的日子在前。 */
  days: ProviderUsageDayView[];
}

/**
 * 「远程与分享」页「用量」块的按天明细(provider-groups.md §7)：时间段、使用方与组内电脑都由界面按天筛选，
 * 与设置 → 用量同一种做法。日期一律是供应商所在电脑的本地日期，`todayKey` 是那台电脑的今天。
 */
export interface ProviderUsageHistoryView {
  providerId: string;
  todayKey: string;
  /** 行数或 UTF-8 字节超出回包预算、裁掉较早行时，留下的最早一天；没有裁剪为 null。 */
  coverageStart: string | null;
  /** 你自己：本机与同账号其他电脑经这个供应商(组)的合计。 */
  self: ProviderUsageHistoryPartyView;
  /** 同账号的组所在电脑替它的受邀者转来的，每台一项(看不到最终使用者)。 */
  relays: Array<ProviderUsageHistoryPartyView & { deviceId: string; deviceName: string | null }>;
  /** 这个供应商的分享里现在的成员，按人。 */
  members: Array<ProviderUsageHistoryPartyView & { shareId: string; memberId: string }>;
}

export interface ProviderShareOwnerState {
  /** 分享服务可用(已登录、设备互联已连上本区域服务)。 */
  ready: boolean;
  shares: ProviderShareOwnedView[];
  /** 本机分享里、链接由同账号另一台电脑生成的申请：由那台弹审批窗，本机只在管理页与提示点显示。 */
  quietRequestIds?: string[];
  /** 本机为同账号另一台电脑上的分享生成链接后收到的申请：由本机弹审批窗，处理转交那台电脑。 */
  watchedRequests?: ProviderShareRequestedEvent[];
}

export interface ProviderShareLinkCreated {
  link: string;
  expiresAt: string;
  /** Non-secret per-link identifier; absent when the host or server predates exact approval routing. */
  linkId?: string;
}

export interface ProviderShareRequestedEvent {
  request: ProviderShareRequestItem;
  share: { shareId: string; providerId: string; providerLabel: string };
  /** 分享在同账号另一台电脑上(本机生成了链接，由本机弹窗)；本机的分享不带。 */
  hostDeviceId?: string;
  /** true = 链接由同账号另一台电脑生成，由那台弹窗，本机不弹。 */
  quiet?: boolean;
}

export interface ProviderShareSettledEvent {
  state: ProviderShareRequestState;
  preview: ProviderShareLinkPreview | null;
}


export type ProviderShareCommand =
  | { action: 'get-fast-policy'; providerId: string }
  | { action: 'set-fast-policy'; providerId: string; allowFast: boolean }
  | { action: 'get-model-access'; providerId: string; memberId?: string }
  | { action: 'set-model-access'; providerId: string; memberId?: string; models: RemoteModelSelection }
  | { action: 'get-visibility'; providerId: string }
  | { action: 'set-visibility'; providerId: string; visibility: Partial<ProviderShareVisibility> }
  | { action: 'quota-account'; providerId: string }
  | { action: 'insights'; shareId: string; includeUsage: boolean }
  | { action: 'get-run-limits' }
  | { action: 'reset-run-limits' }
  | { action: 'set-run-limits'; limits: Partial<RemoteAgentLimits> }
  | { action: 'owned'; range: ProviderShareUsageRange }
  /** 这个供应商按使用方的用量(本机与我的其他电脑)。不依赖分享服务。 */
  | { action: 'own-usage'; providerId: string; range: ProviderShareUsageRange }
  /** 这个供应商的用量按天明细(你自己、转来的与分享的人)，「用量」块据此按时间段、人与电脑筛选。 */
  | { action: 'usage-history'; providerId: string }
  | { action: 'create-link'; providerId: string }
  | { action: 'approve' | 'reject'; requestId: string }
  | { action: 'set-member'; memberId: string; status: 'pause' | 'resume' | 'remove' }
  | { action: 'set-member-note'; memberId: string; note: string }
  /** 转分享：同意或拒绝(拒绝已同意的 = 撤回)。 */
  | { action: 'reshare-decide'; id: string; decision: 'approve' | 'reject' }
  | { action: 'received' }
  | { action: 'received-snapshot'; favoriteRecovery?: ProviderShareFavoriteRecovery }
  | { action: 'preview'; link: string }
  | { action: 'send-request'; link: string }
  | { action: 'get-request'; requestId: string }
  | { action: 'withdraw'; requestId: string }
  | { action: 'leave'; memberId: string }
  /** 受邀者：这个分享的任务里凭证类操作是否不再在本机确认(provider-sharing.md §9 第 7 条)。 */
  | { action: 'get-credential-consent'; shareId: string }
  | { action: 'set-credential-consent'; shareId: string; skip: boolean };

/** 受邀者对一个分享的本机偏好：true = 凭证类操作不再确认。只对这台电脑生效。 */
export interface ProviderShareCredentialConsentView {
  skip: boolean;
}

export interface ProviderShareCommandResult {
  'get-fast-policy': { supported: boolean; allowFast: boolean };
  'set-fast-policy': { supported: boolean; allowFast: boolean };
  'get-model-access': RemoteModelAccessView;
  'set-model-access': RemoteModelAccessView;
  'get-visibility': ProviderShareVisibility;
  'set-visibility': ProviderShareVisibility;
  'quota-account': ProviderShareQuotaAccount;
  insights: ProviderShareInsights;
  'get-run-limits': RemoteAgentLimitsView;
  'set-run-limits': RemoteAgentLimitsView;
  'reset-run-limits': RemoteAgentLimitsView;
  owned: ProviderShareOwnerState;
  'own-usage': ProviderOwnUsageView;
  'usage-history': ProviderUsageHistoryView;
  'create-link': ProviderShareLinkCreated;
  approve: { ok: true };
  reject: { ok: true };
  'set-member': { ok: true };
  'set-member-note': { ok: true };
  'reshare-decide': { ok: true };
  received: ProviderShareReceived[];
  'received-snapshot': ProviderShareReceivedSnapshot;
  preview: ProviderShareLinkPreview;
  'send-request': ProviderShareRequestState;
  'get-request': ProviderShareRequestState;
  withdraw: { ok: true };
  leave: { ok: true };
  'get-credential-consent': ProviderShareCredentialConsentView;
  'set-credential-consent': ProviderShareCredentialConsentView;
}

/** 任务记录里「Agent 在某个分享者的电脑上」的前缀(见 main/device-link/providerShareGuest)。 */
export const PROVIDER_SHARE_AGENT_DEVICE_PREFIX = 'share:';

export function isProviderShareAgentDeviceId(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PROVIDER_SHARE_AGENT_DEVICE_PREFIX);
}

/** 这个设备 id 指向的分享 id；不是分享时为 null。只拆前缀，不校验格式。 */
export function providerShareIdOfAgentDeviceId(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || !value.startsWith(PROVIDER_SHARE_AGENT_DEVICE_PREFIX)) return null;
  return value.slice(PROVIDER_SHARE_AGENT_DEVICE_PREFIX.length) || null;
}
