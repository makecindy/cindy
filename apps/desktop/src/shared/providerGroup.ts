/**
 * 供应商组的 Renderer ↔ Main 契约(只在本机进程之间)。
 *
 * 一台电脑上的某个供应商可以建一个供应商组，把这台电脑已经能用的同一个供应商(本机、同账号
 * 电脑上已开「允许被远程调用」的、别人分享给这个账号的)合成一组；之后这个供应商的使用按组策略
 * 选一台组内电脑运行 Agent。产品规则见 docs/product-rules/provider-groups.md。
 */
import { isProviderShareAgentDeviceId, PROVIDER_SHARE_AGENT_DEVICE_PREFIX } from './providerShare.js';

export const PROVIDER_GROUP_IPC = {
  /** Renderer → Main：全部操作走同一个命令通道。 */
  COMMAND: 'provider-group:command',
  /** 某个供应商的组设置变化。payload: { providerId: string } */
  CHANGED: 'provider-group:changed',
} as const;

export type ProviderGroupStrategy = 'least' | 'round' | 'order' | 'weight';
export const PROVIDER_GROUP_STRATEGIES: readonly ProviderGroupStrategy[] = ['least', 'round', 'order', 'weight'];

export type ProviderGroupMemberKind = 'local' | 'device' | 'share';

/** 每台组内电脑默认同时接几个任务。 */
export const PROVIDER_GROUP_DEFAULT_LIMIT = 4;
/** 远程 Agent 对每个控制端最多 16 个任务，组内电脑的并发上限不超过它。 */
export const PROVIDER_GROUP_MAX_LIMIT = 16;
export const PROVIDER_GROUP_DEFAULT_WEIGHT = 1;
export const PROVIDER_GROUP_MAX_WEIGHT = 100;
/**
 * 组内电脑数量不设产品上限；这里只是防止损坏的设置文件无限膨胀的存储边界，远高于实际用量。
 */
export const PROVIDER_GROUP_STORAGE_MEMBER_CAP = 512;

export const PROVIDER_GROUP_LOCAL_MEMBER_KEY = 'local';

export interface ProviderGroupMember {
  /** 稳定键：`local` / `device:<deviceId>:<providerId>` / `share:<shareId>:<providerId>`。 */
  key: string;
  kind: ProviderGroupMemberKind;
  /** 运行 Agent 的电脑：null = 本机；同账号电脑的设备 id；分享来的为 `share:<shareId>`。 */
  agentDeviceId: string | null;
  /** 那台电脑上这个供应商的 id(各电脑上可能不同，例如订阅账号带随机后缀)。 */
  providerId: string;
  /** 加入时的显示名快照，那台电脑离线时展示。 */
  label?: string;
  /** 并发上限：只统计经本组分到这台的任务。 */
  limit: number;
  weight: number;
  /** 暂停分配(本机即「关掉本机」)：不再给它分新任务，正在运行的不受影响。 */
  paused: boolean;
}

export interface ProviderGroupConfig {
  strategy: ProviderGroupStrategy;
  /** 组内电脑失败时自动换一台继续，默认开启。 */
  autoSwitch: boolean;
  members: ProviderGroupMember[];
}

export type ProviderGroupMemberState =
  /** 可以接新任务。 */
  | 'available'
  /** 已达到并发上限。 */
  | 'full'
  /** 暂停分配。 */
  | 'paused'
  /** 撞到用量上限后冷却中。 */
  | 'cooling'
  /** 连不上(离线、未开远程控制、分享者电脑不在线)。 */
  | 'offline'
  /** 连得上，但这个供应商现在不能用。 */
  | 'unavailable';

export type ProviderGroupUnavailableReason =
  /** 那台没对这个供应商打开「允许被远程调用」，或目录里已没有这个供应商。 */
  | 'provider-off'
  /** 供应商未连接或已停用。 */
  | 'disconnected'
  | 'share-paused'
  | 'share-removed';

export interface ProviderGroupMemberStatus {
  key: string;
  kind: ProviderGroupMemberKind;
  /** 设备名(本机为本机设备名)。 */
  label: string;
  /** 分享来的电脑：分享者昵称。 */
  ownerName?: string;
  state: ProviderGroupMemberState;
  reason?: ProviderGroupUnavailableReason;
  /** 经本组分到这台、正在运行的任务数。 */
  running: number;
  limit: number;
  weight: number;
  paused: boolean;
  /** 冷却到何时(unix ms)。 */
  coolingUntil?: number;
}

export interface ProviderGroupView {
  providerId: string;
  /** null = 还没有组。 */
  config: ProviderGroupConfig | null;
  members: ProviderGroupMemberStatus[];
}

export type ProviderGroupCandidateBlock =
  /** 已在组里。 */
  | 'member'
  | 'offline'
  /** 不是同一个供应商。 */
  | 'mismatch';

export interface ProviderGroupCandidate {
  key: string;
  kind: 'device' | 'share';
  agentDeviceId: string;
  providerId: string;
  /** 设备名。 */
  label: string;
  /** 那台电脑上这个供应商的显示名。 */
  providerName: string;
  ownerName?: string;
  blocked?: ProviderGroupCandidateBlock;
}

export type ProviderGroupCommand =
  | { action: 'get'; providerId: string }
  | { action: 'candidates'; providerId: string }
  | { action: 'save'; providerId: string; config: ProviderGroupConfig }
  | { action: 'delete'; providerId: string };

export type ProviderGroupCommandResult<C extends ProviderGroupCommand> =
  C extends { action: 'get' } ? ProviderGroupView
    : C extends { action: 'candidates' } ? ProviderGroupCandidate[]
      : C extends { action: 'save' } ? ProviderGroupView
        : C extends { action: 'delete' } ? ProviderGroupView
          : never;

const PROVIDER_ID_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isProviderGroupProviderId(value: unknown): value is string {
  return typeof value === 'string' && PROVIDER_ID_PATTERN.test(value);
}

/** 组内电脑的稳定键：同一台电脑上的同一个供应商只能在组里出现一次。 */
export function providerGroupMemberKey(agentDeviceId: string | null, providerId: string): string {
  if (agentDeviceId === null) return PROVIDER_GROUP_LOCAL_MEMBER_KEY;
  if (isProviderShareAgentDeviceId(agentDeviceId)) {
    return `share:${agentDeviceId.slice(PROVIDER_SHARE_AGENT_DEVICE_PREFIX.length)}:${providerId}`;
  }
  return `device:${agentDeviceId}:${providerId}`;
}

function isAgentDeviceIdFor(kind: ProviderGroupMemberKind, value: unknown): boolean {
  if (kind === 'local') return value === null;
  if (typeof value !== 'string') return false;
  if (kind === 'share') {
    return isProviderShareAgentDeviceId(value)
      && SHARE_ID_PATTERN.test(value.slice(PROVIDER_SHARE_AGENT_DEVICE_PREFIX.length));
  }
  return !isProviderShareAgentDeviceId(value) && DEVICE_ID_PATTERN.test(value);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizeLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  // eslint-disable-next-line no-control-regex -- 控制字符是显式拒绝目标
  if (!trimmed || trimmed.length > 128 || /[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  return trimmed;
}

function normalizeMember(raw: unknown, groupProviderId: string): ProviderGroupMember | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const kind = value.kind;
  if (kind !== 'local' && kind !== 'device' && kind !== 'share') return null;
  const agentDeviceId = kind === 'local' ? null : value.agentDeviceId;
  if (!isAgentDeviceIdFor(kind, agentDeviceId)) return null;
  // 本机组员就是组所属的这个供应商本身。
  const providerId = kind === 'local' ? groupProviderId : value.providerId;
  if (!isProviderGroupProviderId(providerId)) return null;
  const label = normalizeLabel(value.label);
  return {
    key: providerGroupMemberKey(agentDeviceId as string | null, providerId),
    kind,
    agentDeviceId: agentDeviceId as string | null,
    providerId,
    ...(label ? { label } : {}),
    limit: clampInt(value.limit, 1, PROVIDER_GROUP_MAX_LIMIT, PROVIDER_GROUP_DEFAULT_LIMIT),
    weight: clampInt(value.weight, 1, PROVIDER_GROUP_MAX_WEIGHT, PROVIDER_GROUP_DEFAULT_WEIGHT),
    paused: value.paused === true,
  };
}

/**
 * 校正一份组设置(存储读取与 IPC 写入共用)。没有组内电脑 = 没有组，返回 null：
 * 组里至少保留一台，移除最后一台即删除组。
 */
export function normalizeProviderGroupConfig(raw: unknown, groupProviderId: string): ProviderGroupConfig | null {
  if (!isProviderGroupProviderId(groupProviderId)) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const strategy = PROVIDER_GROUP_STRATEGIES.includes(value.strategy as ProviderGroupStrategy)
    ? value.strategy as ProviderGroupStrategy
    : 'least';
  const members: ProviderGroupMember[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(value.members) ? value.members : []) {
    if (members.length >= PROVIDER_GROUP_STORAGE_MEMBER_CAP) break;
    const member = normalizeMember(entry, groupProviderId);
    if (!member || seen.has(member.key)) continue;
    seen.add(member.key);
    members.push(member);
  }
  if (members.length === 0) return null;
  return { strategy, autoSwitch: value.autoSwitch !== false, members };
}
