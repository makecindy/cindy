/**
 * 供应商组接到任务生命周期上的三个点(docs/product-rules/provider-groups.md §6)：
 *
 * 1. **分配**：新任务第一次启动 Agent 前(bootstrapSession)，按组策略选电脑(本机任务与其他使用方同一套)，把选择写回
 *    任务记录与绑定；Agent 还没开始运行就失败(连不上、登录失效、启动失败)时直接换下一台。
 * 2. **自动换电脑**：运行中因那台电脑的原因失败(终态错误)时，交接到组里下一台并继续这一轮；
 *    同一轮每台最多试一次，全部失败才交回原有的报错 / 等额度重置流程。那台是连不上(离线、断线)时先等它
 *    恢复：按退避最多重试 5 次，恢复了就留在原电脑继续，都不行再换。别的电脑上的组读不到(常见是任务就在组所在
 *    电脑上、它自己断了)时换不了电脑，只等任务所在那台恢复。
 * 3. **发送前**：已归组的任务所在那台现在不能用时，先交接到下一台，这条消息直接发到新电脑；离线时同样先等。
 *    用户自己发消息时，同账号换号优先自动恢复原生历史，实际需要摘要才确认；共享来源沿用确认或已记住的选择
 *    (2026-10-28 用户裁决，电脑与手机共用)。
 *
 * 没归过组、但正用着组那一项的老任务(建组前就在用，或运行过之后才换到组那一项)在启动 Agent 前纳入组，
 * 不挪动它；当时没纳入的(一直开着、或启动时问不到组所在电脑)出错时再补上，然后照常换电脑。
 *
 * 组可以在本机，也可以在同账号的另一台电脑上(§4「同账号直连」)：任务选了另一台电脑的某个供应商、
 * 而那台把它建成了组时，选哪台由组所在电脑决定，这台电脑直接连到选中的那台运行；那台出问题时由
 * 这台电脑(任务所在、看得到错误、有对话记录)换电脑，并把需要冷却的电脑报告给组所在电脑。两种组共用
 * 下面同一套流程，差别只在「组来源」：选电脑、冷却、组员状态问谁，以及组员坐标怎么换成本机的位置。
 *
 * 依赖全部注入，由 maker-ipc/register 装配；这里不直接碰数据库、会话与输入协调器。
 */
import type { AgentKind } from '@cindy/maker-core';

import {
  USAGE_LIMIT_RESET_AUTO_RESUME_REASON,
  type AutoResumeInfo,
} from '../../shared/agentInputQueue.js';
import type {
  ProviderGroupConfig,
  ProviderGroupMember,
  ProviderGroupMemberQuota,
  ProviderGroupRebalanceSuggestion,
  ProviderGroupRemoteCoolCause,
  ProviderGroupRemotePick,
  ProviderGroupSessionGroup,
  ProviderGroupView,
  ProviderGroupUsageLimit,
} from '../../shared/providerGroup.js';
import { providerGroupMemberKey } from '../../shared/providerGroup.js';
import { isProviderShareAgentDeviceId } from '../../shared/providerShare.js';
import {
  interruptedTurnResumeDelayMs,
  type InterruptedTurnErrorSignals,
} from '../maker-ipc/interruptedTurnAutoResume.js';
import type { ProviderGroupBinding, ProviderGroupRef } from './bindings.js';
import type { ProviderGroupDirectory } from './directory.js';
import type { ProviderGroupGuestSwitch } from './guestSwitch.js';
import { providerGroupMemberUsageState, providerGroupRebalanceTarget } from './usage.js';
import {
  PROVIDER_GROUP_DEFAULT_COOLDOWN_MS,
  PROVIDER_GROUP_FAILURE_COOLDOWN_MS,
  PROVIDER_GROUP_TURN_WINDOW_MS,
  type ProviderGroupRouter,
} from './router.js';
import {
  decideProviderGroupFailure,
  describeProviderGroupFailure,
  providerGroupUnavailableError,
  providerGroupFailureSignals,
  type ProviderGroupFailureCause,
  type ProviderGroupFailureDecision,
  type ProviderGroupFailurePhase,
} from './failurePolicy.js';

export { PROVIDER_GROUP_SUPERSEDED_ERROR, PROVIDER_GROUP_UNAVAILABLE_ERROR } from './failurePolicy.js';

export interface ProviderGroupSessionRow {
  agentKind: AgentKind;
  model: string | null;
  providerId: string | null;
  agentDeviceId: string | null;
  remoteHostId: string | null;
  sdkSessionId: string | null;
}

export interface ProviderGroupRoute {
  /** null = 本机。 */
  agentDeviceId: string | null;
  providerId: string | null;
}

export interface ProviderGroupSwitchTargetResult extends ProviderGroupRoute {
  /**
   * 把本次挑选的组内电脑写进绑定；调用方必须等交接真正提交成功才调用——登记阶段的
   * 校验或交接失败绝不能让绑定抢先落地，否则下一次 verifyBinding 会把这次失败的
   * 选择当成已纳入组，悄悄开启自动换电脑(chatgpt-codex-connector P2, PR #5792 review)。
   */
  commitBinding(): Promise<void>;
}

export interface ProviderGroupStartContext {
  sessionId: string;
  groupProviderId: string;
  /** 组在另一台电脑上时为那台的设备 id；本机的组为 null。 */
  groupDeviceId: string | null;
  agentKind: AgentKind;
  model: string;
  member: ProviderGroupMember;
  route: ProviderGroupRoute;
  /**
   * 调用方要用 route 覆盖启动参数(含改回本机运行)。本机的组只在原本没有指定位置时才改；
   * 另一台电脑上的组总是覆盖：任务原本指向组所在电脑，选中的可能是任何一台。
   */
  overrideRoute: boolean;
  /** 任务原本的(本机)来源，换回本机时还原。 */
  localProviderId: string | null;
  /** 启动时问组所在电脑超时，尚未写入绑定；启动失败时再读组并纳入。 */
  pendingGroupAdoption?: boolean;
}

interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** 另一台电脑上的组(经设备互联问组所在电脑)。 */
export interface ProviderGroupRemoteGroups {
  /**
   * 组所在电脑目录里这个供应商的组：读到了返回组或 null(那台没有这个组 / 旧版本)，读不到(离线、
   * 连不上)返回 undefined——读不到时不能当作组已删除去解除绑定。
   */
  readGroup(ownerDeviceId: string, providerId: string): Promise<ProviderGroupConfig | null | undefined>;
  pick(ownerDeviceId: string, input: {
    sessionId: string;
    providerId: string;
    agentKind: 'claude-code' | 'codex' | 'pi';
    model: string;
    exclude: readonly string[];
    quotaRebalance?: string;
  }): Promise<ProviderGroupRemotePick>;
  cool(ownerDeviceId: string, input: {
    providerId: string;
    memberKey: string;
    cause: ProviderGroupRemoteCoolCause;
    resetAt: number | null;
    model?: string;
  }): Promise<void>;
  view(ownerDeviceId: string, providerId: string, model?: string, agentKind?: AgentKind): Promise<ProviderGroupView>;
  /** 忘掉组所在电脑目录的缓存(组员失败后下次现读)。 */
  invalidate(ownerDeviceId: string): void;
}

export interface ProviderGroupServiceDeps {
  router: ProviderGroupRouter;
  directory: ProviderGroupDirectory;
  readGroup(providerId: string): ProviderGroupConfig | null;
  /** 另一台电脑上的组；不提供 = 只处理本机的组。 */
  remote?: ProviderGroupRemoteGroups;
  /** 本机设备 id(另一台电脑的组里，本机自己可能也是一台组内电脑)。 */
  localDeviceId?(): string | null;
  readBinding(sessionId: string): ProviderGroupBinding | null;
  writeBinding(
    sessionId: string,
    binding: { providerId: string; memberKey: string; groupDeviceId?: string | null } | null,
  ): Promise<void>;
  /** 这个任务曾因组内电脑被移出或这个组被删除而解除过这个组的绑定(§9.4)：不再自动纳入这个组。 */
  isReleased(sessionId: string, group: ProviderGroupRef): boolean;
  /** 记下这个任务因组内电脑被移出或组被删除而解除了这个组的绑定。 */
  markReleased(sessionId: string, group: ProviderGroupRef): Promise<void>;
  readSessionRow(sessionId: string): Promise<ProviderGroupSessionRow | null>;
  /** 隐式来源(provider_id 为空)时本机实际会用的来源。 */
  resolveImplicitProvider(agentKind: AgentKind, model: string): Promise<string | null>;
  /** 把 Agent 运行位置写回任务记录。 */
  persistRoute(sessionId: string, route: ProviderGroupRoute): Promise<void>;
  /** 这个任务是否已经有过 Agent 的回复(用来判断它是不是从没运行过)。 */
  hasAssistantHistory(sessionId: string): Promise<boolean>;

  /**
   * 是否由本机制接管这次失败(排除目标模式、伙伴、共享中的任务等)。协同的 Lead 与 Worker 都可以换电脑：
   * Worker 换成了照常把这一轮的结果回报给 Lead，只是不做「等额度恢复后自动继续」(那仍交给 Lead)。
   */
  isFailoverEligible(sessionId: string): Promise<boolean>;
  /**
   * 用终态错误下发的令牌取得这次错误的重试入口；null = 用户已接手或错误已不是当前状态。
   * 交接会关闭旧会话并撤销限额等待，所以先拿句柄，交接后凭它重新挂上。
   */
  leaseRecovery(sessionId: string, token: number): object | null;
  /** 句柄对应的那次错误是否仍是当前状态(没有新 turn、用户没有接手)。 */
  isLeaseCurrent(sessionId: string, lease: object): boolean;
  /** 凭句柄重新挂上等待(resumeAt 为 null 只登记候选)，返回新令牌；用户已接手时返回 null。 */
  rearmContinue(sessionId: string, lease: object, resumeAt: number | null): number | null;
  cancelContinue(sessionId: string, token: number): void;
  /**
   * 把任务交接到另一台电脑(与「已建任务换 Agent 所在电脑」同一条路径)；没有真正换过去时抛错。
   * `isCurrent` 在拿到发送锁之后、改动之前复核，返回 false 时抛 PROVIDER_GROUP_SUPERSEDED_ERROR。
   */
  switchAgentLocation(
    sessionId: string,
    route: { agentKind: AgentKind; model: string; providerId: string | null; agentDeviceId: string | null },
    /**
     * `relocate`：位置不变也重新交接、新建会话(分享的人换电脑，实际运行的电脑由组所在电脑重新选)。
     * `reason: 'quota-rebalance'`：用户确认为了先用那台的配额换过去，分隔条写明原因。
     */
    options?: { beforeSend?: boolean; isCurrent?: () => boolean; relocate?: boolean; reason?: 'quota-rebalance' },
  ): Promise<void>;
  /** 这个任务选过「以后自动换，不再询问」(provider-groups.md §6.2「任务进行中换号」)。不提供 = 都没选过。 */
  readAutoRebalance?(sessionId: string): boolean;
  /** 记下这个任务以后自动换号。 */
  writeAutoRebalance?(sessionId: string): Promise<void>;
  /**
   * 分享的人这边的「需要换一台」凭证(guestSwitch.ts)；不提供 = 分享来的供应商出错时一律交回原有处理。
   */
  guestSwitch?: Pick<ProviderGroupGuestSwitch, 'offer' | 'hasOffer' | 'claim' | 'release' | 'drop'>;
  /** A live G→M handle may ask O for a bounded switch token after a run failure. */
  directGuestSession?(sessionId: string): {
    ownerRoute: string;
    requestSwitch(): Promise<string | undefined>;
    probeReconnect?(isCurrent?: () => boolean): Promise<'ok' | 'offline' | 'unavailable'>;
  } | null;
  /** 这个任务现在是否正在运行一轮。 */
  isTurnRunning(sessionId: string): boolean;
  /**
   * 这个任务现在有没有开着、能直接发的会话；false = 这次发送要重新打开 Agent 所在电脑上的会话。
   * 不提供 = 不知道(发送前只看缓存的组内电脑状态)。
   */
  hasLiveSession?(sessionId: string): boolean;
  continueSession(
    sessionId: string,
    token: number,
    info: AutoResumeInfo,
  ): Promise<'resumed' | 'superseded' | 'no-progress'>;
  /** 不换电脑时交回原有处理(额度重置后自动继续等)。 */
  fallback(sessionId: string, signals: InterruptedTurnErrorSignals, token: number): void;
  /** 报错里的重置时刻(unix ms)。 */
  readResetAt(signals: InterruptedTurnErrorSignals): number | null;
  now(): number;
  /** 等原电脑恢复时两次重试之间的等待；不提供用定时器。 */
  sleep?(ms: number): Promise<void>;
  log: Logger;
}

export interface ProviderGroupService {
  /**
   * 新任务启动 Agent 前调用：需要分配时返回选中的位置(调用方据此改启动参数)，不归组管返回 null。
   * 组里没有能用的电脑时抛 PROVIDER_GROUP_UNAVAILABLE_ERROR。
   * `startRow`：任务记录还没写入时(新建的协同 Worker 由启动这一步落库)按启动参数当作从没运行过的任务分配；
   * 记录已存在时以记录为准。
   */
  assignBeforeStart(input: {
    sessionId: string;
    agentKind: AgentKind;
    model: string;
    startRow?: ProviderGroupSessionRow;
  }): Promise<ProviderGroupStartContext | null>;
  /** 分配后 Agent 没能启动：换下一台，返回新的位置；不该换或没有下一台返回 null(调用方照常报错)。 */
  nextAfterStartFailure(context: ProviderGroupStartContext, error: unknown): Promise<ProviderGroupStartContext | null>;
  /**
   * 用户在模型选择里把任务换到组那一项、要换电脑(§6，2026-10-11 用户反馈)：交接反正要做，按组此刻的状态选一台能用的
   * 电脑(与新任务同一套组策略)，写好绑定，返回那台的位置。`target` 是用户选的位置：不是组那一项(没有组、分享来的供应商)
   * 或组读不到时返回 null，照用户选的位置换；组里都不能用时抛 PROVIDER_GROUP_UNAVAILABLE_ERROR。选中的就是任务此刻所在
   * 那台电脑、但供应商不同时也返回 null(同一台电脑上换供应商不走这条路)。
   */
  resolveSwitchTarget(
    sessionId: string,
    target: {
      agentKind: AgentKind;
      model: string;
      providerId: string | null;
      agentDeviceId: string | null;
      current: ProviderGroupRoute;
    },
  ): Promise<ProviderGroupSwitchTargetResult | null>;
  /**
   * 纯判定(同步、无副作用)：这次终态错误会不会先由本机制试着换电脑。为 true 时输入协调器先不呈现这次错误
   * (红横幅与错误卡)：换成了就不出现，没换成再补出来(§6.1)。只看手上现成的：认得出的原因，加上已归组
   * (本机的组要开着自动换电脑、组里还有别的电脑；另一台电脑上的组交给随后的异步判断)，或组所在电脑已发来
   * 「需要换一台」的凭证。出错时才纳入组的老任务这里认不出，照旧先报错再换。
   */
  mayHandleTurnError(sessionId: string, signals: InterruptedTurnErrorSignals): boolean;
  /** 运行中的终态错误(输入协调器保留了重试入口)。整个处理(换电脑、续跑或交回原有处理)结束时兑现。 */
  onTurnError(
    sessionId: string,
    signals: InterruptedTurnErrorSignals,
    token: number,
    hooks?: ProviderGroupTurnErrorHooks,
  ): Promise<void>;
  /**
   * 发送前：已归组的任务所在那台现在不能用(离线、分享暂停、供应商关掉、冷却中)时，先交接到组里下一台，
   * 这条消息直接发到新电脑。离线时先等它恢复(与运行中失败同一套重试)，恢复了照常发到原电脑。
   * 读不到状态或没有下一台时不动，照常发送。
   */
  beforeSend(sessionId: string, options?: ProviderGroupBeforeSendOptions): Promise<void>;
  /**
   * 分享的人这边：续接一个经分享者的组运行过的任务时 Agent 没能启动，组所在电脑随启动失败发来了「需要换一台」凭证
   * (§6.1)：取走凭证、登记给下一次打开，返回 true，调用方带交接后在同一个分享位置重新打开，由组换一台。
   */
  claimGuestStartSwitch(sessionId: string): boolean;
  /** 用户亲自接手：这一轮重新从头试。 */
  noteUserAction(sessionId: string): void;
  /**
   * 任务此刻归哪个组(模型列表据此把它显示在组那一项下，provider-groups.md §10)：有绑定、且任务记录里的
   * 位置就是绑定的那台时返回组；没归组、位置与绑定对不上(挪到了别处，等下次核对)时返回 null。只读本机记录，
   * 不问组所在电脑。
   */
  sessionGroup(sessionId: string): Promise<ProviderGroupSessionGroup>;
  /**
   * 用户自己发下一条消息前(电脑与手机的发送按钮)：任务所在那台能用、组里另一台的配额明显更该先用时返回提议
   * (provider-groups.md §6.2「任务进行中换号」)。这个任务选过「以后自动换」时 `kind` 为 `auto`，客户端不再弹窗、直接确认。
   * 正在回复、没归组、读不到配额时返回 null。只读，不记占用。
   */
  rebalanceSuggestion(sessionId: string): Promise<ProviderGroupRebalanceSuggestion>;
  /**
   * 用户确认换号：这个任务接下来的一次发送(PROVIDER_GROUP_REBALANCE_ACCEPT_TTL_MS 内)先换到 `memberKey` 再发；
   * `remember` = 以后自动换。`memberKey` 不在组里返回 false。
   */
  rebalanceDecision(sessionId: string, memberKey: string, remember: boolean, clientId?: string): Promise<boolean>;
}

export interface ProviderGroupBeforeSendOptions {
  /** 用户确认换号的具体消息；复用发送协议已有的幂等 ID。 */
  clientId?: string;
  /** 这次发送被停止或取消：等原电脑恢复时就此停下，不再换电脑。 */
  signal?: AbortSignal;
  /** 定时任务的发送：不使用用户为下一条消息确认的换号。 */
  scheduled?: boolean;
  /** 等原电脑恢复的进度(第几次重试)；`switching` = 没等到，开始换电脑。 */
  progress?(state: { attempt: number; maxAttempts: number } | 'switching'): void;
}

/** 一次终态错误的处理结局(调用方据此结算换电脑期间先不呈现的那次错误)。 */
export interface ProviderGroupTurnErrorHooks {
  /** Async checks declined ownership before switching; true transfers back to interrupted-turn recovery. */
  notHandled?(): boolean;
  /** 不换了，马上交回原有处理(报错与额度重置后自动继续)：先把错误放出来。 */
  beforeFallback?(): void;
  /** 已换到另一台电脑(或原电脑恢复后在原电脑)续上了这一轮。 */
  resumed?(): void;
  /** 原电脑连不上，先等它恢复：开始第 attempt 次重试(从 1 起)。 */
  reconnecting?(attempt: number, maxAttempts: number): void;
  /** 等过原电脑但没等到，开始换电脑。 */
  switching?(): void;
  /** 马上要把续跑交出去(之后不再有「久久没有结局」)：调用方停掉兜底计时，续跑途中不会再把错误放出来。 */
  continuing?(): void;
}

/** 发送前检查组内电脑状态的上限：读不到就照常发送，不让一台卡住的电脑拖慢每次发送。 */
export const PROVIDER_GROUP_BEFORE_SEND_TIMEOUT_MS = 3_000;

/** 用户确认的换号只用于接下来这么久内的一次发送：确认后没发出去(停止、断线)的不留到以后。 */
export const PROVIDER_GROUP_REBALANCE_ACCEPT_TTL_MS = 2 * 60_000;

/** 换号没换成的那台，这么久内不再提议(看着能用却接不了任务时，不每条消息都打扰一次)。 */
export const PROVIDER_GROUP_REBALANCE_BACKOFF_MS = 30 * 60_000;

/**
 * 那台连不上时，换电脑前先等它恢复：同一轮每台最多重试几次。两次之间的等待与中断自愈相同
 * (约 3、6、12、20、20 秒，合计约一分钟)。
 */
export const PROVIDER_GROUP_RECONNECT_MAX_ATTEMPTS = 5;

/** 现读那台状态的上限：读不到按连不上算。 */
export const PROVIDER_GROUP_PROBE_TIMEOUT_MS = 10_000;

/** 纳入老任务时问组所在电脑的上限：读不到就照常启动 / 交回原有处理，出错时再补。 */
export const PROVIDER_GROUP_ADOPT_TIMEOUT_MS = 3_000;

/**
 * 那台离线超过多久算「已经确认用不了」：不再等它恢复，直接换电脑(2026-10-11 用户确认：确认用不了的直接换、
 * 组里都不能用就直接提示，只有刚断开的才先等)。比等它恢复的总时长(约一分钟)长一些。
 */
export const PROVIDER_GROUP_RECENT_DROP_MS = 2 * 60_000;

/**
 * 发送前换不过去的电脑，留给这条消息随后的失败多久：消息发到原电脑后通常几秒内就失败(如撞用量上限)，
 * 那次换电脑不再重复去试、重复去等；超过这个时间再失败时那台可能已恢复，照常再试。
 */
export const PROVIDER_GROUP_PRE_SEND_FAILED_TTL_MS = 2 * 60_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : '';
}

/**
 * 等 `promise` 最多 `ms`：超时或失败返回 undefined(= 读不到)。不能用 null：组设置读到了「没有这个组」就是 null，
 * 组所在电脑慢一点不能被当成组已删除、把任务移出组。
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.catch(() => undefined),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

type SourcePick =
  | { kind: 'none' }
  | { kind: 'unavailable'; usageLimit?: ProviderGroupUsageLimit }
  | { kind: 'member'; member: ProviderGroupMember; label: string; labelOf(memberKey: string): string | undefined };

/** 任务进行中换号的目标：哪台、提示里怎么称呼、它此刻的配额窗口。 */
interface RebalanceTarget {
  memberKey: string;
  label: string;
  quota: ProviderGroupMemberQuota;
}

/** 同一台电脑上有几个账号时，提示里带上账号名。 */
function rebalanceLabel(config: ProviderGroupConfig, memberKey: string, label: string, account: string | undefined): string {
  const member = config.members.find((m) => m.key === memberKey);
  const shared = member ? config.members.filter((m) => m.kind === member.kind && m.agentDeviceId === member.agentDeviceId).length > 1 : false;
  return shared && account ? `${label} · ${account}` : label;
}

/** 组来源：本机的组，或同账号另一台电脑上的组。 */
interface GroupSource {
  /** null = 本机的组。 */
  ownerDeviceId: string | null;
  /** 组设置；undefined = 现在读不到(不能据此解除绑定)。 */
  readGroup(providerId: string): Promise<ProviderGroupConfig | null | undefined>;
  pick(input: {
    sessionId: string;
    providerId: string;
    config: ProviderGroupConfig;
    agentKind: AgentKind;
    model: string;
    exclude: ReadonlySet<string>;
    quotaRebalance?: string;
  }): Promise<SourcePick>;
  /** 记进组的状态(只在判定说要记时调用：那台账号的问题)。 */
  cool(providerId: string, memberKey: string, cause: ProviderGroupFailureCause, resetAt: number | null, model: string): void;
  /** 组的状态里这台现在冷却中(组所在电脑记着它账号的问题)。 */
  isKnownDown(providerId: string, memberKey: string, model?: string, agentKind?: AgentKind): Promise<boolean>;
  /** 发送前：这台现在该不该换掉；null = 读不到，照常发送。 */
  shouldMoveAway(providerId: string, config: ProviderGroupConfig, memberKey: string, model: string, agentKind: AgentKind): Promise<{ reason: string } | false | null>;
  /**
   * 任务进行中换号(provider-groups.md §6.2)：这台能用时，组里明显更该先用的那台(usage.ts providerGroupRebalanceTarget)；
   * 这台本身有问题(交给出问题换电脑)、不值得换或读不到时返回 null。只读。
   */
  rebalanceTarget(
    providerId: string,
    config: ProviderGroupConfig,
    memberKey: string,
    model: string,
    agentKind: AgentKind,
    exclude: ReadonlySet<string>,
  ): Promise<RebalanceTarget | null>;
  invalidate(member: ProviderGroupMember): void;
  /** 任务记录里 Agent 的位置对应组里哪一项(组所在电脑视角的键)；不对应任何组员返回 null。 */
  memberKeyOf(groupProviderId: string, row: ProviderGroupSessionRow): Promise<string | null>;
  /** 组员 → 本机启动参数里的位置。 */
  routeOf(member: ProviderGroupMember, localProviderId: string | null): ProviderGroupRoute;
}

/**
 * 一趟换电脑里因这台电脑连不上而跳过的组内电脑(§6.1)：组里只剩它们时挨个等它恢复再试。等回来的那台从这一轮
 * 试过的名单里放出来、可以再被选中；再换不过去就重新记下(等的次数按电脑计，不会无休止地来回试)。
 */
function createSkippedTargets() {
  const waiting: ProviderGroupMember[] = [];
  const retrying = new Set<string>();
  return {
    /** 选电脑时排除的：这一轮试过的，去掉等回来、可以再试的。 */
    exclusion(base: Set<string>): Set<string> {
      for (const key of retrying) base.delete(key);
      return base;
    },
    /** 换过去失败：连不上的记下，组里只剩它们时再等。 */
    failed(member: ProviderGroupMember, unreachable: boolean): void {
      retrying.delete(member.key);
      if (unreachable && !waiting.some((m) => m.key === member.key)) waiting.push(member);
    },
    /** 挨个等记下的电脑恢复(后跳过的先等)，等回来一台就返回 true。 */
    async awaitAny(
      awaitOne: (member: ProviderGroupMember) => Promise<boolean>,
      isCurrent: () => boolean,
    ): Promise<boolean> {
      for (let member = waiting.pop(); member && isCurrent(); member = waiting.pop()) {
        if (await awaitOne(member)) {
          retrying.add(member.key);
          return true;
        }
      }
      return false;
    },
  };
}

/**
 * 等原电脑恢复的结局：`reachable` 现读一次就连得上(不是连不上的问题，没等)；`back` 等过之后恢复了；
 * `gone` 那台本身不能用了(供应商关掉、登录失效、分享暂停等)或重试用完；`stopped` 等的途中用户接手。
 */
type ReturnOutcome = 'reachable' | 'back' | 'gone' | 'stopped';

export function createProviderGroupService(deps: ProviderGroupServiceDeps): ProviderGroupService {
  const { router } = deps;
  /** 进行中的自动换电脑：用户亲自接手(发消息、重试、换模型)时标记作废。只在换电脑期间登记。 */
  const runningSwitches = new Map<string, Set<{ superseded: boolean }>>();
  /**
   * 这一轮等过每台电脑几次(原电脑与要换过去的那台各算)：运行中失败与发送前共用一份，那台反复掉线也不会无休止地
   * 等下去。用户接手即重新计；距上一次重试超过一轮的时限(30 分钟)也重新计。
   */
  const reconnects = new Map<string, Map<string, { used: number; at: number }>>();
  /**
   * 发送前换不过去的电脑(目标电脑本身的问题)：这条消息随后在原电脑上失败时，那次换电脑直接跳过它们。单独记，
   * 不放在这一轮试过的名单里——用户亲自发的消息被接受时会重开一轮(noteUserAction)，那份名单随之清空。
   */
  const preSendFailed = new Map<string, { keys: string[]; at: number }>();
  /** 用户为这个任务接下来的一次发送确认的换号(provider-groups.md §6.2「任务进行中换号」)。 */
  const acceptedRebalance = new Map<string, Map<string, { memberKey: string; at: number }>>();
  function pruneAcceptedRebalance(): void {
    for (const [sessionId, messages] of acceptedRebalance) {
      for (const [clientId, decision] of messages) {
        if (deps.now() - decision.at > PROVIDER_GROUP_REBALANCE_ACCEPT_TTL_MS) messages.delete(clientId);
      }
      if (!messages.size) acceptedRebalance.delete(sessionId);
    }
  }
  /** 换号没换成的组内电脑(按组区分) → 到这个时刻之前不再提议。 */
  const rebalanceBackoff = new Map<string, number>();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  /** 等 `promise`，但发送被停止时立刻返回 undefined(不再干等退避或一次慢的现读)。 */
  function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | undefined> {
    if (!signal) return promise;
    if (signal.aborted) return Promise.resolve(undefined);
    return new Promise<T | undefined>((resolve, reject) => {
      const onAbort = () => resolve(undefined);
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  /** 记一次等那台电脑的重试，返回这是第几次；这一轮已用完返回 null。 */
  function nextReconnectAttempt(sessionId: string, memberKey: string): number | null {
    const now = deps.now();
    const perMember = reconnects.get(sessionId) ?? new Map<string, { used: number; at: number }>();
    const previous = perMember.get(memberKey);
    const used = previous && now - previous.at <= PROVIDER_GROUP_TURN_WINDOW_MS ? previous.used : 0;
    if (used >= PROVIDER_GROUP_RECONNECT_MAX_ATTEMPTS) return null;
    perMember.set(memberKey, { used: used + 1, at: now });
    reconnects.set(sessionId, perMember);
    return used + 1;
  }

  /**
   * 那台连不上(离线、断线)时先等它恢复，不急着换电脑(§6.1)：现读一次，确实连不上才等；按退避最多重试 5 次，
   * 每次现读那台的状态。本机这台没有「连不上」，直接 `gone`。`onAttempt` 在每次重试开始等之前调用。
   */
  async function awaitReturn(
    sessionId: string,
    route: ProviderGroupRoute,
    memberKey: string,
    isCurrent: () => boolean,
    onAttempt?: (attempt: number) => void,
    options?: {
      /** 调用方刚现读过、确认连不上，不再读第一次。 */
      knownOffline?: boolean;
      probe?: () => Promise<'ok' | 'offline' | 'unavailable'>;
      /**
       * 这次失败只是连接断了：现读第一次就已连得上，也算一次重试、留在原电脑继续(断线刚好已恢复)，
       * 不当成「问题不在连接」直接换。次数照算，那台反复断也只这 5 次。
       */
      connectionLost?: boolean;
      /** 发送被停止：退避与现读都立刻停下。 */
      signal?: AbortSignal;
      /** 已经确认这台用不了(组的状态里冷却中、离线已久)：不等，直接 `gone`。只在确实连不上、要开始等时问。 */
      knownDown?: () => Promise<boolean>;
    },
  ): Promise<ReturnOutcome> {
    const { agentDeviceId, providerId } = route;
    if (!agentDeviceId || !providerId) return 'gone';
    const signal = options?.signal;
    const current = () => isCurrent() && signal?.aborted !== true;
    const probe = async () =>
      (await untilAborted(
        withTimeout(options?.probe ? options.probe() : deps.directory.probe(agentDeviceId, providerId), PROVIDER_GROUP_PROBE_TIMEOUT_MS),
        signal,
      )) ?? 'offline';
    if (!options?.knownOffline) {
      const first = await probe();
      if (!current()) return 'stopped';
      if (first === 'unavailable') return 'gone';
      if (first === 'ok') {
        if (!options?.connectionLost) return 'reachable';
        const attempt = nextReconnectAttempt(sessionId, memberKey);
        if (attempt === null) return 'gone';
        onAttempt?.(attempt);
        deps.log.info('provider group: the connection is already back', { sessionId, member: memberKey, attempt });
        return 'back';
      }
    }
    if (options?.knownDown) {
      const down = await untilAborted(options.knownDown(), signal);
      if (!current()) return 'stopped';
      if (down) {
        deps.log.info('provider group: the computer is already known to be down; not waiting', { sessionId, member: memberKey });
        return 'gone';
      }
    }
    for (;;) {
      if (!current()) return 'stopped';
      const attempt = nextReconnectAttempt(sessionId, memberKey);
      if (attempt === null) {
        deps.log.info('provider group: the computer did not come back; switching', { sessionId, member: memberKey });
        return 'gone';
      }
      onAttempt?.(attempt);
      await untilAborted(sleep(interruptedTurnResumeDelayMs(attempt)), signal);
      if (!current()) return 'stopped';
      const state = await probe();
      if (!current()) return 'stopped';
      if (state === 'ok') {
        deps.log.info('provider group: the computer came back', { sessionId, member: memberKey, attempt });
        return 'back';
      }
      if (state === 'unavailable') return 'gone';
    }
  }

  /**
   * 要换过去的那台从这台电脑连不上(断线、不响应；组所在电脑那边看它可能是正常的)：组里还有别的电脑时先换别的，
   * 只剩它时不急着报错，先等它恢复再试(§6.1)。刚换过去失败，当作已知连不上：先按退避等一会儿再现读，与等原电脑
   * 同一套退避，次数按电脑计，那台「看着连得上却换不过去」时最多也只试这几次。返回 true = 它回来了，可以再试。
   */
  async function awaitSkippedTarget(
    sessionId: string,
    source: GroupSource,
    member: ProviderGroupMember,
    localProviderId: string | null,
    isCurrent: () => boolean,
    onAttempt: () => void,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const route = source.routeOf(member, localProviderId);
    const outcome = await awaitReturn(sessionId, route, member.key, isCurrent, onAttempt, {
      knownOffline: true,
      ...(signal ? { signal } : {}),
    });
    return outcome === 'back';
  }

  /**
   * 换过去失败只是因为这台电脑连不上那台(那台本身可能没问题)：值得等它恢复。只认「只是连接断了」——「可能连不上」的
   * 那几个错误码也用来包装对方的各种拒绝(如 Agent 没能启动)，等下去只会对同一台反复交接。
   */
  function isUnreachableTarget(decision: ProviderGroupFailureDecision): boolean {
    return decision.action === 'switch' && decision.connection === 'lost';
  }

  /**
   * 已经确认这台用不了，不用等它恢复(2026-10-11 用户确认：确认用不了的直接换，只有刚断开的才先等)：组的状态里它
   * 冷却中(组所在电脑记着它账号的问题)，或同账号那台离线已经超过 PROVIDER_GROUP_RECENT_DROP_MS。读不到的按不知道，
   * 照旧先等。组读不到时 `source` 为 null，只看离线多久。
   */
  async function knownDown(
    source: GroupSource | null,
    providerId: string,
    memberKey: string,
    route: ProviderGroupRoute,
    model?: string,
    agentKind?: AgentKind,
  ): Promise<boolean> {
    if (source && (await withTimeout(source.isKnownDown(providerId, memberKey, model, agentKind), PROVIDER_GROUP_BEFORE_SEND_TIMEOUT_MS))) {
      return true;
    }
    if (!route.agentDeviceId || !deps.directory.offlineForMs) return false;
    const offlineFor = await withTimeout(deps.directory.offlineForMs(route.agentDeviceId), PROVIDER_GROUP_BEFORE_SEND_TIMEOUT_MS);
    return typeof offlineFor === 'number' && offlineFor >= PROVIDER_GROUP_RECENT_DROP_MS;
  }

  /**
   * 运行过的任务这次打开能不能在启动阶段换到组里下一台：要重新打开(没有开着的会话)。有原生会话要续接时，调用方
   * 换过去前先做交接(register 的启动重试：全量交接 + 全新原生会话)，不拿原来那台的会话 id 去别处打开。
   */
  function mayReopenElsewhere(sessionId: string): boolean {
    return deps.hasLiveSession?.(sessionId) === false;
  }

  /** 这一轮结束(放弃换电脑、用户接手)：下一轮重新从头试、重新等。 */
  function resetRound(sessionId: string): void {
    router.resetTurn(sessionId);
    reconnects.delete(sessionId);
  }

  /** 登记一段进行中的自动处理：用户亲自接手(发消息、重试、换模型)时 `superseded` 被置为 true。 */
  function trackRun(sessionId: string): { run: { superseded: boolean }; done(): void } {
    const run = { superseded: false };
    const runs = runningSwitches.get(sessionId) ?? new Set();
    runs.add(run);
    runningSwitches.set(sessionId, runs);
    return {
      run,
      done() {
        runs.delete(run);
        if (runs.size === 0 && runningSwitches.get(sessionId) === runs) runningSwitches.delete(sessionId);
      },
    };
  }

  function coolUntil(cause: ProviderGroupFailureCause, resetAt: number | null): number {
    const now = deps.now();
    return cause === 'usage-limit'
      ? (resetAt !== null && resetAt > now ? resetAt : now + PROVIDER_GROUP_DEFAULT_COOLDOWN_MS)
      : now + PROVIDER_GROUP_FAILURE_COOLDOWN_MS;
  }

  /** 只有那台账号的问题记进组的状态(failurePolicy 的 `cool`)；调用方已按判定过滤，这里再挡一次。 */
  function isAccountCause(cause: ProviderGroupFailureCause): cause is ProviderGroupRemoteCoolCause {
    return cause === 'usage-limit' || cause === 'auth' || cause === 'overload';
  }

  /** 判定 + 决定日志(只带错误码与结构化字段，不带错误原文)。 */
  function decide(
    sessionId: string,
    signals: InterruptedTurnErrorSignals,
    phase: ProviderGroupFailurePhase,
    member?: string,
  ): ProviderGroupFailureDecision {
    const decision = decideProviderGroupFailure(signals, phase);
    deps.log.info('provider group: failure decision', {
      sessionId,
      phase,
      ...(member ? { member } : {}),
      ...describeProviderGroupFailure(signals, decision),
    });
    return decision;
  }

  const localSource: GroupSource = {
    ownerDeviceId: null,
    async readGroup(providerId) {
      return deps.readGroup(providerId);
    },
    async pick({ sessionId, providerId, agentKind, model, exclude, quotaRebalance }) {
      // 带着这一轮试过的来选：试过不行说明状态可能旧了，现读最新状态再选。选中的同一步记上临时占用：本机同时
      // 开的几个任务不会读到同一份负载、全落到同一台(与同账号电脑、分享的人问组所在电脑同一做法)。
      const pick = await router.pick({
        providerId,
        agentKind,
        model,
        // 本机任务与其他使用方同一套组策略，只是不受本机「暂停对外分配」限制；正常运行的已有绑定不走 pick。
        localTask: true,
        exclude,
        reserveFor: sessionId,
        ...(quotaRebalance ? { quotaRebalance } : {}),
        ...(exclude.size > 0 ? { fresh: true } : {}),
      });
      if (pick.kind !== 'member') return pick;
      return {
        kind: 'member',
        member: pick.member,
        label: pick.label,
        labelOf: (key) => {
          const found = pick.resolved.find((r) => r.member.key === key);
          return found && !found.pending ? found.label : undefined;
        },
      };
    },
    cool(providerId, memberKey, cause, resetAt, model) {
      if (!isAccountCause(cause)) return;
      router.markCooling(providerId, memberKey, coolUntil(cause, resetAt), cause === 'usage-limit' ? model : undefined);
    },
    async isKnownDown(providerId, memberKey, model) {
      return router.coolingUntil(providerId, memberKey, model) !== null;
    },
    async shouldMoveAway(providerId, config, memberKey, model, agentKind) {
      const resolved = await withTimeout(deps.directory.resolveMembers(providerId, config), PROVIDER_GROUP_BEFORE_SEND_TIMEOUT_MS);
      const state = resolved?.find((r) => r.member.key === memberKey);
      if (!state) return null;
      const cooling = router.coolingUntil(providerId, memberKey, model) !== null
        || providerGroupMemberUsageState(state, model, deps.now(), agentKind).limited;
      if (state.state === 'ok' && !cooling) return false;
      return { reason: cooling ? 'cooling' : state.state };
    },
    async rebalanceTarget(providerId, config, memberKey, model, agentKind, exclude) {
      const resolved = await withTimeout(deps.directory.resolveMembers(providerId, config), PROVIDER_GROUP_BEFORE_SEND_TIMEOUT_MS);
      const current = resolved?.find((r) => r.member.key === memberKey);
      if (!resolved || current?.state !== 'ok' || router.coolingUntil(providerId, memberKey, model) !== null) return null;
      const now = deps.now();
      const state = providerGroupMemberUsageState(current, model, now, agentKind);
      if (state.limited || !state.quota) return null;
      const candidates = router.rebalanceCandidates({ providerId, agentKind, model, localTask: true, exclude }, resolved);
      const key = providerGroupRebalanceTarget(state.quota, candidates, now);
      const target = key ? candidates.find((c) => c.key === key) : undefined;
      return target ? { memberKey: target.key, label: target.label, quota: target.quota } : null;
    },
    invalidate(member) {
      deps.directory.invalidate(member.agentDeviceId ?? undefined);
    },
    async memberKeyOf(groupProviderId, row) {
      if (row.agentDeviceId) {
        return row.providerId ? providerGroupMemberKey(row.agentDeviceId, row.providerId) : null;
      }
      const provider = row.providerId
        ?? (row.model ? await deps.resolveImplicitProvider(row.agentKind, row.model) : null);
      return provider === groupProviderId ? providerGroupMemberKey(null, provider) : null;
    },
    routeOf(member, localProviderId) {
      return member.kind === 'local'
        ? { agentDeviceId: null, providerId: localProviderId }
        : { agentDeviceId: member.agentDeviceId, providerId: member.providerId };
    },
  };

  const remoteSources = new Map<string, GroupSource>();

  function remoteSource(ownerDeviceId: string): GroupSource {
    const existing = remoteSources.get(ownerDeviceId);
    if (existing) return existing;
    const remote = deps.remote!;
    const self = () => deps.localDeviceId?.() ?? null;
    const source: GroupSource = {
      ownerDeviceId,
      readGroup: (providerId) => remote.readGroup(ownerDeviceId, providerId),
      async pick({ sessionId, providerId, config, agentKind, model, exclude, quotaRebalance }) {
        const pick = await remote.pick(ownerDeviceId, {
          sessionId,
          providerId,
          agentKind: agentKind as 'claude-code' | 'codex' | 'pi',
          model,
          exclude: [...exclude],
          ...(quotaRebalance ? { quotaRebalance } : {}),
        });
        if (pick.kind !== 'member') return pick;
        const labelOf = (key: string) => {
          const found = config.members.find((m) => m.key === key);
          return found ? deps.directory.memberLabel(found) || undefined : undefined;
        };
        // 组设置以组所在电脑为准；本机读到的那份可能稍旧，缺的组员按回包补齐。
        const member = config.members.find((m) => m.key === pick.member.key)
          ?? { ...pick.member, limit: 1, weight: 1, paused: false };
        return { kind: 'member', member, label: pick.label, labelOf };
      },
      cool(providerId, memberKey, cause, resetAt, model) {
        // 连不上、起不来只由发现它的这台电脑自己避开(这一轮已试过)，不替全组判断：可能只是这台连不过去。
        if (!isAccountCause(cause)) return;
        void remote.cool(ownerDeviceId, { providerId, memberKey, cause, resetAt, ...(cause === 'usage-limit' ? { model } : {}) }).catch((error) => {
          deps.log.warn('provider group: reporting a computer to cool down failed', { error: errorText(error) });
        });
      },
      async isKnownDown(providerId, memberKey, model, agentKind) {
        const view = await remote.view(ownerDeviceId, providerId, model, agentKind);
        return view.members.find((m) => m.key === memberKey)?.state === 'cooling';
      },
      async shouldMoveAway(providerId, _config, memberKey, model, agentKind) {
        const view = await withTimeout(remote.view(ownerDeviceId, providerId, model, agentKind), PROVIDER_GROUP_BEFORE_SEND_TIMEOUT_MS);
        const state = view?.members.find((m) => m.key === memberKey)?.state;
        if (!state) return null;
        if (view?.model !== model && state !== 'offline' && state !== 'unavailable' && state !== 'cooling') return null;
        return state === 'offline' || state === 'unavailable' || state === 'cooling' ? { reason: state } : false;
      },
      async rebalanceTarget(providerId, config, memberKey, model, agentKind, exclude) {
        // 组所在电脑随状态回每台的配额窗口(旧版本不回，就不提议)；只换到它看着「可用」(在线、未满载、未暂停、
        // 不在冷却)且 5 小时配额不紧张的电脑。
        const view = await withTimeout(remote.view(ownerDeviceId, providerId, model, agentKind), PROVIDER_GROUP_BEFORE_SEND_TIMEOUT_MS);
        const current = view?.members.find((m) => m.key === memberKey);
        if (!view || view.model !== model || !current?.quota || (current.state !== 'available' && current.state !== 'full')) return null;
        const candidates = view.members.flatMap((m) => m.key !== memberKey && !exclude.has(m.key) && m.state === 'available'
          && m.quota && !m.fiveHourTight && !m.unreachableHere
          ? [{ key: m.key, label: rebalanceLabel(config, m.key, m.label, m.providerName), quota: m.quota }]
          : []);
        const key = providerGroupRebalanceTarget(current.quota, candidates, deps.now());
        const target = key ? candidates.find((c) => c.key === key) : undefined;
        return target ? { memberKey: target.key, label: target.label, quota: target.quota } : null;
      },
      invalidate() {
        remote.invalidate(ownerDeviceId);
      },
      async memberKeyOf(groupProviderId, row) {
        // 本机坐标 → 组所在电脑坐标。
        if (row.agentDeviceId === ownerDeviceId) {
          return row.providerId === groupProviderId ? providerGroupMemberKey(null, groupProviderId) : null;
        }
        if (row.agentDeviceId) {
          return row.providerId ? providerGroupMemberKey(row.agentDeviceId, row.providerId) : null;
        }
        const me = self();
        if (!me) return null;
        const provider = row.providerId
          ?? (row.model ? await deps.resolveImplicitProvider(row.agentKind, row.model) : null);
        return provider ? providerGroupMemberKey(me, provider) : null;
      },
      routeOf(member) {
        // 组所在电脑坐标 → 本机启动参数：它自己是组所在电脑；组里的「本机这台」就是这里。
        if (member.kind === 'local') return { agentDeviceId: ownerDeviceId, providerId: member.providerId };
        if (member.kind === 'device' && member.agentDeviceId === self()) {
          return { agentDeviceId: null, providerId: member.providerId };
        }
        return { agentDeviceId: member.agentDeviceId, providerId: member.providerId };
      },
    };
    remoteSources.set(ownerDeviceId, source);
    return source;
  }

  function sourceFor(groupDeviceId: string | null | undefined): GroupSource | null {
    if (!groupDeviceId) return localSource;
    return deps.remote ? remoteSource(groupDeviceId) : null;
  }

  function bindingFor(source: GroupSource, providerId: string, memberKey: string) {
    return { providerId, memberKey, ...(source.ownerDeviceId ? { groupDeviceId: source.ownerDeviceId } : {}) };
  }

  function groupOf(source: GroupSource, providerId: string): ProviderGroupRef {
    return { providerId, groupDeviceId: source.ownerDeviceId };
  }

  /** 启动时组暂时读不到时，用任务记录/绑定拼出当前成员；只用于失败后重新读组，不写入组成员资料。 */
  function pendingMember(
    memberKey: string,
    providerId: string,
    agentDeviceId: string | null,
  ): ProviderGroupMember {
    const kind: ProviderGroupMember['kind'] = memberKey === 'local'
      ? 'local'
      : memberKey.startsWith('share:') ? 'share' : 'device';
    return {
      key: memberKey,
      kind,
      agentDeviceId: kind === 'local' ? null : agentDeviceId,
      providerId,
      limit: 1,
      weight: 1,
      paused: false,
    };
  }

  /** 任务记录里 Agent 所在位置换成组里的键(组所在电脑视角)，不看它还在不在组里；SSH 远端任务返回 null。 */
  async function locatedMemberKey(
    source: GroupSource,
    groupProviderId: string,
    row: ProviderGroupSessionRow,
  ): Promise<string | null> {
    return row.remoteHostId ? null : source.memberKeyOf(groupProviderId, row);
  }

  /** 任务记录里 Agent 实际所在位置对应的组内电脑键；不在组里返回 null。 */
  async function actualMemberKey(
    source: GroupSource,
    groupProviderId: string,
    config: ProviderGroupConfig,
    row: ProviderGroupSessionRow,
  ): Promise<string | null> {
    const key = await locatedMemberKey(source, groupProviderId, row);
    return key !== null && config.members.some((m) => m.key === key) ? key : null;
  }

  /**
   * 以任务记录为准核对绑定，返回任务此刻所在的组内电脑。
   * - 用户把任务挪到了组外：解除绑定并返回 null——之后的自动换电脑不能覆盖用户的选择，也不能把别处的
   *   失败记到组内电脑头上。
   * - 挪到了组里另一台(模型选择里选组那一项、换电脑交接后任务记录先变)：仍在组里，绑定跟着更新(§6)，
   *   照常返回那台——这次失败同样要换电脑，不能因为绑定刚改过就跳过一次(2026-10-11 用户反馈)。
   */
  async function verifyBinding(
    sessionId: string,
    source: GroupSource,
    binding: ProviderGroupBinding,
    config: ProviderGroupConfig | null,
    row: ProviderGroupSessionRow,
  ): Promise<ProviderGroupMember | null> {
    const located = await locatedMemberKey(source, binding.providerId, row);
    const key = located !== null && config?.members.some((m) => m.key === located) ? located : null;
    if (key === null) {
      await deps.writeBinding(sessionId, null);
      // 任务还在原来那台、那台却已被移出组(或组已删除)：之后同一台重新加入、重建同一个组都不再纳入(§9.4)。
      // 用户把任务挪到组外不记：挪回组那一项时照常纳入。
      if (!config || located === binding.memberKey) await deps.markReleased(sessionId, groupOf(source, binding.providerId));
      return null;
    }
    if (key !== binding.memberKey) await deps.writeBinding(sessionId, bindingFor(source, binding.providerId, key));
    return config!.members.find((m) => m.key === key) ?? null;
  }

  /**
   * 交接换电脑时不考虑的组内电脑：这一轮试过的，以及与当前所在同一台电脑上的其他账号——首版的交接只能
   * 换电脑，同一台电脑上换账号不会生效(新任务分配不受此限)。
   */
  function switchExclusion(
    config: ProviderGroupConfig,
    current: ProviderGroupMember,
    tried: ReadonlySet<string>,
  ): Set<string> {
    const exclude = new Set(tried);
    for (const member of config.members) {
      if (member.agentDeviceId === current.agentDeviceId) exclude.add(member.key);
    }
    return exclude;
  }

  function backoffKey(source: GroupSource, groupProviderId: string, memberKey: string): string {
    return `${source.ownerDeviceId ?? ''}\u0000${groupProviderId}\u0000${memberKey}`;
  }

  /** 换号时不考虑的：同一台电脑上的账号(交接只能换电脑)，以及刚换失败、还在退避中的。 */
  function rebalanceExclusion(source: GroupSource, groupProviderId: string, config: ProviderGroupConfig, current: ProviderGroupMember): Set<string> {
    const exclude = switchExclusion(config, current, new Set());
    const now = deps.now();
    for (const member of config.members) {
      const key = backoffKey(source, groupProviderId, member.key);
      const until = rebalanceBackoff.get(key);
      if (until === undefined) continue;
      if (until > now) exclude.add(member.key);
      else rebalanceBackoff.delete(key);
    }
    return exclude;
  }

  /**
   * 提议换号的前提：任务归组、不在回复中、可以由组换电脑(不是伙伴、共享中的任务等)，任务记录里的位置就是绑定的那台。
   * 只读，不改绑定(核对与修正留给发送前检查)。
   */
  async function rebalanceContext(sessionId: string) {
    if (!deps.readBinding(sessionId) || deps.isTurnRunning(sessionId)) return null;
    const bound = await withTimeout(loadBound(sessionId), PROVIDER_GROUP_BEFORE_SEND_TIMEOUT_MS);
    if (!bound?.config || !(await deps.isFailoverEligible(sessionId))) return null;
    const { binding, source, config } = bound;
    const row = await deps.readSessionRow(sessionId);
    if (!row?.model || row.remoteHostId) return null;
    const located = await locatedMemberKey(source, binding.providerId, row);
    const current = located === binding.memberKey ? config.members.find((m) => m.key === located) : undefined;
    if (!current || (current.paused && !(source.ownerDeviceId === null && current.kind === 'local'))) return null;
    return { binding, source, config, row: { ...row, model: row.model }, current };
  }

  /**
   * 发送前换号(provider-groups.md §6.2「任务进行中换号」)：任务所在那台能用，只是 `target` 的配额更该先用。
   * 只试这一台，不记「这一轮试过」(原电脑没出问题，之后出错时仍可以换回来)；它此刻接不了或交接失败就照常发到原电脑、
   * 不报错，这台 PROVIDER_GROUP_REBALANCE_BACKOFF_MS 内不再提议。交接期间进行中行显示「正在换一台电脑继续」，
   * 分隔条写明是为了先用那台的配额。
   */
  async function rebalanceBeforeSend(
    sessionId: string,
    source: GroupSource,
    groupProviderId: string,
    config: ProviderGroupConfig,
    current: ProviderGroupMember,
    row: ProviderGroupSessionRow & { model: string },
    target: string,
    options: ProviderGroupBeforeSendOptions | undefined,
  ): Promise<boolean> {
    const { run, done } = trackRun(sessionId);
    const isCurrent = () => !run.superseded && options?.signal?.aborted !== true;
    const backoff = () => rebalanceBackoff.set(backoffKey(source, groupProviderId, target), deps.now() + PROVIDER_GROUP_REBALANCE_BACKOFF_MS);
    try {
      options?.progress?.('switching');
      const pick = await source.pick({
        sessionId,
        providerId: groupProviderId,
        config,
        agentKind: row.agentKind,
        model: row.model,
        exclude: new Set(config.members.map((m) => m.key).filter((key) => key !== target)),
        quotaRebalance: current.key,
      });
      if (!isCurrent()) return false;
      if (pick.kind !== 'member' || pick.member.key !== target) {
        backoff();
        deps.log.info('provider group: the account chosen for balancing is not available now; sending on the current one', { sessionId, to: target });
        return false;
      }
      const localProviderId = current.kind === 'local' && !source.ownerDeviceId ? row.providerId : groupProviderId;
      const route = source.routeOf(pick.member, localProviderId);
      await deps.writeBinding(sessionId, bindingFor(source, groupProviderId, target));
      try {
        await deps.switchAgentLocation(sessionId, {
          agentKind: row.agentKind,
          model: row.model,
          providerId: route.providerId,
          agentDeviceId: route.agentDeviceId,
        }, { beforeSend: true, isCurrent, reason: 'quota-rebalance' });
        deps.log.info('provider group: moved a task to the account whose quota should be used first', {
          sessionId,
          from: current.key,
          to: target,
        });
        return true;
      } catch (error) {
        await restoreBindingAfterFailedSwitch(sessionId, source, groupProviderId, config);
        if (isCurrent()) backoff();
        deps.log.warn('provider group: moving a task to balance quota failed; sending on the current computer', {
          sessionId,
          error: errorText(error),
        });
        return false;
      }
    } finally {
      done();
    }
  }

  /** 交接失败后以任务记录为准还原绑定(交接可能已改了位置，也可能没有)。 */
  async function restoreBindingAfterFailedSwitch(
    sessionId: string,
    source: GroupSource,
    groupProviderId: string,
    config: ProviderGroupConfig,
  ): Promise<void> {
    const row = await deps.readSessionRow(sessionId);
    const key = row ? await actualMemberKey(source, groupProviderId, config, row) : null;
    await deps.writeBinding(sessionId, key ? bindingFor(source, groupProviderId, key) : null);
  }

  /** 读到的绑定与组设置(组所在电脑读不到时返回 null，什么都不动)。 */
  async function loadBound(sessionId: string): Promise<{
    binding: ProviderGroupBinding;
    source: GroupSource;
    config: ProviderGroupConfig | null;
  } | null> {
    const binding = deps.readBinding(sessionId);
    if (!binding) return null;
    const source = sourceFor(binding.groupDeviceId);
    if (!source) return null;
    const config = await source.readGroup(binding.providerId).catch(() => undefined);
    if (config === undefined) return null;
    return { binding, source, config };
  }

  /**
   * 组所在电脑确认组已删除(读到了、没有这个组)时立即解除绑定，任务成为普通的(远程)任务——之后重建同一个组也不会
   * 恢复自动换电脑(§9.4)。读不到(undefined)的情况 loadBound 已经挡掉，绑定不动。
   */
  async function releaseDeletedGroup(sessionId: string, group: ProviderGroupRef): Promise<void> {
    await deps.writeBinding(sessionId, null);
    await deps.markReleased(sessionId, group);
    deps.log.info('provider group: group no longer exists; released the task', { sessionId });
  }

  /** 把正用着组里某一项的任务纳入组(不挪动它)；曾因组内电脑被移出或组被删除而解除过的不纳入(§9.4)。 */
  async function adopt(sessionId: string, source: GroupSource, groupProviderId: string, memberKey: string): Promise<boolean> {
    if (deps.isReleased(sessionId, groupOf(source, groupProviderId))) return false;
    await deps.writeBinding(sessionId, bindingFor(source, groupProviderId, memberKey));
    deps.log.info('provider group: took in a task already running in the group', {
      sessionId,
      groupProviderId,
      member: memberKey,
      remote: source.ownerDeviceId !== null,
    });
    return true;
  }

  /**
   * 还没归组、但正用着组那一项的老任务纳入组，不挪动它(§6)：用着本机建了组的供应商，或用着同账号另一台电脑上
   * 建了组的那个供应商(在组所在电脑本身运行)。直接选组里某台电脑、分享来的供应商不算：用的不是组那一项(§4)。
   * 返回是否纳入。
   */
  async function adoptRunningTask(sessionId: string, row: ProviderGroupSessionRow): Promise<boolean> {
    if (row.remoteHostId) return false;
    if (!row.agentDeviceId) {
      const groupProviderId = row.providerId
        ?? (row.model ? await deps.resolveImplicitProvider(row.agentKind, row.model) : null);
      const config = groupProviderId ? deps.readGroup(groupProviderId) : null;
      if (!groupProviderId || !config?.members.some((m) => m.kind === 'local')) return false;
      return adopt(sessionId, localSource, groupProviderId, providerGroupMemberKey(null, groupProviderId));
    }
    if (!deps.remote || isProviderShareAgentDeviceId(row.agentDeviceId) || !row.providerId) return false;
    const source = remoteSource(row.agentDeviceId);
    const groupProviderId = row.providerId;
    // 先看本地记录，解除过的不再问组所在电脑。
    if (deps.isReleased(sessionId, groupOf(source, groupProviderId))) return false;
    const config = await source.readGroup(groupProviderId).catch(() => undefined);
    if (!config) return false;
    const key = await actualMemberKey(source, groupProviderId, config, row);
    return key !== null && adopt(sessionId, source, groupProviderId, key);
  }

  /** 出错时还没归组：老任务正用着组那一项时先纳入组，再照常换电脑(一直开着的老任务不用等重新打开)。 */
  async function adoptOnFailure(sessionId: string): Promise<boolean> {
    const row = await deps.readSessionRow(sessionId);
    if (!row?.model || row.remoteHostId || isProviderShareAgentDeviceId(row.agentDeviceId)) return false;
    if (!(await deps.isFailoverEligible(sessionId))) return false;
    return (await withTimeout(adoptRunningTask(sessionId, row), PROVIDER_GROUP_ADOPT_TIMEOUT_MS)) === true;
  }

  /**
   * 登记一次进行中的换电脑：用户在途中接手(重试、发消息、换模型)或那次错误已不是当前状态时，之后的每一步都停手。
   * `handBack` 在不再换电脑时交回原有的报错与额度重置后自动继续；之前的交接若已关掉旧会话，换一个对当前状态
   * 有效的令牌。`run` 在取得句柄时就已登记(failover)，取得之后、开始之前的检查期间用户接手同样停手：一步都不做。
   */
  async function withSwitchRun(
    sessionId: string,
    signals: InterruptedTurnErrorSignals,
    token: number,
    lease: object,
    run: { superseded: boolean },
    hooks: ProviderGroupTurnErrorHooks | undefined,
    body: (isCurrent: () => boolean, handBack: () => void) => Promise<void>,
  ): Promise<void> {
    const isCurrent = () => !run.superseded && deps.isLeaseCurrent(sessionId, lease);
    if (!isCurrent()) return;
    const handBack = () => {
      if (!isCurrent()) return;
      hooks?.beforeFallback?.();
      const fallbackToken = deps.leaseRecovery(sessionId, token) ? token : deps.rearmContinue(sessionId, lease, null);
      if (fallbackToken !== null) deps.fallback(sessionId, signals, fallbackToken);
    };
    try {
      await body(isCurrent, handBack);
    } catch (error) {
      deps.log.warn('provider group: automatic switch failed', { sessionId, error: errorText(error) });
      handBack();
    }
  }

  /** true = 已由本机制处理(含它自己交回原有处理)；false = 不归它管，调用方照常交回。 */
  async function failover(
    sessionId: string,
    signals: InterruptedTurnErrorSignals,
    token: number,
    hooks: ProviderGroupTurnErrorHooks | undefined,
  ): Promise<boolean> {
    const decision = decide(sessionId, signals, 'run');
    if (decision.action !== 'switch') return false;
    // 交接会关闭旧会话(关闭撤销限额等待)：先取得这次错误的重试入口。终态错误后会话也可能在下面的检查期间自己关闭
    // (drain 宽限到点关闭重建)，所以在第一次 await 之前取得；同时登记这一趟，下面检查期间用户接手(发消息、重试、
    // 换模型)或新一轮都让它停手(run.superseded / isLeaseCurrent)。
    const lease = deps.leaseRecovery(sessionId, token);
    const { run, done } = trackRun(sessionId);
    try {
      if (signals.reason === 'remote_agent_restarted') {
        // A missing run after a supplier restart is not a reason to move the task.
        // Reuse the existing recovery lease, bounded wait, cancellation and UI trail
        // even for suppliers that do not belong to a group.
        if (!(await deps.isFailoverEligible(sessionId))) return false;
        const row = await deps.readSessionRow(sessionId);
        if (!row?.agentDeviceId || !row.providerId || row.remoteHostId) return false;
        if (!lease) return true;
        await withSwitchRun(sessionId, signals, token, lease, run, hooks, async (isCurrent, handBack) => {
          // Unlike a group relocation, this keeps the local Session alive. Its
          // original candidate must still exist: explicit close cancels it even
          // though the reusable recovery lease remains for a manual retry.
          const direct = deps.directGuestSession?.(sessionId);
          const restartIsCurrent = () => isCurrent() && deps.leaseRecovery(sessionId, token) === lease
            && (!direct || deps.directGuestSession?.(sessionId) === direct);
          // The stored share route identifies O, not the executor M. Reauthorize
          // and probe the pinned M, without exposing its identity in the activity row.
          const outcome = await awaitReturn(sessionId, row, row.agentDeviceId!, restartIsCurrent, (attempt) => {
            hooks?.reconnecting?.(attempt, PROVIDER_GROUP_RECONNECT_MAX_ATTEMPTS);
          }, { connectionLost: true, ...(direct?.probeReconnect ? { probe: () => direct.probeReconnect!(restartIsCurrent) } : {}) }).catch((error: unknown) => {
            // A pending probe can reject after explicit close. Do not let the
            // group's general fallback rearm a candidate that close cancelled.
            if (!restartIsCurrent()) return 'stopped' as const;
            throw error;
          });
          if (outcome === 'stopped') return;
          if (outcome === 'back') {
            await continueOnSameComputer(sessionId, '', lease, restartIsCurrent, hooks);
          } else handBack();
        });
        return true;
      }
      return await failoverRun(sessionId, signals, token, hooks, decision, lease, run);
    } finally {
      done();
    }
  }

  async function failoverRun(
    sessionId: string,
    signals: InterruptedTurnErrorSignals,
    token: number,
    hooks: ProviderGroupTurnErrorHooks | undefined,
    decision: ProviderGroupFailureDecision & { action: 'switch' },
    lease: object | null,
    run: { superseded: boolean },
  ): Promise<boolean> {
    const { cause } = decision;
    if (!deps.readBinding(sessionId) && !(await adoptOnFailure(sessionId))) {
      return guestFailover(sessionId, signals, token, lease, run, cause, hooks);
    }
    const bound = await loadBound(sessionId);
    if (!bound) {
      return decision.connection ? reconnectWithoutGroup(sessionId, signals, token, lease, run, decision, hooks) : false;
    }
    const { binding, source, config } = bound;
    if (!config) {
      await releaseDeletedGroup(sessionId, groupOf(source, binding.providerId));
      return false;
    }
    if (!config.autoSwitch) return false;
    if (!(await deps.isFailoverEligible(sessionId))) return false;
    const row = await deps.readSessionRow(sessionId);
    if (!row?.model || row.remoteHostId) return false;
    const current = await verifyBinding(sessionId, source, binding, config, row);
    if (!current) return false;
    // 用户已接手时什么都不做。
    if (!lease) return true;
    const boundRow = { ...row, model: row.model };
    await withSwitchRun(sessionId, signals, token, lease, run, hooks, async (isCurrent, handBack) => {
      // 连不上先等那台恢复：恢复了留在原电脑继续这一轮(不交接)，等不到再换。
      if (decision.connection) {
        let waited = false;
        const route = source.routeOf(current, row.providerId);
        const outcome = await awaitReturn(sessionId, route, current.key, isCurrent, (attempt) => {
          waited = true;
          hooks?.reconnecting?.(attempt, PROVIDER_GROUP_RECONNECT_MAX_ATTEMPTS);
        }, {
          connectionLost: decision.connection === 'lost',
          knownDown: () => knownDown(source, binding.providerId, current.key, route, row.model ?? undefined, row.agentKind),
        });
        if (outcome === 'stopped') return;
        if (outcome === 'back') {
          await continueOnSameComputer(sessionId, deps.directory.memberLabel(current), lease, isCurrent, hooks);
          return;
        }
        if (waited) hooks?.switching?.();
      }
      await switchUntilSettled({
        sessionId, signals, decision, binding, source, config, row: boundRow, current, lease, isCurrent, handBack, hooks,
      });
    });
    return true;
  }

  /**
   * 原电脑等回来了：留在原电脑继续这一轮，不交接；活动记录写「已重新连上 {电脑}，继续运行」(`computer` 为空时写
   * 「原来的电脑」)。
   */
  async function continueOnSameComputer(
    sessionId: string,
    computer: string,
    lease: object,
    isCurrent: () => boolean,
    hooks: ProviderGroupTurnErrorHooks | undefined,
  ): Promise<void> {
    if (!isCurrent()) return;
    const continueToken = deps.rearmContinue(sessionId, lease, deps.now());
    if (continueToken === null) return;
    hooks?.continuing?.();
    const outcome = await deps.continueSession(sessionId, continueToken, {
      reason: USAGE_LIMIT_RESET_AUTO_RESUME_REASON,
      attempt: 1,
      maxAttempts: 1,
      sessionTotal: 0,
      agentReconnect: { computer },
    });
    if (outcome === 'resumed') hooks?.resumed?.();
    else deps.cancelContinue(sessionId, continueToken);
  }

  /**
   * 别的电脑上的组读不到(常见是任务就跑在组所在电脑上、它自己断了)：换不了电脑，但仍先等任务所在那台恢复(§6.1)。
   * 恢复了在原电脑继续，等不到交回原有处理。位置取任务记录里的写法，不需要组设置。
   */
  async function reconnectWithoutGroup(
    sessionId: string,
    signals: InterruptedTurnErrorSignals,
    token: number,
    lease: object | null,
    run: { superseded: boolean },
    decision: ProviderGroupFailureDecision & { action: 'switch' },
    hooks: ProviderGroupTurnErrorHooks | undefined,
  ): Promise<boolean> {
    const binding = deps.readBinding(sessionId);
    if (!binding?.groupDeviceId || !deps.remote) return false;
    if (!(await deps.isFailoverEligible(sessionId))) return false;
    const row = await deps.readSessionRow(sessionId);
    if (!row?.model || row.remoteHostId || !row.agentDeviceId || !row.providerId) return false;
    const route = { agentDeviceId: row.agentDeviceId, providerId: row.providerId };
    if (!lease) return true;
    await withSwitchRun(sessionId, signals, token, lease, run, hooks, async (isCurrent, handBack) => {
      const outcome = await awaitReturn(sessionId, route, binding.memberKey, isCurrent, (attempt) => {
        hooks?.reconnecting?.(attempt, PROVIDER_GROUP_RECONNECT_MAX_ATTEMPTS);
      }, {
        connectionLost: decision.connection === 'lost',
        knownDown: () => knownDown(null, binding.providerId, binding.memberKey, route),
      });
      if (outcome === 'stopped') return;
      if (outcome === 'back') {
        await continueOnSameComputer(sessionId, '', lease, isCurrent, hooks);
        return;
      }
      deps.log.info('provider group: the group computer cannot be read; handing back', { sessionId });
      handBack();
    });
    return true;
  }

  /**
   * 发送前等那台恢复(这条还没派出去)：进度交给调用方显示；发送被停止或用户接手时停下。已经确认那台用不了时
   * 不等(`isKnownDown`)。
   */
  async function waitBeforeSend(
    sessionId: string,
    route: ProviderGroupRoute,
    memberKey: string,
    knownOffline: boolean,
    options: ProviderGroupBeforeSendOptions | undefined,
    isKnownDown: () => Promise<boolean>,
  ): Promise<ReturnOutcome> {
    const { run, done } = trackRun(sessionId);
    try {
      return await awaitReturn(sessionId, route, memberKey, () => !run.superseded, (attempt) => {
        options?.progress?.({ attempt, maxAttempts: PROVIDER_GROUP_RECONNECT_MAX_ATTEMPTS });
      }, { knownOffline, knownDown: isKnownDown, ...(options?.signal ? { signal: options.signal } : {}) });
    } finally {
      done();
    }
  }

  /**
   * 发送前读不到别的电脑上的组：换不了电脑，但这次要重新打开任务所在那台上的会话时，仍现读那台，离线先等它恢复，
   * 免得一打开就报错。位置取任务记录里的写法。
   */
  async function waitBeforeSendWithoutGroup(
    sessionId: string,
    options: ProviderGroupBeforeSendOptions | undefined,
  ): Promise<void> {
    const binding = deps.readBinding(sessionId);
    if (!binding?.groupDeviceId || !deps.remote || deps.hasLiveSession?.(sessionId) !== false) return;
    if (!(await deps.isFailoverEligible(sessionId))) return;
    const row = await deps.readSessionRow(sessionId).catch(() => null);
    if (!row?.agentDeviceId || !row.providerId || row.remoteHostId) return;
    const route = { agentDeviceId: row.agentDeviceId, providerId: row.providerId };
    await waitBeforeSend(
      sessionId,
      route,
      binding.memberKey,
      false,
      options,
      () => knownDown(null, binding.providerId, binding.memberKey, route),
    );
  }

  /**
   * 分享的人这边(§6.1)：任务用的是分享来的供应商，分享者把它建成了组，实际运行的电脑由组所在电脑选，本机不知道
   * 是哪台。那台因电脑本身的原因失败时，组所在电脑先发来「需要换一台」凭证；本机交接(新建会话并带上交接上下文)
   * 后带着凭证重新打开，组所在电脑据此换一台，再继续这一轮。没有凭证不换：分享被暂停、删除、撤权是分享本身的
   * 问题，换到哪台都一样。
   */
  async function guestFailover(
    sessionId: string,
    signals: InterruptedTurnErrorSignals,
    token: number,
    lease: object | null,
    run: { superseded: boolean },
    cause: ProviderGroupFailureCause,
    hooks: ProviderGroupTurnErrorHooks | undefined,
  ): Promise<boolean> {
    const guestSwitch = deps.guestSwitch;
    if (!guestSwitch) return false;
    const row = await deps.readSessionRow(sessionId);
    const shareRoute = row?.agentDeviceId;
    if (!row?.model || row.remoteHostId || !shareRoute || !isProviderShareAgentDeviceId(shareRoute)) return false;
    if (!(await deps.isFailoverEligible(sessionId))) return false;
    if (!guestSwitch.claim(sessionId)) {
      const direct = deps.directGuestSession?.(sessionId);
      if (!direct || direct.ownerRoute !== shareRoute || !lease || run.superseded
        || !deps.isLeaseCurrent(sessionId, lease)) return false;
      const offered = await direct.requestSwitch().catch(() => undefined);
      if (!offered || run.superseded || !deps.isLeaseCurrent(sessionId, lease)
        || deps.directGuestSession?.(sessionId) !== direct) return false;
      guestSwitch.offer(sessionId, offered);
      if (!guestSwitch.claim(sessionId)) return false;
    }
    // 检查期间用户已接手或错误已被新的一轮接管：不换，作废刚登记给下一次打开的凭证。
    if (!lease || run.superseded || !deps.isLeaseCurrent(sessionId, lease)) {
      guestSwitch.release(sessionId);
      return true;
    }
    const model = row.model;
    await withSwitchRun(sessionId, signals, token, lease, run, hooks, async (isCurrent, handBack) => {
      try {
        // 位置仍是同一个分享：强制重新交接、新建会话，打开时带上凭证，由组所在电脑换一台。
        await deps.switchAgentLocation(sessionId, {
          agentKind: row.agentKind,
          model,
          providerId: row.providerId,
          agentDeviceId: shareRoute,
        }, { isCurrent, relocate: true });
      } catch (error) {
        guestSwitch.release(sessionId);
        deps.log.info('provider group: switching computer for a shared task stopped', { sessionId, error: errorText(error) });
        handBack();
        return;
      }
      deps.log.info('provider group: switched computer for a shared task', { sessionId, cause });
      if (!isCurrent()) return;
      const continueToken = deps.rearmContinue(sessionId, lease, deps.now());
      if (continueToken === null) return;
      hooks?.continuing?.();
      const outcome = await deps.continueSession(sessionId, continueToken, {
        reason: USAGE_LIMIT_RESET_AUTO_RESUME_REASON,
        attempt: 1,
        maxAttempts: 1,
        sessionTotal: 0,
        groupSwitch: { cause },
      });
      if (outcome === 'resumed') hooks?.resumed?.();
      else deps.cancelContinue(sessionId, continueToken);
    });
    return true;
  }

  async function switchUntilSettled(input: {
    sessionId: string;
    signals: InterruptedTurnErrorSignals;
    decision: ProviderGroupFailureDecision & { action: 'switch' };
    binding: ProviderGroupBinding;
    source: GroupSource;
    config: ProviderGroupConfig;
    row: ProviderGroupSessionRow & { model: string };
    current: ProviderGroupMember;
    lease: object;
    isCurrent: () => boolean;
    handBack: () => void;
    hooks: ProviderGroupTurnErrorHooks | undefined;
  }): Promise<void> {
    const { sessionId, signals, decision, binding, source, config, row, current, lease, isCurrent, handBack, hooks } = input;
    const { cause } = decision;
    if (decision.cool) source.cool(binding.providerId, current.key, cause, deps.readResetAt(signals), row.model);
    source.invalidate(current);
    const tried = router.markTried(sessionId, current.key);
    // 这条消息发出前刚换不过去的电脑不再重复去试、重复去等。
    const preSend = preSendFailed.get(sessionId);
    preSendFailed.delete(sessionId);
    if (preSend && deps.now() - preSend.at <= PROVIDER_GROUP_PRE_SEND_FAILED_TTL_MS) {
      for (const key of preSend.keys) router.markTried(sessionId, key);
    }
    // 换回本机时：原本就在本机的保留原来的来源写法(可能是隐式来源)，否则用组所属的供应商。
    const localProviderId = current.kind === 'local' ? row.providerId : binding.providerId;
    // 分享来的电脑用分享者的昵称(不用电脑名)；读不到时为空，活动记录退回不写电脑的说法。
    let fromLabel = deps.directory.memberLabel(current);
    const skipped = createSkippedTargets();

    for (;;) {
      if (!isCurrent()) return;
      const pick = await source.pick({
        sessionId,
        providerId: binding.providerId,
        config,
        agentKind: row.agentKind,
        model: row.model,
        exclude: skipped.exclusion(switchExclusion(config, current, tried)),
      });
      // 选电脑期间用户已接手：绑定与任务记录都还没动，直接停下。
      if (!isCurrent()) return;
      if (pick.kind !== 'member') {
        // 组里只剩这一轮因连不上而跳过的电脑：先等它们恢复再试，都等不到才交回原有的报错。
        if (pick.kind === 'unavailable') {
          const back = await skipped.awaitAny((member) =>
            awaitSkippedTarget(sessionId, source, member, localProviderId, isCurrent, () => hooks?.switching?.()), isCurrent);
          if (!isCurrent()) return;
          if (back) continue;
        }
        deps.log.info('provider group: no computer left to switch to', { sessionId, cause, tried: tried.size });
        resetRound(sessionId);
        handBack();
        return;
      }
      fromLabel = pick.labelOf(current.key) ?? fromLabel;
      const route = source.routeOf(pick.member, localProviderId);
      // 先写绑定再交接：交接会重建会话，分配入口据绑定认出它已归组，不会重新分配。
      await deps.writeBinding(sessionId, bindingFor(source, binding.providerId, pick.member.key));
      try {
        await deps.switchAgentLocation(sessionId, {
          agentKind: row.agentKind,
          model: row.model,
          providerId: route.providerId,
          agentDeviceId: route.agentDeviceId,
        }, { isCurrent });
      } catch (error) {
        await restoreBindingAfterFailedSwitch(sessionId, source, binding.providerId, config);
        // 与失败本身同一个判定：目标电脑的问题(连不上、分享暂停、Agent 起不来等)换下一台；任务在运行、
        // 已删除、用户已接手等与目标无关的失败直接结束，不冷却任何电脑。
        const target = decide(sessionId, providerGroupFailureSignals(error), 'target', pick.member.key);
        if (target.action !== 'switch' || !isCurrent()) {
          deps.log.info('provider group: switching computer stopped', { sessionId, error: errorText(error) });
          handBack();
          return;
        }
        deps.log.warn('provider group: switching computer failed; trying the next one', {
          sessionId,
          member: pick.member.key,
          error: errorText(error),
        });
        router.markTried(sessionId, pick.member.key);
        if (target.cool) source.cool(binding.providerId, pick.member.key, target.cause, null, row.model);
        skipped.failed(pick.member, isUnreachableTarget(target));
        continue;
      }
      deps.log.info('provider group: switched computer', { sessionId, cause, to: pick.member.key });
      // 交接期间用户已接手(发消息、重试、换模型、收下错误)：不替用户续跑。
      if (!isCurrent()) return;
      const continueToken = deps.rearmContinue(sessionId, lease, deps.now());
      if (continueToken === null) return;
      hooks?.continuing?.();
      const outcome = await deps.continueSession(sessionId, continueToken, {
        reason: USAGE_LIMIT_RESET_AUTO_RESUME_REASON,
        attempt: 1,
        maxAttempts: 1,
        sessionTotal: 0,
        agentSwitch: { from: fromLabel, to: pick.label, cause, kind: 'computer' },
      });
      if (outcome === 'resumed') hooks?.resumed?.();
      else deps.cancelContinue(sessionId, continueToken);
      return;
    }
  }

  /** 已经指向同账号另一台电脑的新任务：那台把这个供应商建成了组时，问它该用哪台。 */
  async function assignFromRemoteGroup(
    sessionId: string,
    row: ProviderGroupSessionRow,
    agentKind: AgentKind,
    model: string,
  ): Promise<ProviderGroupStartContext | null> {
    const ownerDeviceId = row.agentDeviceId;
    if (!deps.remote || !ownerDeviceId || isProviderShareAgentDeviceId(ownerDeviceId) || !row.providerId) return null;
    const source = remoteSource(ownerDeviceId);
    const groupProviderId = row.providerId;
    // 只给从没运行过的任务按策略选电脑；已经运行过的任务先纳入组并留在原电脑。
    // 已经运行过、但这次要重新打开：仍是启动阶段，返回启动上下文，启动失败时试组内下一台；有原生会话要续接时
    // 换过去先带交接(register 的启动重试)，不拿原来那台的会话 id 去别处打开。
    // 问不到组所在电脑时照常启动，出错时再补。
    const hasRun = Boolean(row.sdkSessionId || (await deps.hasAssistantHistory(sessionId)));
    // 已经明确解除过这个组的老任务不再询问组所在电脑，也不自动纳回。
    if (hasRun && deps.isReleased(sessionId, groupOf(source, groupProviderId))) return null;
    const config = hasRun
      ? await withTimeout(source.readGroup(groupProviderId), PROVIDER_GROUP_ADOPT_TIMEOUT_MS)
      : await source.readGroup(groupProviderId).catch(() => undefined);
    if (config === undefined) {
      if (!hasRun || !mayReopenElsewhere(sessionId)) return null;
      // §6：启动时问不到组所在电脑照常启动；若这次启动失败，带着原路由在失败路径再读组，
      // 让老任务仍能纳入组并尝试下一台。此时不能写绑定，成功启动就继续作为普通远程任务。
      const placeholder = pendingMember(providerGroupMemberKey(null, row.providerId), row.providerId, null);
      return {
        sessionId,
        groupProviderId,
        groupDeviceId: ownerDeviceId,
        agentKind,
        model,
        member: placeholder,
        route: source.routeOf(placeholder, null),
        overrideRoute: true,
        localProviderId: null,
        pendingGroupAdoption: true,
      };
    }
    if (config === null) return null;
    if (hasRun) {
      const currentKey = await actualMemberKey(source, groupProviderId, config, row);
      const current = currentKey ? config.members.find((member) => member.key === currentKey) : undefined;
      if (!current) return null;
      if (!(await adopt(sessionId, source, groupProviderId, current.key))) return null;
      // Live session 仍在时，运行中错误交给 failover；只有需要重新打开时才让启动失败路径换下一台(要续接的
      // 原生会话换过去先带交接)，避免把正常运行中的老任务提前迁走。
      if (!mayReopenElsewhere(sessionId)) return null;
      const route = source.routeOf(current, null);
      return {
        sessionId,
        groupProviderId,
        groupDeviceId: ownerDeviceId,
        agentKind,
        model,
        member: current,
        route,
        overrideRoute: true,
        localProviderId: null,
      };
    }
    // 问不到组所在电脑(刚断线等)：照常直接连它，由那次连接给出原本的报错。
    const pick = await source.pick({ sessionId, providerId: groupProviderId, config, agentKind, model, exclude: new Set() })
      .catch((error): SourcePick => {
        deps.log.warn('provider group: asking the group computer failed', { sessionId, error: errorText(error) });
        return { kind: 'none' };
      });
    if (pick.kind === 'none') return null;
    if (pick.kind === 'unavailable') {
      deps.log.warn('provider group: no computer available for a new task', { sessionId, groupProviderId, remote: true });
      throw providerGroupUnavailableError(pick);
    }
    const route = source.routeOf(pick.member, null);
    await deps.writeBinding(sessionId, bindingFor(source, groupProviderId, pick.member.key));
    await deps.persistRoute(sessionId, route);
    deps.log.info('provider group: assigned a computer', { sessionId, groupProviderId, member: pick.member.key, remote: true });
    return {
      sessionId,
      groupProviderId,
      groupDeviceId: ownerDeviceId,
      agentKind,
      model,
      member: pick.member,
      route,
      overrideRoute: true,
      localProviderId: null,
    };
  }

  return {
    async assignBeforeStart({ sessionId, agentKind, model, startRow }) {
      const row = (await deps.readSessionRow(sessionId)) ?? startRow ?? null;
      if (!row || row.remoteHostId) return null;
      const existingBinding = deps.readBinding(sessionId);
      if (existingBinding) {
        const source = sourceFor(existingBinding.groupDeviceId);
        if (!source) return null;
        const config = await withTimeout(source.readGroup(existingBinding.providerId), PROVIDER_GROUP_ADOPT_TIMEOUT_MS)
          .catch(() => undefined);
        const hasRun = Boolean(row.sdkSessionId || (await deps.hasAssistantHistory(sessionId)));
        if (config === undefined) {
          if (!mayReopenElsewhere(sessionId)) return null;
          const member = pendingMember(
            existingBinding.memberKey,
            row.providerId ?? existingBinding.providerId,
            row.agentDeviceId,
          );
          return {
            sessionId,
            groupProviderId: existingBinding.providerId,
            groupDeviceId: source.ownerDeviceId,
            agentKind,
            model,
            member,
            route: source.routeOf(member, source.ownerDeviceId ? null : row.providerId),
            overrideRoute: source.ownerDeviceId !== null,
            localProviderId: source.ownerDeviceId ? null : row.providerId,
            pendingGroupAdoption: true,
          };
        }
        const binding = existingBinding;
        const current = await verifyBinding(sessionId, source, binding, config, row).catch((error) => {
          deps.log.warn('provider group: binding reconciliation failed', { sessionId, error: errorText(error) });
          return null;
        });
        // 从没运行过的任务(上次全部没能启动、重启应用后再打开等)：带上启动上下文，这次启动失败时仍能
        // 换组里下一台。已经运行过的任务要重新打开时同样属于启动阶段，失败后换下一台；有原生会话要续接的换过去先
        // 带交接(register 的启动重试)。
        if (!current) return null;
        if (hasRun && !mayReopenElsewhere(sessionId)) return null;
        const localProviderId = current.kind === 'local' && !source.ownerDeviceId ? row.providerId : binding.providerId;
        return {
          sessionId,
          groupProviderId: binding.providerId,
          groupDeviceId: source.ownerDeviceId,
          agentKind,
          model,
          member: current,
          route: source.routeOf(current, localProviderId),
          overrideRoute: source.ownerDeviceId !== null,
          localProviderId,
        };
      }
      // 已指定 Agent 所在电脑的任务：那台把这个供应商建成了组时由那台的组选电脑，否则不动。
      if (row.agentDeviceId) return assignFromRemoteGroup(sessionId, row, agentKind, model);
      const groupProviderId = row.providerId ?? (await deps.resolveImplicitProvider(agentKind, model));
      const config = groupProviderId ? deps.readGroup(groupProviderId) : null;
      if (!groupProviderId || !config) return null;
      // 已经运行过的任务(建组前就在用、回退或清空等清掉了原生会话)不按策略挪走：留在本机并纳入组。
      // live session 仍在时之后的运行中错误走 failover；要重新打开时这次启动失败换下一台(要续接的先带交接)。
      const hasRun = Boolean(row.sdkSessionId || (await deps.hasAssistantHistory(sessionId)));
      if (hasRun) {
        const local = config.members.find((member) => member.kind === 'local');
        if (!local) return null;
        if (!(await adopt(sessionId, localSource, groupProviderId, local.key))) return null;
        if (!mayReopenElsewhere(sessionId)) return null;
        return {
          sessionId,
          groupProviderId,
          groupDeviceId: null,
          agentKind,
          model,
          member: local,
          route: localSource.routeOf(local, row.providerId),
          overrideRoute: false,
          localProviderId: row.providerId,
        };
      }
      const pick = await localSource.pick({ sessionId, providerId: groupProviderId, config, agentKind, model, exclude: new Set() });
      if (pick.kind === 'none') return null;
      if (pick.kind === 'unavailable') {
        deps.log.warn('provider group: no computer available for a new task', { sessionId, groupProviderId });
        throw providerGroupUnavailableError(pick);
      }
      const route = localSource.routeOf(pick.member, row.providerId);
      await deps.writeBinding(sessionId, { providerId: groupProviderId, memberKey: pick.member.key });
      if (route.agentDeviceId !== null) await deps.persistRoute(sessionId, route);
      deps.log.info('provider group: assigned a computer', { sessionId, groupProviderId, member: pick.member.key });
      return {
        sessionId,
        groupProviderId,
        groupDeviceId: null,
        agentKind,
        model,
        member: pick.member,
        route,
        overrideRoute: false,
        localProviderId: row.providerId,
      };
    },

    async nextAfterStartFailure(context, error) {
      const decision = decide(context.sessionId, providerGroupFailureSignals(error), 'start', context.member.key);
      const source = sourceFor(context.groupDeviceId);
      if (decision.action !== 'switch' || !source) return null;
      const { cause } = decision;
      const config = await source.readGroup(context.groupProviderId).catch(() => undefined);
      // 启动阶段同样：组所在电脑确认组已删除时立即解除绑定，读不到不动。
      if (config === null) {
        if (!context.pendingGroupAdoption) {
          await releaseDeletedGroup(context.sessionId, groupOf(source, context.groupProviderId));
        }
        return null;
      }
      if (!config?.autoSwitch) return null;
      if (decision.cool) source.cool(context.groupProviderId, context.member.key, cause, null, context.model);
      source.invalidate(context.member);
      const tried = router.markTried(context.sessionId, context.member.key);
      const pick = await source.pick({
        sessionId: context.sessionId,
        providerId: context.groupProviderId,
        config,
        agentKind: context.agentKind,
        model: context.model,
        exclude: tried,
      });
      if (pick.kind !== 'member') {
        resetRound(context.sessionId);
        return null;
      }
      const route = source.routeOf(pick.member, context.localProviderId);
      await deps.writeBinding(context.sessionId, bindingFor(source, context.groupProviderId, pick.member.key));
      await deps.persistRoute(context.sessionId, route);
      deps.log.info('provider group: agent did not start; trying the next computer', {
        sessionId: context.sessionId,
        cause,
        to: pick.member.key,
      });
      return { ...context, member: pick.member, route, overrideRoute: true };
    },

    async resolveSwitchTarget(sessionId, target) {
      const { providerId, agentDeviceId } = target;
      if (!providerId) return null;
      const source = agentDeviceId === null
        ? (deps.readGroup(providerId) ? localSource : null)
        : (deps.remote && !isProviderShareAgentDeviceId(agentDeviceId) ? remoteSource(agentDeviceId) : null);
      if (!source) return null;
      const config = await withTimeout(source.readGroup(providerId), PROVIDER_GROUP_ADOPT_TIMEOUT_MS);
      if (!config) return null;
      const pick = await source.pick({
        sessionId,
        providerId,
        config,
        agentKind: target.agentKind,
        model: target.model,
        exclude: new Set(),
      }).catch((error): SourcePick => {
        deps.log.warn('provider group: asking the group computer failed', { sessionId, error: errorText(error) });
        return { kind: 'none' };
      });
      if (pick.kind === 'none') return null;
      if (pick.kind === 'unavailable') {
        deps.log.warn('provider group: no computer available for a task moved into the group', { sessionId, providerId });
        throw providerGroupUnavailableError(pick);
      }
      const route = source.routeOf(pick.member, source.ownerDeviceId ? null : providerId);
      if (route.agentDeviceId === target.current.agentDeviceId && route.providerId !== target.current.providerId) return null;
      deps.log.info('provider group: chose a computer for a task moved into the group', {
        sessionId,
        groupProviderId: providerId,
        member: pick.member.key,
        remote: source.ownerDeviceId !== null,
      });
      // 绑定推迟到调用方确认交接真正提交成功再写：这里先返回选中的位置，调用方还要做目标
      // 目录校验和实际交接，失败时不应该这里就持久化新绑定
      // (chatgpt-codex-connector P2, PR #5792 review)。
      return {
        ...route,
        commitBinding: () => deps.writeBinding(sessionId, bindingFor(source, providerId, pick.member.key)),
      };
    },

    mayHandleTurnError(sessionId, signals) {
      if (signals.reason === 'remote_agent_restarted') return true;
      if (decideProviderGroupFailure(signals, 'run').action !== 'switch') return false;
      const binding = deps.readBinding(sessionId);
      if (!binding) return deps.guestSwitch?.hasOffer(sessionId) === true
        || !!deps.directGuestSession?.(sessionId);
      if (binding.groupDeviceId) return deps.remote !== undefined;
      const config = deps.readGroup(binding.providerId);
      const current = config?.members.find((m) => m.key === binding.memberKey);
      // 交接只在不同电脑之间进行(switchExclusion)：组里没有别的电脑时换不了。
      return Boolean(
        config?.autoSwitch && current && config.members.some((m) => m.agentDeviceId !== current.agentDeviceId),
      );
    },

    async onTurnError(sessionId, signals, token, hooks) {
      let handled = false;
      try {
        handled = await failover(sessionId, signals, token, hooks);
      } catch (error) {
        deps.log.warn('provider group: automatic switch failed', { sessionId, error: errorText(error) });
      }
      if (handled) return;
      if (hooks?.notHandled?.()) return;
      hooks?.beforeFallback?.();
      deps.fallback(sessionId, signals, token);
    },

    async beforeSend(sessionId, options) {
      // 每次发送前重新记：上一条消息发送前换不过去的电脑不带到这一条。
      preSendFailed.delete(sessionId);
      // 用户为这一条消息确认的换号只用这一次；定时任务的发送不用它(留给用户自己那条)。
      let accepted: { memberKey: string; at: number } | undefined;
      pruneAcceptedRebalance();
      if (!options?.scheduled && options?.clientId) {
        const messages = acceptedRebalance.get(sessionId);
        accepted = messages?.get(options.clientId);
        messages?.delete(options.clientId);
        if (!messages?.size) acceptedRebalance.delete(sessionId);
      }
      if (!deps.readBinding(sessionId) || deps.isTurnRunning(sessionId)) return;
      // 读组设置也算进发送前检查的上限：组所在电脑断线或不响应时保留绑定、照常发送，不等默认的请求超时。
      const bound = await withTimeout(loadBound(sessionId), PROVIDER_GROUP_BEFORE_SEND_TIMEOUT_MS);
      if (!bound) {
        await waitBeforeSendWithoutGroup(sessionId, options);
        return;
      }
      const { binding, source, config } = bound;
      if (!config) {
        await releaseDeletedGroup(sessionId, groupOf(source, binding.providerId));
        return;
      }
      if (!config.autoSwitch && !accepted) return;
      if (!(await deps.isFailoverEligible(sessionId))) return;
      const row = await deps.readSessionRow(sessionId);
      if (!row?.model || row.remoteHostId) return;
      const current = await verifyBinding(sessionId, source, binding, config, row);
      // 本机的暂停只限制接外部新任务，本机自用仍照常检查故障并恢复。
      // 其他组员的暂停继续保持既有任务位置。
      if (!current || (current.paused && !(source.ownerDeviceId === null && current.kind === 'local'))) return;
      const cached = await source.shouldMoveAway(binding.providerId, config, current.key, row.model, row.agentKind);
      if (cached === null) return;
      // 用户确认过换号、这台也没出问题：换到确认的那台。那台出了问题时交给下面出问题换电脑的流程。
      if (cached === false && accepted && config.members.some((m) => m.key === accepted.memberKey)
        && !switchExclusion(config, current, new Set()).has(accepted.memberKey)) {
        const moved = await rebalanceBeforeSend(
          sessionId, source, binding.providerId, config, current, { ...row, model: row.model }, accepted.memberKey, options,
        );
        if (moved || options?.signal?.aborted) return;
      }
      if (!config.autoSwitch) return;
      let reason = cached ? cached.reason : null;
      const currentRoute = source.routeOf(current, row.providerId);
      const { agentDeviceId, providerId } = currentRoute;
      // 离线的先现读一次(状态可能刚恢复)；看着能用、但这次要重新打开那台电脑上的会话时也不信缓存，现读一次：
      // 连不上的话要到打开会话时才报错。
      const checkFresh = Boolean(agentDeviceId && providerId)
        && (reason === 'offline' || (reason === null && deps.hasLiveSession?.(sessionId) === false));
      if (checkFresh) {
        const fresh = (await untilAborted(
          withTimeout(deps.directory.probe(agentDeviceId!, providerId!), PROVIDER_GROUP_PROBE_TIMEOUT_MS),
          options?.signal,
        )) ?? 'offline';
        if (options?.signal?.aborted) return;
        reason = fresh === 'ok' ? null : fresh;
      }
      if (reason === null) return;
      // 离线先等它恢复(与运行中失败共用这一轮的重试次数)：恢复了照常发到原电脑，等不到再换。
      if (reason === 'offline') {
        const outcome = await waitBeforeSend(
          sessionId, currentRoute, current.key, checkFresh, options,
          () => knownDown(source, binding.providerId, current.key, currentRoute, row.model ?? undefined, row.agentKind),
        );
        if (outcome !== 'gone') return;
        options?.progress?.('switching');
      }
      const tried = router.markTried(sessionId, current.key);
      const localProviderId = current.kind === 'local' && !source.ownerDeviceId ? row.providerId : binding.providerId;
      const skipped = createSkippedTargets();
      const failedTargets: string[] = [];
      const { run, done } = trackRun(sessionId);
      const isCurrent = () => !run.superseded && options?.signal?.aborted !== true;
      try {
        for (;;) {
          if (!isCurrent()) return;
          const pick = await source.pick({
            sessionId,
            providerId: binding.providerId,
            config,
            agentKind: row.agentKind,
            model: row.model,
            exclude: skipped.exclusion(switchExclusion(config, current, tried)),
          });
          if (!isCurrent()) return;
          if (pick.kind !== 'member') {
            // 组里只剩这次因连不上而跳过的电脑：先等它们恢复再换，消息还没发出，进行中行显示「正在换一台电脑继续」。
            if (pick.kind === 'unavailable') {
              const back = await skipped.awaitAny((member) => awaitSkippedTarget(
                sessionId, source, member, localProviderId, isCurrent, () => options?.progress?.('switching'), options?.signal,
              ), isCurrent);
              if (!isCurrent()) return;
              if (back) continue;
            }
            // 没换成：照常发到原电脑。换过去失败的电脑记下来，这条消息随后失败时不再重复去试、重复去等。
            if (failedTargets.length === 0) router.resetTurn(sessionId);
            else preSendFailed.set(sessionId, { keys: failedTargets, at: deps.now() });
            return;
          }
          const route = source.routeOf(pick.member, localProviderId);
          await deps.writeBinding(sessionId, bindingFor(source, binding.providerId, pick.member.key));
          try {
            // 写绑定、交接期间用户停止(停止这次发送或「全部停止」)：交接在改动之前停下，留在原电脑。
            await deps.switchAgentLocation(sessionId, {
              agentKind: row.agentKind,
              model: row.model,
              providerId: route.providerId,
              agentDeviceId: route.agentDeviceId,
            }, { beforeSend: true, isCurrent });
            deps.log.info('provider group: moved a task before sending', {
              sessionId,
              from: current.key,
              to: pick.member.key,
              reason,
            });
            return;
          } catch (error) {
            await restoreBindingAfterFailedSwitch(sessionId, source, binding.providerId, config);
            // 与失败本身同一个判定：目标电脑的问题换下一台；与目标无关的失败(任务在运行、已删除等)照常发到原电脑。
            const target = decide(sessionId, providerGroupFailureSignals(error), 'target', pick.member.key);
            if (target.action !== 'switch' || !isCurrent()) {
              deps.log.warn('provider group: moving a task before sending failed', { sessionId, error: errorText(error) });
              if (failedTargets.length > 0 && isCurrent()) preSendFailed.set(sessionId, { keys: failedTargets, at: deps.now() });
              return;
            }
            deps.log.warn('provider group: moving a task before sending failed; trying the next one', {
              sessionId,
              member: pick.member.key,
              error: errorText(error),
            });
            if (!failedTargets.includes(pick.member.key)) failedTargets.push(pick.member.key);
            router.markTried(sessionId, pick.member.key);
            if (target.cool) source.cool(binding.providerId, pick.member.key, target.cause, null, row.model);
            skipped.failed(pick.member, isUnreachableTarget(target));
          }
        }
      } finally {
        done();
      }
    },

    async rebalanceSuggestion(sessionId) {
      const context = await rebalanceContext(sessionId);
      if (!context) return null;
      const { binding, source, config, row, current } = context;
      const target = await source.rebalanceTarget(
        binding.providerId, config, current.key, row.model, row.agentKind,
        rebalanceExclusion(source, binding.providerId, config, current),
      );
      if (!target) return null;
      const member = config.members.find((candidate) => candidate.key === target.memberKey);
      const route = member ? source.routeOf(member, row.providerId) : null;
      const ownDevices = route && !isProviderShareAgentDeviceId(row.agentDeviceId)
        && !isProviderShareAgentDeviceId(route.agentDeviceId);
      // Same-account relocation tries the native history first. The switch handler asks
      // only if it would actually need a summary, including a native resume failure.
      return { kind: ownDevices || deps.readAutoRebalance?.(sessionId) ? 'auto' : 'ask', ...target };
    },

    async rebalanceDecision(sessionId, memberKey, remember, clientId) {
      if (!clientId || !/^[A-Za-z0-9_-]{1,128}$/.test(clientId)) return false;
      const loaded = deps.readBinding(sessionId) ? await withTimeout(loadBound(sessionId), PROVIDER_GROUP_BEFORE_SEND_TIMEOUT_MS) : undefined;
      if (!loaded?.config?.members.some((m) => m.key === memberKey)) return false;
      pruneAcceptedRebalance();
      const messages = acceptedRebalance.get(sessionId) ?? new Map();
      messages.set(clientId, { memberKey, at: deps.now() });
      acceptedRebalance.set(sessionId, messages);
      if (remember) {
        try {
          await deps.writeAutoRebalance?.(sessionId);
        } catch (error) {
          // 没记住只影响以后还会再问，这次照常换。
          deps.log.warn('provider group: remembering automatic balancing failed', { sessionId, error: errorText(error) });
        }
      }
      return true;
    },

    claimGuestStartSwitch(sessionId) {
      const claimed = deps.guestSwitch?.claim(sessionId) === true;
      if (claimed) deps.log.info('provider group: reopening a shared task through the sharer’s group after it did not start', { sessionId });
      return claimed;
    },

    noteUserAction(sessionId) {
      for (const run of runningSwitches.get(sessionId) ?? []) run.superseded = true;
      resetRound(sessionId);
      deps.guestSwitch?.drop(sessionId);
    },

    async sessionGroup(sessionId) {
      const binding = deps.readBinding(sessionId);
      if (!binding) return null;
      const source = sourceFor(binding.groupDeviceId);
      const row = source ? await deps.readSessionRow(sessionId) : null;
      if (!source || !row) return null;
      const located = await locatedMemberKey(source, binding.providerId, row);
      return located === binding.memberKey
        ? { groupDeviceId: binding.groupDeviceId ?? null, providerId: binding.providerId }
        : null;
    },
  };
}
