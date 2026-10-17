/**
 * 供应商组的 Renderer ↔ Main 契约(只在本机进程之间)。
 *
 * 一台电脑上的某个供应商可以建一个供应商组，把这台电脑已经能用的同一个供应商(本机、同账号
 * 电脑上已开「允许被远程调用」的、别人分享给这个账号的)合成一组；之后这个供应商的使用按组策略
 * 选一台组内电脑运行 Agent。产品规则见 docs/product-rules/provider-groups.md。
 */
import { isProviderShareAgentDeviceId, PROVIDER_SHARE_AGENT_DEVICE_PREFIX } from './providerShare.js';
import type { ProviderManagementRequest, ProviderManagementResult } from './providerManagement';

export const PROVIDER_GROUP_IPC = {
  /** Renderer → Main：全部操作走同一个命令通道。 */
  COMMAND: 'provider-group:command',
  /** 某个供应商的组设置变化。payload: { providerId: string } */
  CHANGED: 'provider-group:changed',
} as const;

export type ProviderGroupStrategy = 'least' | 'round' | 'order' | 'weight' | 'usage';
export const PROVIDER_GROUP_STRATEGIES: readonly ProviderGroupStrategy[] = ['least', 'round', 'order', 'weight', 'usage'];

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
  /** 加入时的供应商显示名快照；用于同一台电脑上的多个供应商账号区分。 */
  providerName?: string;
  /**
   * 分享来的电脑：分享者那台电脑的设备 id(本账号收到的分享里本来就有)。只用来把同一台电脑上的几个分享
   * 按一台电脑展示与计数，不显示、不用于连接；不会发给受邀者。旧组没有时由组所在电脑对账补上(removedShares.ts)。
   */
  hostDeviceId?: string;
  /** 并发上限：只统计经本组分到这台的任务。 */
  limit: number;
  weight: number;
  /** 暂停组内新任务分配；本机成员只暂停接收外部新任务，不影响本机自用或已有任务。 */
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
  /** 那台电脑上这个供应商的显示名；旧组或旧端未提供时省略。 */
  providerName?: string;
  /** 分享来的电脑：分享者昵称。 */
  ownerName?: string;
  /** Cindy 应用版本；缺失表示旧端或分享来源未提供，不是 remote-agent 协议版本。 */
  appVersion?: string;
  /** 仅描述接收分享任务的能力，不改变主人自己的可用状态。 */
  guestSupport?: ProviderGroupGuestSupport;
  state: ProviderGroupMemberState;
  reason?: ProviderGroupUnavailableReason;
  /** 经本组分到这台、正在运行的任务数。 */
  running: number;
  limit: number;
  weight: number;
  paused: boolean;
  /** 冷却到何时(unix ms)。 */
  coolingUntil?: number;
  /**
   * 另一台电脑上的组：组所在电脑那边看它能用，这台电脑却连不上(provider-groups.md §10)。只由这台电脑的主进程
   * 按自己的连接情况补上，不来自组所在电脑的回包。
   */
  unreachableHere?: boolean;
  /**
   * 分享来的电脑：这台的主人对本机分享出去的人逐人同意的结果(provider-sharing.md §4.3)。只在本机自己的组里、
   * 组所在的供应商分享给了别人时有；不经设备互联发给其他电脑。
   */
  reshare?: ProviderGroupReshareSummary;
}

/** 本机分享出去的一个人：分享来的那台电脑的主人是否同意他经组使用那台。 */
export interface ProviderGroupReshareGuest {
  memberId: string;
  displayName: string;
  avatarUrl: string | null;
  /** unknown = 还没问到(那台离线或刚加入)。 */
  state: 'approved' | 'pending' | 'rejected' | 'unknown';
}

export interface ProviderGroupReshareSummary {
  /** needs-update = 那台的 Cindy 太旧，给不出同意；unknown = 还没问到。 */
  support: 'supported' | 'needs-update' | 'unknown';
  guests: ProviderGroupReshareGuest[];
}

export interface ProviderGroupView {
  providerId: string;
  /** null = 还没有组。 */
  config: ProviderGroupConfig | null;
  members: ProviderGroupMemberStatus[];
  /** 发送前按指定模型重新计算状态时由组所在电脑回显。 */
  model?: string;
}

export type ProviderGroupGuestSupport = 'supported' | 'needs-update' | 'unknown';

/** 设备目录中的应用版本只用于展示，拒绝异常长字符串和非版本文本。 */
export function readProviderGroupAppVersion(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 64 && /^[0-9]+[.][0-9]+[.][0-9]+(?:[-+][0-9A-Za-z.+-]+)?$/.test(value)
    ? value : undefined;
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
  /** 分享来的：分享者那台电脑的设备 id(同一台电脑的几个分享收在一起)。 */
  hostDeviceId?: string;
  blocked?: ProviderGroupCandidateBlock;
}

export type ProviderGroupLocalCommand =
  | { action: 'get'; providerId: string }
  | { action: 'candidates'; providerId: string }
  | { action: 'save'; providerId: string; config: ProviderGroupConfig }
  | { action: 'delete'; providerId: string }
  /** 设置页按编辑时的完整配置保存；null 表示当时尚未建组。独立动作让旧端明确拒绝。 */
  | { action: 'save-if-current'; providerId: string; config: ProviderGroupConfig; expectedConfig: ProviderGroupConfig | null }
  | { action: 'delete-if-current'; providerId: string; expectedConfig: ProviderGroupConfig | null }
  /** 同账号另一台电脑上这个供应商的组与组内电脑状态(只读)。 */
  | { action: 'remote-view'; providerId: string; deviceId: string }
  /** 本机全部组的设置(不读远端)。 */
  | { action: 'list' }
  /** 这个任务此刻归哪个组(模型列表把它显示在组那一项下)。 */
  | { action: 'session-group'; sessionId: string };

export type ProviderGroupCommand = ProviderGroupLocalCommand
  | { action: 'remote-manage'; deviceId: string; request: ProviderManagementRequest };

/**
 * 任务此刻归的组：`groupDeviceId` 为组所在电脑，null = 这台电脑自己建的组；`providerId` 是组那一项在组所在电脑上的
 * 供应商 id。没归组(或位置与绑定对不上)为 null。
 */
export type ProviderGroupSessionGroup = { groupDeviceId: string | null; providerId: string } | null;

export type ProviderGroupCommandResult<C extends ProviderGroupCommand> =
  C extends { action: 'remote-manage'; request: infer R extends ProviderManagementRequest } ? ProviderManagementResult<R>
  : C extends { action: 'list' } ? Record<string, ProviderGroupConfig>
  : C extends { action: 'get' } ? ProviderGroupView
    : C extends { action: 'candidates' } ? ProviderGroupCandidate[]
      : C extends { action: 'save' | 'save-if-current' } ? ProviderGroupView
        : C extends { action: 'delete' | 'delete-if-current' } ? ProviderGroupView
          : C extends { action: 'remote-view' } ? ProviderGroupView
            : C extends { action: 'session-group' } ? ProviderGroupSessionGroup
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
  const providerName = normalizeLabel(value.providerName);
  const hostDeviceId = kind === 'share' ? normalizeShareHostDeviceId(value.hostDeviceId) : undefined;
  return {
    key: providerGroupMemberKey(agentDeviceId as string | null, providerId),
    kind,
    agentDeviceId: agentDeviceId as string | null,
    providerId,
    ...(label ? { label } : {}),
    ...(providerName ? { providerName } : {}),
    ...(hostDeviceId ? { hostDeviceId } : {}),
    limit: clampInt(value.limit, 1, PROVIDER_GROUP_MAX_LIMIT, PROVIDER_GROUP_DEFAULT_LIMIT),
    weight: clampInt(value.weight, 1, PROVIDER_GROUP_MAX_WEIGHT, PROVIDER_GROUP_DEFAULT_WEIGHT),
    paused: value.paused === true,
  };
}

function normalizeShareHostDeviceId(value: unknown): string | undefined {
  // Provider-share host IDs use the shared-task device domain: any non-empty
  // string up to 128 UTF-16 code units. They are opaque and never used as a
  // connection address here, so do not apply the narrower local-device regex.
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    ? value
    : undefined;
}

export type ProviderGroupPhysicalMember = Pick<ProviderGroupMember, 'kind' | 'agentDeviceId' | 'hostDeviceId'>;

/**
 * 供应商组展示与计数用的物理电脑键；账号仍由 member.key 独立区分。分享来的按分享者那台电脑：同一个人从同一台电脑
 * 分享的几个账号算一台；还不知道那台电脑时(旧组尚未对账)按分享各算一台。分享者的电脑一定属于别的账号，不会与自己的电脑重合。
 */
export function providerGroupPhysicalDeviceKey(member: ProviderGroupPhysicalMember): string {
  if (member.kind === 'local') return PROVIDER_GROUP_LOCAL_MEMBER_KEY;
  if (member.kind === 'share' && member.hostDeviceId) return `share-host:${member.hostDeviceId}`;
  return `${member.kind}:${member.agentDeviceId ?? ''}`;
}

/** 组里实际的物理电脑数。同一台电脑上的多个供应商账号(含同一台分享来的几个)只算一台。 */
export function providerGroupDeviceCount(members: readonly ProviderGroupPhysicalMember[]): number {
  return new Set(members.map(providerGroupPhysicalDeviceKey)).size;
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

// ─── 同账号电脑之间(`maker:provider:list` 的 `group` 字段与 `provider-group:remote` 通道) ─────

/**
 * 组所在电脑的目录里随组所属供应商带出的组摘要：只给同账号电脑，受邀者与共享任务访客看不到。
 * 组员的坐标是组所在电脑视角(`local` = 组所在电脑自己)。并发上限与权重只在组所在电脑上生效，不外发。
 */
export interface ProviderGroupWireSummary {
  strategy: ProviderGroupStrategy;
  autoSwitch: boolean;
  members: Array<Pick<ProviderGroupMember,
    'key' | 'kind' | 'agentDeviceId' | 'providerId' | 'label' | 'providerName' | 'hostDeviceId' | 'paused'>>;
}

export function providerGroupSummaryForWire(config: ProviderGroupConfig): ProviderGroupWireSummary {
  return {
    strategy: config.strategy,
    autoSwitch: config.autoSwitch,
    members: config.members.map((m) => ({
      key: m.key,
      kind: m.kind,
      agentDeviceId: m.agentDeviceId,
      providerId: m.providerId,
      // 分享来的电脑不带名字：旧版本存的快照是分享者的电脑名(provider-sharing.md §6)，界面按分享者昵称显示。
      ...(m.label && m.kind !== 'share' ? { label: m.label } : {}),
      ...(m.providerName ? { providerName: m.providerName } : {}),
      // 同账号电脑据此把同一台分享来的几个账号算一台；组摘要不发给受邀者。
      ...(m.hostDeviceId ? { hostDeviceId: m.hostDeviceId } : {}),
      paused: m.paused,
    })),
  };
}

/** 读另一台电脑目录里的组摘要；格式不对返回 null(当作没有组)。 */
export function readProviderGroupSummary(raw: unknown, groupProviderId: string): ProviderGroupConfig | null {
  return normalizeProviderGroupConfig(raw, groupProviderId);
}

/** 换电脑的原因里，会让组所在电脑冷却那台的几种(连不上只由发现它的电脑自己避开，不替全组判断)。 */
export type ProviderGroupRemoteCoolCause = 'usage-limit' | 'auth' | 'overload';
const REMOTE_COOL_CAUSES: readonly ProviderGroupRemoteCoolCause[] = ['usage-limit', 'auth', 'overload'];

export interface ProviderGroupRemoteLease {
  sessionId: string;
  providerId: string;
  memberKey: string;
}

/**
 * 同账号电脑报告的一行用量：它经组所在电脑的组、在组里别的电脑上运行的部分(provider-groups.md §7)，
 * 供应商与组内电脑都是组所在电脑的坐标，按天、Agent、模型聚合。
 */
export interface ProviderGroupRemoteUsageRow {
  day: string;
  providerId: string;
  memberKey: string;
  kind: string;
  model: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  sdkCostUsd: number;
  /** 这一行最近一次记账的时间(unix ms)。 */
  lastAt: number;
}

/** 单次请求的行数上限；完整报告超过此值时用 usage-part 分批收齐后再替换。 */
export const PROVIDER_GROUP_REMOTE_MAX_USAGE_ROWS = 3_000;
/** 完整报告的上限，与按使用方账本的保留行数一致；不提高单帧上限。 */
export const PROVIDER_GROUP_REMOTE_MAX_USAGE_REPORT_ROWS = 20_000;

export interface ProviderGroupUsagePartAck {
  seq: number;
  received: number;
  committed: boolean;
}

export type ProviderGroupRemoteRequest =
  /** 新任务该用组里哪台；选中即给那台记一个短暂的占用，同时开的几个任务不会全落到同一台。 */
  | { action: 'pick'; sessionId: string; providerId: string; agentKind: 'claude-code' | 'codex' | 'pi'; model: string; exclude: string[] }
  /** 那台电脑出了问题(用量上限、登录失效、服务繁忙)：组所在电脑冷却它，不再分新任务。 */
  | { action: 'cool' | 'cool-model'; providerId: string; memberKey: string; cause: ProviderGroupRemoteCoolCause; resetAt?: number; model?: string }
  /** 这台电脑经组运行、正在跑的任务(整体替换上一份；seq 只增，乱序到达的旧份丢弃)。 */
  | { action: 'leases'; seq: number; entries: ProviderGroupRemoteLease[] }
  /** 组内电脑的状态(发送前检查、设置页展示)。 */
  | { action: 'view'; providerId: string; model?: string; includeGuestSupport?: true }
  /**
   * 这台电脑经组、在组里别的电脑上运行的用量(组所在电脑经手不到)：整体替换这台从 sinceDay 起(含；null = 全部)
   * 报过的行。seq 只增，乱序到达的旧份丢弃。
   */
  | { action: 'usage'; seq: number; sinceDay: string | null; rows: ProviderGroupRemoteUsageRow[] }
  /** 新动作防止旧端忽略分批字段后把半份报告当整份替换。offset 从 0 开始，收齐 total 才提交。 */
  | { action: 'usage-part'; seq: number; sinceDay: string | null; offset: number; total: number; rows: ProviderGroupRemoteUsageRow[] }
  /**
   * 只读：这台电脑上的某个任务此刻归哪个组(手机与远程控制的模型列表用，provider-groups.md §10)。
   * 发给任务所在的电脑，不是组所在电脑。
   */
  | { action: 'session-group'; sessionId: string };

/** `session-group` 的回包：坐标是任务所在电脑视角(`groupDeviceId` 为 null = 那台自己建的组)。 */
export interface ProviderGroupRemoteSessionGroup {
  group: ProviderGroupSessionGroup;
}

export type ProviderGroupRemotePick =
  /** 那个供应商现在没有组(组被删了或旧版本)：照常直接在组所在电脑上运行。 */
  | { kind: 'none' }
  | { kind: 'member'; member: Pick<ProviderGroupMember, 'key' | 'kind' | 'agentDeviceId' | 'providerId'>; label: string }
  | { kind: 'unavailable' };

/** 一次最多报告的运行中任务数(每台电脑的任务上限远低于此)。 */
export const PROVIDER_GROUP_REMOTE_MAX_LEASES = 512;
const REMOTE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const REMOTE_MEMBER_KEY = /^[A-Za-z0-9_.:-]{1,300}$/;
const REMOTE_AGENT_KINDS = new Set(['claude-code', 'codex', 'pi']);

function invalidRemote(message: string): never {
  throw new Error(`[INVALID_PARAMS] ${message}`);
}

function remoteRecord(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalidRemote('provider group request must be an object');
  return raw as Record<string, unknown>;
}

function remoteProviderId(value: unknown): string {
  if (!isProviderGroupProviderId(value)) invalidRemote('invalid provider id');
  return value;
}

function remoteMemberKey(value: unknown): string {
  if (typeof value !== 'string' || !REMOTE_MEMBER_KEY.test(value)) invalidRemote('invalid member key');
  return value;
}

function remoteSessionId(value: unknown): string {
  if (typeof value !== 'string' || !REMOTE_SESSION_ID.test(value)) invalidRemote('invalid session id');
  return value;
}

const REMOTE_DAY = /^\d{4}-\d{2}-\d{2}$/;
const USAGE_NUMBER_FIELDS = ['turns', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreateTokens', 'sdkCostUsd', 'lastAt'] as const;

/** 用量行按数组发送(省掉每行重复的字段名)：[day, providerId, memberKey, kind, model, ...USAGE_NUMBER_FIELDS]。 */
export function providerGroupUsageRowsForWire(rows: readonly ProviderGroupRemoteUsageRow[]): unknown[][] {
  return rows.map((row) => [
    row.day, row.providerId, row.memberKey, row.kind, row.model, ...USAGE_NUMBER_FIELDS.map((field) => row[field]),
  ]);
}

function remoteUsageRow(raw: unknown): ProviderGroupRemoteUsageRow {
  if (!Array.isArray(raw) || raw.length !== 5 + USAGE_NUMBER_FIELDS.length) invalidRemote('invalid usage row');
  const [day, providerId, memberKey, kind, model] = raw;
  if (typeof day !== 'string' || !REMOTE_DAY.test(day)) invalidRemote('invalid usage day');
  if (typeof kind !== 'string' || !REMOTE_AGENT_KINDS.has(kind)) invalidRemote('invalid agent');
  if (typeof model !== 'string' || model.length > 512) invalidRemote('invalid model');
  const row = { day, providerId: remoteProviderId(providerId), memberKey: remoteMemberKey(memberKey), kind, model } as ProviderGroupRemoteUsageRow;
  USAGE_NUMBER_FIELDS.forEach((field, index) => {
    const value = raw[5 + index];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalidRemote('invalid usage number');
    row[field] = value;
  });
  return row;
}

/** 组所在电脑解析同账号电脑发来的请求；不合法抛 `[INVALID_PARAMS]`。 */
export function parseProviderGroupRemoteRequest(raw: unknown): ProviderGroupRemoteRequest {
  const value = remoteRecord(raw);
  switch (value.action) {
    case 'pick': {
      const agentKind = value.agentKind;
      if (typeof agentKind !== 'string' || !REMOTE_AGENT_KINDS.has(agentKind)) invalidRemote('invalid agent');
      if (typeof value.model !== 'string' || !value.model || value.model.length > 512) invalidRemote('invalid model');
      const exclude = value.exclude === undefined ? [] : value.exclude;
      if (!Array.isArray(exclude) || exclude.length > PROVIDER_GROUP_STORAGE_MEMBER_CAP) invalidRemote('invalid exclude');
      return {
        action: 'pick',
        sessionId: remoteSessionId(value.sessionId),
        providerId: remoteProviderId(value.providerId),
        agentKind: agentKind as 'claude-code' | 'codex' | 'pi',
        model: value.model,
        exclude: exclude.map(remoteMemberKey),
      };
    }
    case 'cool':
    case 'cool-model': {
      if (value.model !== undefined && (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 512)) invalidRemote('invalid model');
      if (value.action === 'cool-model' && (typeof value.model !== 'string' || value.cause !== 'usage-limit')) invalidRemote('invalid model cooldown');
      const cause = value.cause;
      if (!REMOTE_COOL_CAUSES.includes(cause as ProviderGroupRemoteCoolCause)) invalidRemote('invalid cause');
      const resetAt = typeof value.resetAt === 'number' && Number.isFinite(value.resetAt) && value.resetAt > 0
        ? value.resetAt
        : undefined;
      return {
        action: value.action,
        providerId: remoteProviderId(value.providerId),
        memberKey: remoteMemberKey(value.memberKey),
        cause: cause as ProviderGroupRemoteCoolCause,
        ...(typeof value.model === 'string' ? { model: value.model } : {}),
        ...(resetAt !== undefined ? { resetAt } : {}),
      };
    }
    case 'leases': {
      if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 0) invalidRemote('invalid seq');
      if (!Array.isArray(value.entries) || value.entries.length > PROVIDER_GROUP_REMOTE_MAX_LEASES) invalidRemote('invalid leases');
      return {
        action: 'leases',
        seq: value.seq as number,
        entries: value.entries.map((entry) => {
          const lease = remoteRecord(entry);
          return {
            sessionId: remoteSessionId(lease.sessionId),
            providerId: remoteProviderId(lease.providerId),
            memberKey: remoteMemberKey(lease.memberKey),
          };
        }),
      };
    }
    case 'view': {
      if (value.model !== undefined && (typeof value.model !== 'string' || !value.model || value.model.length > 512)) {
        invalidRemote('invalid model');
      }
      return {
        action: 'view',
        providerId: remoteProviderId(value.providerId),
        ...(value.model !== undefined ? { model: value.model } : {}),
        ...(value.includeGuestSupport === true ? { includeGuestSupport: true } : {}),
      };
    }
    case 'usage':
    case 'usage-part': {
      if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 0) invalidRemote('invalid seq');
      const sinceDay = value.sinceDay ?? null;
      if (sinceDay !== null && (typeof sinceDay !== 'string' || !REMOTE_DAY.test(sinceDay))) invalidRemote('invalid since day');
      if (!Array.isArray(value.rows) || value.rows.length > PROVIDER_GROUP_REMOTE_MAX_USAGE_ROWS) invalidRemote('invalid usage rows');
      const report = { seq: value.seq as number, sinceDay: sinceDay as string | null, rows: value.rows.map(remoteUsageRow) };
      if (value.action === 'usage') return { action: 'usage', ...report };
      if (!Number.isSafeInteger(value.total) || (value.total as number) < 1
        || (value.total as number) > PROVIDER_GROUP_REMOTE_MAX_USAGE_REPORT_ROWS) invalidRemote('invalid usage total');
      if (!Number.isSafeInteger(value.offset) || (value.offset as number) < 0
        || report.rows.length === 0 || (value.offset as number) + report.rows.length > (value.total as number)) invalidRemote('invalid usage offset');
      return { action: 'usage-part', ...report, offset: value.offset as number, total: value.total as number };
    }
    case 'session-group':
      return { action: 'session-group', sessionId: remoteSessionId(value.sessionId) };
    default:
      invalidRemote('unknown provider group action');
  }
}

/** 同账号电脑读组所在电脑 `pick` 的回包；格式不对按「没有组」处理。 */
export function parseProviderGroupRemotePick(raw: unknown, groupProviderId: string): ProviderGroupRemotePick {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'none' };
  const value = raw as Record<string, unknown>;
  if (value.kind === 'unavailable') return { kind: 'unavailable' };
  if (value.kind !== 'member') return { kind: 'none' };
  const member = normalizeMember(value.member, groupProviderId);
  if (!member) return { kind: 'none' };
  const label = normalizeLabel(value.label) ?? member.label ?? member.key;
  return {
    kind: 'member',
    member: { key: member.key, kind: member.kind, agentDeviceId: member.agentDeviceId, providerId: member.providerId },
    label,
  };
}

/** 读任务所在电脑 `session-group` 的回包；格式不对按没归组处理。坐标仍是那台电脑视角。 */
export function parseProviderGroupRemoteSessionGroup(raw: unknown): ProviderGroupSessionGroup {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const group = (raw as Record<string, unknown>).group;
  if (!group || typeof group !== 'object' || Array.isArray(group)) return null;
  const value = group as Record<string, unknown>;
  const groupDeviceId = value.groupDeviceId ?? null;
  if (groupDeviceId !== null && (
    typeof groupDeviceId !== 'string'
    || !DEVICE_ID_PATTERN.test(groupDeviceId)
    || isProviderShareAgentDeviceId(groupDeviceId)
  )) return null;
  if (!isProviderGroupProviderId(value.providerId)) return null;
  return { groupDeviceId, providerId: value.providerId };
}

const MEMBER_STATES: readonly ProviderGroupMemberState[] = ['available', 'full', 'paused', 'cooling', 'offline', 'unavailable'];
const UNAVAILABLE_REASONS: readonly ProviderGroupUnavailableReason[] = ['provider-off', 'disconnected', 'share-paused', 'share-removed'];

/** 同账号电脑读组所在电脑 `view` 的回包(设置页只读展示、发送前检查)；坏条目丢弃。 */
export function parseProviderGroupRemoteView(raw: unknown, groupProviderId: string): ProviderGroupView {
  const empty: ProviderGroupView = { providerId: groupProviderId, config: null, members: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  const value = raw as Record<string, unknown>;
  const model = typeof value.model === 'string' && value.model.length > 0 && value.model.length <= 512
    ? value.model
    : undefined;
  const config = normalizeProviderGroupConfig(value.config, groupProviderId);
  if (!config) return empty;
  const keys = new Set(config.members.map((m) => m.key));
  const count = (v: unknown, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(0, Math.round(v))) : 0;
  const members = (Array.isArray(value.members) ? value.members : []).flatMap((entry): ProviderGroupMemberStatus[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    const key = typeof item.key === 'string' && keys.has(item.key) ? item.key : null;
    const state = MEMBER_STATES.includes(item.state as ProviderGroupMemberState) ? item.state as ProviderGroupMemberState : null;
    const member = key ? config.members.find((m) => m.key === key)! : null;
    if (!member || !state) return [];
    const reason = UNAVAILABLE_REASONS.includes(item.reason as ProviderGroupUnavailableReason)
      ? item.reason as ProviderGroupUnavailableReason
      : undefined;
    const ownerName = normalizeLabel(item.ownerName);
    // 旧组所在电脑不回账号名：用组设置里的快照，都没有时界面按第几个账号称呼。
    const providerName = normalizeLabel(item.providerName) ?? member.providerName;
    const appVersion = readProviderGroupAppVersion(item.appVersion);
    const guestSupport = ['supported', 'needs-update', 'unknown'].includes(item.guestSupport as string)
      ? item.guestSupport as ProviderGroupGuestSupport : undefined;
    const coolingUntil = typeof item.coolingUntil === 'number' && Number.isFinite(item.coolingUntil) ? item.coolingUntil : undefined;
    return [{
      key: member.key,
      kind: member.kind,
      label: normalizeLabel(item.label) ?? member.label ?? member.key,
      ...(providerName ? { providerName } : {}),
      ...(ownerName ? { ownerName } : {}),
      ...(appVersion ? { appVersion } : {}),
      ...(guestSupport ? { guestSupport } : {}),
      state,
      ...(reason ? { reason } : {}),
      running: count(item.running, 10_000),
      limit: member.limit,
      weight: member.weight,
      paused: member.paused,
      ...(coolingUntil !== undefined ? { coolingUntil } : {}),
    }];
  });
  return { providerId: groupProviderId, config, members, ...(model ? { model } : {}) };
}
