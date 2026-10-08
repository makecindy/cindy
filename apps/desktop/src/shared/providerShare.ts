/**
 * 供应商分享的 Renderer ↔ Main 契约(只在本机进程之间；服务端契约见
 * docs/provider-sharing-contract.md)。身份只有昵称与头像。
 */
import type {
  ProviderShareLinkPreview,
  ProviderShareMember,
  ProviderShareReceived,
  ProviderShareRequestItem,
  ProviderShareRequestState,
} from '@cindy/device-link';

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
} as const;

export type ProviderShareUsageRange = '7d' | 'month' | 'all';

export interface ProviderShareMoney {
  amount: number;
  currency: 'USD' | 'CNY';
}

export interface ProviderShareModelUsageView {
  kind: string;
  providerId: string | null;
  model: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  /** 按本地单价估算；拿不到单价时为 null。 */
  amount: ProviderShareMoney | null;
}

export interface ProviderShareMemberView extends ProviderShareMember {
  lastUsedAt: number | null;
  runningTasks: number;
  models: ProviderShareModelUsageView[];
}

export interface ProviderShareOwnedView {
  shareId: string;
  providerId: string;
  providerLabel: string;
  createdAt: string;
  members: ProviderShareMemberView[];
  requests: ProviderShareRequestItem[];
}

export interface ProviderShareOwnerState {
  /** 分享服务可用(已登录、设备互联已连上本区域服务)。 */
  ready: boolean;
  shares: ProviderShareOwnedView[];
}

export interface ProviderShareLinkCreated {
  link: string;
  expiresAt: string;
}

export interface ProviderShareRequestedEvent {
  request: ProviderShareRequestItem;
  share: { shareId: string; providerId: string; providerLabel: string };
}

export interface ProviderShareSettledEvent {
  state: ProviderShareRequestState;
  preview: ProviderShareLinkPreview | null;
}

export type ProviderShareCommand =
  | { action: 'owned'; range: ProviderShareUsageRange }
  | { action: 'create-link'; providerId: string }
  | { action: 'approve' | 'reject'; requestId: string }
  | { action: 'set-member'; memberId: string; status: 'pause' | 'resume' | 'remove' }
  | { action: 'received' }
  | { action: 'preview'; link: string }
  | { action: 'send-request'; link: string }
  | { action: 'get-request'; requestId: string }
  | { action: 'withdraw'; requestId: string }
  | { action: 'leave'; memberId: string };

export interface ProviderShareCommandResult {
  owned: ProviderShareOwnerState;
  'create-link': ProviderShareLinkCreated;
  approve: { ok: true };
  reject: { ok: true };
  'set-member': { ok: true };
  received: ProviderShareReceived[];
  preview: ProviderShareLinkPreview;
  'send-request': ProviderShareRequestState;
  'get-request': ProviderShareRequestState;
  withdraw: { ok: true };
  leave: { ok: true };
}

/** 任务记录里「Agent 在某个分享者的电脑上」的前缀(见 main/device-link/providerShareGuest)。 */
export const PROVIDER_SHARE_AGENT_DEVICE_PREFIX = 'share:';

export function isProviderShareAgentDeviceId(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PROVIDER_SHARE_AGENT_DEVICE_PREFIX);
}
