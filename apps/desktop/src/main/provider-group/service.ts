/**
 * 供应商组接到任务生命周期上的三个点(docs/product-rules/provider-groups.md §6)：
 *
 * 1. **分配**：新任务第一次启动 Agent 前(bootstrapSession)，按组策略选一台组内电脑，把选择写回
 *    任务记录与绑定；Agent 还没开始运行就失败(连不上、登录失效、启动失败)时直接换下一台。
 * 2. **自动换电脑**：运行中因那台电脑的原因失败(终态错误)时，交接到组里下一台并继续这一轮；
 *    同一轮每台最多试一次，全部失败才交回原有的报错 / 等额度重置流程。那台是连不上(离线、断线)时先等它
 *    恢复：按退避最多重试 5 次，恢复了就留在原电脑继续，都不行再换。别的电脑上的组读不到(常见是任务就在组所在
 *    电脑上、它自己断了)时换不了电脑，只等任务所在那台恢复。
 * 3. **发送前**：已归组的任务所在那台现在不能用时，先交接到下一台，这条消息直接发到新电脑；离线时同样先等。
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
  ProviderGroupRemoteCoolCause,
  ProviderGroupRemotePick,
  ProviderGroupView,
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
import {
  PROVIDER_GROUP_DEFAULT_COOLDOWN_MS,
  PROVIDER_GROUP_FAILURE_COOLDOWN_MS,
  PROVIDER_GROUP_TURN_WINDOW_MS,
  type ProviderGroupRouter,
} from './router.js';
import {
  classifyProviderGroupSwitchCause,
  isProviderGroupConnectionLoss,
  type ProviderGroupSwitchCause,
} from './switchCause.js';

/** 换电脑途中用户已接手：交接在改动之前停下(不是目标电脑的问题)。 */
export const PROVIDER_GROUP_SUPERSEDED_ERROR = 'provider group: superseded by user action';

/** 组里没有能接这个任务的电脑(本机任务的错误码，渲染端按 chat.remoteError 给文案)。 */
export const PROVIDER_GROUP_UNAVAILABLE_ERROR =
  '[REMOTE_AGENT_GROUP_UNAVAILABLE] no computer in the provider group can run this task right now';

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
  }): Promise<ProviderGroupRemotePick>;
  cool(ownerDeviceId: string, input: {
    providerId: string;
    memberKey: string;
    cause: ProviderGroupRemoteCoolCause;
    resetAt: number | null;
  }): Promise<void>;
  view(ownerDeviceId: string, providerId: string): Promise<ProviderGroupView>;
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
    /** `relocate`：位置不变也重新交接、新建会话(分享的人换电脑，实际运行的电脑由组所在电脑重新选)。 */
    options?: { beforeSend?: boolean; isCurrent?: () => boolean; relocate?: boolean },
  ): Promise<void>;
  /**
   * 分享的人这边的「需要换一台」凭证(guestSwitch.ts)；不提供 = 分享来的供应商出错时一律交回原有处理。
   */
  guestSwitch?: Pick<ProviderGroupGuestSwitch, 'hasOffer' | 'claim' | 'release' | 'drop'>;
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
  /** 用户亲自接手：这一轮重新从头试。 */
  noteUserAction(sessionId: string): void;
}

export interface ProviderGroupBeforeSendOptions {
  /** 这次发送被停止或取消：等原电脑恢复时就此停下，不再换电脑。 */
  signal?: AbortSignal;
  /** 等原电脑恢复的进度(第几次重试)；`switching` = 没等到，开始换电脑。 */
  progress?(state: { attempt: number; maxAttempts: number } | 'switching'): void;
}

/** 一次终态错误的处理结局(调用方据此结算换电脑期间先不呈现的那次错误)。 */
export interface ProviderGroupTurnErrorHooks {
  /** 不换了，马上交回原有处理(报错与额度重置后自动继续)：先把错误放出来。 */
  beforeFallback?(): void;
  /** 已换到另一台电脑(或原电脑恢复后在原电脑)续上了这一轮。 */
  resumed?(): void;
  /** 原电脑连不上，先等它恢复：开始第 attempt 次重试(从 1 起)。 */
  reconnecting?(attempt: number, maxAttempts: number): void;
  /** 等过原电脑但没等到，开始换电脑。 */
  switching?(): void;
}

/** 发送前检查组内电脑状态的上限：读不到就照常发送，不让一台卡住的电脑拖慢每次发送。 */
export const PROVIDER_GROUP_BEFORE_SEND_TIMEOUT_MS = 3_000;

/**
 * 那台连不上时，换电脑前先等它恢复：同一轮每台最多重试几次。两次之间的等待与中断自愈相同
 * (约 3、6、12、20、20 秒，合计约一分钟)。
 */
export const PROVIDER_GROUP_RECONNECT_MAX_ATTEMPTS = 5;

/** 现读那台状态的上限：读不到按连不上算。 */
export const PROVIDER_GROUP_PROBE_TIMEOUT_MS = 10_000;

/** 纳入老任务时问组所在电脑的上限：读不到就照常启动 / 交回原有处理，出错时再补。 */
export const PROVIDER_GROUP_ADOPT_TIMEOUT_MS = 3_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : '';
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.catch(() => null),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

type SourcePick =
  | { kind: 'none' }
  | { kind: 'unavailable' }
  | { kind: 'member'; member: ProviderGroupMember; label: string; labelOf(memberKey: string): string | undefined };

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
  }): Promise<SourcePick>;
  cool(providerId: string, memberKey: string, cause: ProviderGroupSwitchCause, resetAt: number | null): void;
  /** 发送前：这台现在该不该换掉；null = 读不到，照常发送。 */
  shouldMoveAway(providerId: string, config: ProviderGroupConfig, memberKey: string): Promise<{ reason: string } | false | null>;
  invalidate(member: ProviderGroupMember): void;
  /** 任务记录里 Agent 的位置对应组里哪一项(组所在电脑视角的键)；不对应任何组员返回 null。 */
  memberKeyOf(groupProviderId: string, row: ProviderGroupSessionRow): Promise<string | null>;
  /** 组员 → 本机启动参数里的位置。 */
  routeOf(member: ProviderGroupMember, localProviderId: string | null): ProviderGroupRoute;
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
   * 这一轮等过原电脑几次：每台各算，运行中失败与发送前共用一份，那台反复掉线也不会无休止地等下去。
   * 用户接手即重新计；距上一次重试超过一轮的时限(30 分钟)也重新计。
   */
  const reconnects = new Map<string, { memberKey: string; used: number; at: number }>();
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

  /** 记一次等原电脑的重试，返回这是第几次；这一轮已用完返回 null。 */
  function nextReconnectAttempt(sessionId: string, memberKey: string): number | null {
    const now = deps.now();
    const previous = reconnects.get(sessionId);
    const used = previous && previous.memberKey === memberKey && now - previous.at <= PROVIDER_GROUP_TURN_WINDOW_MS
      ? previous.used
      : 0;
    if (used >= PROVIDER_GROUP_RECONNECT_MAX_ATTEMPTS) return null;
    reconnects.set(sessionId, { memberKey, used: used + 1, at: now });
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
      /**
       * 这次失败只是连接断了：现读第一次就已连得上，也算一次重试、留在原电脑继续(断线刚好已恢复)，
       * 不当成「问题不在连接」直接换。次数照算，那台反复断也只这 5 次。
       */
      connectionLost?: boolean;
      /** 发送被停止：退避与现读都立刻停下。 */
      signal?: AbortSignal;
    },
  ): Promise<ReturnOutcome> {
    const { agentDeviceId, providerId } = route;
    if (!agentDeviceId || !providerId) return 'gone';
    const signal = options?.signal;
    const current = () => isCurrent() && signal?.aborted !== true;
    const probe = async () =>
      (await untilAborted(
        withTimeout(deps.directory.probe(agentDeviceId, providerId), PROVIDER_GROUP_PROBE_TIMEOUT_MS),
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

  function coolUntil(cause: ProviderGroupSwitchCause, resetAt: number | null): number {
    const now = deps.now();
    return cause === 'usage-limit'
      ? (resetAt !== null && resetAt > now ? resetAt : now + PROVIDER_GROUP_DEFAULT_COOLDOWN_MS)
      : now + PROVIDER_GROUP_FAILURE_COOLDOWN_MS;
  }

  const localSource: GroupSource = {
    ownerDeviceId: null,
    async readGroup(providerId) {
      return deps.readGroup(providerId);
    },
    async pick({ providerId, agentKind, model, exclude }) {
      const pick = await router.pick({ providerId, agentKind, model, exclude });
      if (pick.kind !== 'member') return { kind: pick.kind };
      return {
        kind: 'member',
        member: pick.member,
        label: pick.label,
        labelOf: (key) => pick.resolved.find((r) => r.member.key === key)?.label,
      };
    },
    cool(providerId, memberKey, cause, resetAt) {
      // 连不上只在这一轮避开，不把本机的连接故障扩散成后续全局冷却；
      // 其它原因(额度、登录、过载)仍按组的冷却策略处理。
      if (cause === 'unavailable') return;
      router.markCooling(providerId, memberKey, coolUntil(cause, resetAt));
    },
    async shouldMoveAway(providerId, config, memberKey) {
      const resolved = await withTimeout(deps.directory.resolveMembers(providerId, config), PROVIDER_GROUP_BEFORE_SEND_TIMEOUT_MS);
      const state = resolved?.find((r) => r.member.key === memberKey);
      if (!state) return null;
      const cooling = router.coolingUntil(providerId, memberKey) !== null;
      if (state.state === 'ok' && !cooling) return false;
      return { reason: cooling ? 'cooling' : state.state };
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
      async pick({ sessionId, providerId, config, agentKind, model, exclude }) {
        const pick = await remote.pick(ownerDeviceId, {
          sessionId,
          providerId,
          agentKind: agentKind as 'claude-code' | 'codex' | 'pi',
          model,
          exclude: [...exclude],
        });
        if (pick.kind !== 'member') return { kind: pick.kind };
        const labelOf = (key: string) => {
          const found = config.members.find((m) => m.key === key);
          return found ? deps.directory.memberLabel(found) || undefined : undefined;
        };
        // 组设置以组所在电脑为准；本机读到的那份可能稍旧，缺的组员按回包补齐。
        const member = config.members.find((m) => m.key === pick.member.key)
          ?? { ...pick.member, limit: 1, weight: 1, paused: false };
        return { kind: 'member', member, label: pick.label, labelOf };
      },
      cool(providerId, memberKey, cause, resetAt) {
        // 连不上只由发现它的这台电脑自己避开(这一轮已试过)，不替全组判断：可能只是这台连不过去。
        if (cause === 'unavailable') return;
        void remote.cool(ownerDeviceId, { providerId, memberKey, cause, resetAt }).catch((error) => {
          deps.log.warn('provider group: reporting a computer to cool down failed', { error: errorText(error) });
        });
      },
      async shouldMoveAway(providerId, _config, memberKey) {
        const view = await withTimeout(remote.view(ownerDeviceId, providerId), PROVIDER_GROUP_BEFORE_SEND_TIMEOUT_MS);
        const state = view?.members.find((m) => m.key === memberKey)?.state;
        if (!state) return null;
        return state === 'offline' || state === 'unavailable' || state === 'cooling' ? { reason: state } : false;
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
   * 以任务记录为准核对绑定：用户手动把任务挪到了别处时修正或解除绑定，并返回 null——之后的自动换电脑
   * 不能覆盖用户的选择，也不能把别处的失败记到组内电脑头上。一致时返回当前组内电脑。
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
    if (key !== binding.memberKey) {
      await deps.writeBinding(sessionId, bindingFor(source, binding.providerId, key));
      return null;
    }
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
   * 有效的令牌。
   */
  async function withSwitchRun(
    sessionId: string,
    signals: InterruptedTurnErrorSignals,
    token: number,
    lease: object,
    hooks: ProviderGroupTurnErrorHooks | undefined,
    body: (isCurrent: () => boolean, handBack: () => void) => Promise<void>,
  ): Promise<void> {
    const { run, done } = trackRun(sessionId);
    const isCurrent = () => !run.superseded && deps.isLeaseCurrent(sessionId, lease);
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
    } finally {
      done();
    }
  }

  /** true = 已由本机制处理(含它自己交回原有处理)；false = 不归它管，调用方照常交回。 */
  async function failover(
    sessionId: string,
    signals: InterruptedTurnErrorSignals,
    token: number,
    hooks: ProviderGroupTurnErrorHooks | undefined,
  ): Promise<boolean> {
    const cause = classifyProviderGroupSwitchCause(signals);
    if (!cause) return false;
    if (!deps.readBinding(sessionId) && !(await adoptOnFailure(sessionId))) {
      return guestFailover(sessionId, signals, token, cause, hooks);
    }
    const bound = await loadBound(sessionId);
    if (!bound) return cause === 'unavailable' ? reconnectWithoutGroup(sessionId, signals, token, hooks) : false;
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
    // 交接会关闭旧会话(关闭撤销限额等待)：先取得这次错误的重试入口。用户已接手时什么都不做。
    const lease = deps.leaseRecovery(sessionId, token);
    if (!lease) return true;
    const boundRow = { ...row, model: row.model };
    await withSwitchRun(sessionId, signals, token, lease, hooks, async (isCurrent, handBack) => {
      // 连不上先等那台恢复：恢复了留在原电脑继续这一轮(不交接)，等不到再换。
      if (cause === 'unavailable') {
        let waited = false;
        const route = source.routeOf(current, row.providerId);
        const outcome = await awaitReturn(sessionId, route, current.key, isCurrent, (attempt) => {
          waited = true;
          hooks?.reconnecting?.(attempt, PROVIDER_GROUP_RECONNECT_MAX_ATTEMPTS);
        }, { connectionLost: isProviderGroupConnectionLoss(signals) });
        if (outcome === 'stopped') return;
        if (outcome === 'back') {
          await continueOnSameComputer(sessionId, deps.directory.memberLabel(current), lease, isCurrent, hooks);
          return;
        }
        if (waited) hooks?.switching?.();
      }
      await switchUntilSettled({
        sessionId, signals, cause, binding, source, config, row: boundRow, current, lease, isCurrent, handBack, hooks,
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
    hooks: ProviderGroupTurnErrorHooks | undefined,
  ): Promise<boolean> {
    const binding = deps.readBinding(sessionId);
    if (!binding?.groupDeviceId || !deps.remote) return false;
    if (!(await deps.isFailoverEligible(sessionId))) return false;
    const row = await deps.readSessionRow(sessionId);
    if (!row?.model || row.remoteHostId || !row.agentDeviceId || !row.providerId) return false;
    const route = { agentDeviceId: row.agentDeviceId, providerId: row.providerId };
    const lease = deps.leaseRecovery(sessionId, token);
    if (!lease) return true;
    await withSwitchRun(sessionId, signals, token, lease, hooks, async (isCurrent, handBack) => {
      const outcome = await awaitReturn(sessionId, route, binding.memberKey, isCurrent, (attempt) => {
        hooks?.reconnecting?.(attempt, PROVIDER_GROUP_RECONNECT_MAX_ATTEMPTS);
      }, { connectionLost: isProviderGroupConnectionLoss(signals) });
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

  /** 发送前等那台恢复(这条还没派出去)：进度交给调用方显示；发送被停止或用户接手时停下。 */
  async function waitBeforeSend(
    sessionId: string,
    route: ProviderGroupRoute,
    memberKey: string,
    knownOffline: boolean,
    options: ProviderGroupBeforeSendOptions | undefined,
  ): Promise<ReturnOutcome> {
    const { run, done } = trackRun(sessionId);
    try {
      return await awaitReturn(sessionId, route, memberKey, () => !run.superseded, (attempt) => {
        options?.progress?.({ attempt, maxAttempts: PROVIDER_GROUP_RECONNECT_MAX_ATTEMPTS });
      }, { knownOffline, ...(options?.signal ? { signal: options.signal } : {}) });
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
    await waitBeforeSend(
      sessionId,
      { agentDeviceId: row.agentDeviceId, providerId: row.providerId },
      binding.memberKey,
      false,
      options,
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
    cause: ProviderGroupSwitchCause,
    hooks: ProviderGroupTurnErrorHooks | undefined,
  ): Promise<boolean> {
    const guestSwitch = deps.guestSwitch;
    if (!guestSwitch) return false;
    const row = await deps.readSessionRow(sessionId);
    const shareRoute = row?.agentDeviceId;
    if (!row?.model || row.remoteHostId || !shareRoute || !isProviderShareAgentDeviceId(shareRoute)) return false;
    if (!(await deps.isFailoverEligible(sessionId))) return false;
    if (!guestSwitch.claim(sessionId)) return false;
    const lease = deps.leaseRecovery(sessionId, token);
    if (!lease) {
      guestSwitch.release(sessionId);
      return true;
    }
    const model = row.model;
    await withSwitchRun(sessionId, signals, token, lease, hooks, async (isCurrent, handBack) => {
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
    cause: ProviderGroupSwitchCause;
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
    const { sessionId, signals, cause, binding, source, config, row, current, lease, isCurrent, handBack, hooks } = input;
    source.cool(binding.providerId, current.key, cause, deps.readResetAt(signals));
    source.invalidate(current);
    const tried = router.markTried(sessionId, current.key);
    // 换回本机时：原本就在本机的保留原来的来源写法(可能是隐式来源)，否则用组所属的供应商。
    const localProviderId = current.kind === 'local' ? row.providerId : binding.providerId;
    // 分享来的电脑用分享者的昵称(不用电脑名)；读不到时为空，活动记录退回不写电脑的说法。
    let fromLabel = deps.directory.memberLabel(current);

    for (;;) {
      if (!isCurrent()) return;
      const pick = await source.pick({
        sessionId,
        providerId: binding.providerId,
        config,
        agentKind: row.agentKind,
        model: row.model,
        exclude: switchExclusion(config, current, tried),
      });
      // 选电脑期间用户已接手：绑定与任务记录都还没动，直接停下。
      if (!isCurrent()) return;
      if (pick.kind !== 'member') {
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
        // 只有目标电脑本身的问题(连不上、分享暂停、Agent 起不来等)才记到它头上并换下一台；任务在运行、
        // 已删除、用户已接手等与目标无关的失败直接结束，不冷却任何电脑。
        const targetCause = classifyProviderGroupSwitchCause({ message: errorText(error) });
        if (!targetCause || !isCurrent()) {
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
        source.cool(binding.providerId, pick.member.key, targetCause, null);
        continue;
      }
      deps.log.info('provider group: switched computer', { sessionId, cause, to: pick.member.key });
      // 交接期间用户已接手(发消息、重试、换模型、收下错误)：不替用户续跑。
      if (!isCurrent()) return;
      const continueToken = deps.rearmContinue(sessionId, lease, deps.now());
      if (continueToken === null) return;
      const outcome = await deps.continueSession(sessionId, continueToken, {
        reason: USAGE_LIMIT_RESET_AUTO_RESUME_REASON,
        attempt: 1,
        maxAttempts: 1,
        sessionTotal: 0,
        agentSwitch: { from: fromLabel, to: pick.label, cause },
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
    // 但如果原生会话已经不存在(例如远程电脑刚断线、旧句柄已被清理)，这次打开仍然是
    // 启动阶段：保留原绑定并返回启动上下文，让 bootstrap 失败时能自动试组内下一台。
    // 问不到组所在电脑时照常启动，出错时再补。
    const hasRun = Boolean(row.sdkSessionId || (await deps.hasAssistantHistory(sessionId)));
    // 已经明确解除过这个组的老任务不再询问组所在电脑，也不自动纳回。
    if (hasRun && deps.isReleased(sessionId, groupOf(source, groupProviderId))) return null;
    const config = hasRun
      ? await withTimeout(source.readGroup(groupProviderId), PROVIDER_GROUP_ADOPT_TIMEOUT_MS)
      : await source.readGroup(groupProviderId).catch(() => undefined);
    if (config === undefined) {
      if (!hasRun || deps.hasLiveSession?.(sessionId) !== false) return null;
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
      // Live session 仍在时，运行中错误交给 failover；只有需要重新打开时才让启动
      // 失败路径直接换下一台，避免把正常运行中的老任务提前迁走。
      if (deps.hasLiveSession?.(sessionId) !== false) return null;
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
      throw new Error(PROVIDER_GROUP_UNAVAILABLE_ERROR);
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
          if (deps.hasLiveSession?.(sessionId) !== false) return null;
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
        // 换组里下一台。已经运行过的任务在原来那台上有原生会话，换电脑要走交接；原生会话已经
        // 不在时则仍属于启动阶段，失败后直接换下一台。
        if (!current) return null;
        if (hasRun && deps.hasLiveSession?.(sessionId) !== false) return null;
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
      // live session 仍在时之后的运行中错误走 failover；会话已经被清掉时，这次启动失败要能直接换下一台。
      const hasRun = Boolean(row.sdkSessionId || (await deps.hasAssistantHistory(sessionId)));
      if (hasRun) {
        const local = config.members.find((member) => member.kind === 'local');
        if (!local) return null;
        if (!(await adopt(sessionId, localSource, groupProviderId, local.key))) return null;
        if (deps.hasLiveSession?.(sessionId) !== false) return null;
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
        throw new Error(PROVIDER_GROUP_UNAVAILABLE_ERROR);
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
      const cause = classifyProviderGroupSwitchCause({ message: errorText(error) })
        ?? (/not authenticated|login/i.test(errorText(error)) ? 'auth' : null);
      const source = sourceFor(context.groupDeviceId);
      if (!cause || !source) return null;
      const config = await source.readGroup(context.groupProviderId).catch(() => undefined);
      // 启动阶段同样：组所在电脑确认组已删除时立即解除绑定，读不到不动。
      if (config === null) {
        if (!context.pendingGroupAdoption) {
          await releaseDeletedGroup(context.sessionId, groupOf(source, context.groupProviderId));
        }
        return null;
      }
      if (!config?.autoSwitch) return null;
      source.cool(context.groupProviderId, context.member.key, cause, null);
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

    mayHandleTurnError(sessionId, signals) {
      if (!classifyProviderGroupSwitchCause(signals)) return false;
      const binding = deps.readBinding(sessionId);
      if (!binding) return deps.guestSwitch?.hasOffer(sessionId) === true;
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
      hooks?.beforeFallback?.();
      deps.fallback(sessionId, signals, token);
    },

    async beforeSend(sessionId, options) {
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
      if (!config.autoSwitch) return;
      if (!(await deps.isFailoverEligible(sessionId))) return;
      const row = await deps.readSessionRow(sessionId);
      if (!row?.model || row.remoteHostId) return;
      const current = await verifyBinding(sessionId, source, binding, config, row);
      // 暂停分配只影响新任务，已在那台的任务不挪走。
      if (!current || current.paused) return;
      const cached = await source.shouldMoveAway(binding.providerId, config, current.key);
      if (cached === null) return;
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
        const outcome = await waitBeforeSend(sessionId, currentRoute, current.key, checkFresh, options);
        if (outcome !== 'gone') return;
        options?.progress?.('switching');
      }
      const tried = router.markTried(sessionId, current.key);
      const pick = await source.pick({
        sessionId,
        providerId: binding.providerId,
        config,
        agentKind: row.agentKind,
        model: row.model,
        exclude: switchExclusion(config, current, tried),
      });
      if (pick.kind !== 'member') {
        router.resetTurn(sessionId);
        return;
      }
      const localProviderId = current.kind === 'local' && !source.ownerDeviceId ? row.providerId : binding.providerId;
      const route = source.routeOf(pick.member, localProviderId);
      await deps.writeBinding(sessionId, bindingFor(source, binding.providerId, pick.member.key));
      try {
        await deps.switchAgentLocation(sessionId, {
          agentKind: row.agentKind,
          model: row.model,
          providerId: route.providerId,
          agentDeviceId: route.agentDeviceId,
        }, { beforeSend: true });
        deps.log.info('provider group: moved a task before sending', {
          sessionId,
          from: current.key,
          to: pick.member.key,
          reason,
        });
      } catch (error) {
        await restoreBindingAfterFailedSwitch(sessionId, source, binding.providerId, config);
        deps.log.warn('provider group: moving a task before sending failed', { sessionId, error: errorText(error) });
      }
    },

    noteUserAction(sessionId) {
      for (const run of runningSwitches.get(sessionId) ?? []) run.superseded = true;
      resetRound(sessionId);
      deps.guestSwitch?.drop(sessionId);
    },
  };
}
