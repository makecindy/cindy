/**
 * 供应商组接到任务生命周期上的三个点(docs/product-rules/provider-groups.md §6)：
 *
 * 1. **分配**：新任务第一次启动 Agent 前(bootstrapSession)，按组策略选一台组内电脑，把选择写回
 *    任务记录与绑定；Agent 还没开始运行就失败(连不上、登录失效、启动失败)时直接换下一台。
 * 2. **自动换电脑**：运行中因那台电脑的原因失败(终态错误)时，交接到组里下一台并继续这一轮；
 *    同一轮每台最多试一次，全部失败才交回原有的报错 / 等额度重置流程。
 * 3. **发送前**：已归组的任务所在那台现在不能用时，先交接到下一台，这条消息直接发到新电脑。
 *
 * 依赖全部注入，由 maker-ipc/register 装配；这里不直接碰数据库、会话与输入协调器。
 */
import type { AgentKind } from '@cindy/maker-core';

import {
  USAGE_LIMIT_RESET_AUTO_RESUME_REASON,
  type AutoResumeInfo,
} from '../../shared/agentInputQueue.js';
import type { ProviderGroupConfig, ProviderGroupMember } from '../../shared/providerGroup.js';
import { providerGroupMemberKey } from '../../shared/providerGroup.js';
import type { InterruptedTurnErrorSignals } from '../maker-ipc/interruptedTurnAutoResume.js';
import type { ProviderGroupBinding } from './bindings.js';
import type { ProviderGroupDirectory } from './directory.js';
import {
  PROVIDER_GROUP_DEFAULT_COOLDOWN_MS,
  PROVIDER_GROUP_FAILURE_COOLDOWN_MS,
  type ProviderGroupRouter,
} from './router.js';
import { classifyProviderGroupSwitchCause, type ProviderGroupSwitchCause } from './switchCause.js';

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
  agentKind: AgentKind;
  model: string;
  member: ProviderGroupMember;
  route: ProviderGroupRoute;
  /** 任务原本的(本机)来源，换回本机时还原。 */
  localProviderId: string | null;
}

interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface ProviderGroupServiceDeps {
  router: ProviderGroupRouter;
  directory: ProviderGroupDirectory;
  readGroup(providerId: string): ProviderGroupConfig | null;
  readBinding(sessionId: string): ProviderGroupBinding | null;
  writeBinding(sessionId: string, binding: { providerId: string; memberKey: string } | null): Promise<void>;
  readSessionRow(sessionId: string): Promise<ProviderGroupSessionRow | null>;
  /** 隐式来源(provider_id 为空)时本机实际会用的来源。 */
  resolveImplicitProvider(agentKind: AgentKind, model: string): Promise<string | null>;
  /** 把 Agent 运行位置写回任务记录。 */
  persistRoute(sessionId: string, route: ProviderGroupRoute): Promise<void>;
  /** 这个任务是否已经有过 Agent 的回复(用来判断它是不是从没运行过)。 */
  hasAssistantHistory(sessionId: string): Promise<boolean>;

  /** 是否由本机制接管这次失败(排除目标模式、Orca worker、伙伴、共享中的任务等)。 */
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
    options?: { beforeSend?: boolean; isCurrent?: () => boolean },
  ): Promise<void>;
  /** 这个任务现在是否正在运行一轮。 */
  isTurnRunning(sessionId: string): boolean;
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
  log: Logger;
}

export interface ProviderGroupService {
  /**
   * 新任务启动 Agent 前调用：需要分配时返回选中的位置(调用方据此改启动参数)，不归组管返回 null。
   * 组里没有能用的电脑时抛 PROVIDER_GROUP_UNAVAILABLE_ERROR。
   */
  assignBeforeStart(input: { sessionId: string; agentKind: AgentKind; model: string }): Promise<ProviderGroupStartContext | null>;
  /** 分配后 Agent 没能启动：换下一台，返回新的位置；不该换或没有下一台返回 null(调用方照常报错)。 */
  nextAfterStartFailure(context: ProviderGroupStartContext, error: unknown): Promise<ProviderGroupStartContext | null>;
  /** 运行中的终态错误(输入协调器保留了重试入口)。 */
  onTurnError(sessionId: string, signals: InterruptedTurnErrorSignals, token: number): void;
  /**
   * 发送前：已归组的任务所在那台现在不能用(离线、分享暂停、供应商关掉、冷却中)时，先交接到组里下一台，
   * 这条消息直接发到新电脑。读不到状态或没有下一台时不动，照常发送。
   */
  beforeSend(sessionId: string): Promise<void>;
  /** 用户亲自接手：这一轮重新从头试。 */
  noteUserAction(sessionId: string): void;
}

/** 发送前检查组内电脑状态的上限：读不到就照常发送，不让一台卡住的电脑拖慢每次发送。 */
export const PROVIDER_GROUP_BEFORE_SEND_TIMEOUT_MS = 3_000;

function memberRoute(member: ProviderGroupMember, localProviderId: string | null): ProviderGroupRoute {
  return member.kind === 'local'
    ? { agentDeviceId: null, providerId: localProviderId }
    : { agentDeviceId: member.agentDeviceId, providerId: member.providerId };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : '';
}

export function createProviderGroupService(deps: ProviderGroupServiceDeps): ProviderGroupService {
  const { router } = deps;
  /** 进行中的自动换电脑：用户亲自接手(发消息、重试、换模型)时标记作废。只在换电脑期间登记。 */
  const runningSwitches = new Map<string, Set<{ superseded: boolean }>>();

  /** 任务记录里 Agent 实际所在位置对应的组内电脑键；不在组里返回 null。 */
  async function actualMemberKey(
    groupProviderId: string,
    config: ProviderGroupConfig,
    row: ProviderGroupSessionRow,
  ): Promise<string | null> {
    if (row.remoteHostId) return null;
    let key: string | null;
    if (row.agentDeviceId) {
      key = row.providerId ? providerGroupMemberKey(row.agentDeviceId, row.providerId) : null;
    } else {
      const provider = row.providerId
        ?? (row.model ? await deps.resolveImplicitProvider(row.agentKind, row.model) : null);
      key = provider === groupProviderId ? providerGroupMemberKey(null, provider) : null;
    }
    return key !== null && config.members.some((m) => m.key === key) ? key : null;
  }

  /**
   * 以任务记录为准核对绑定：用户手动把任务挪到了别处时修正或解除绑定，并返回 null——之后的自动换电脑
   * 不能覆盖用户的选择，也不能把别处的失败记到组内电脑头上。一致时返回当前组内电脑。
   */
  async function verifyBinding(
    sessionId: string,
    binding: ProviderGroupBinding,
    config: ProviderGroupConfig | null,
    row: ProviderGroupSessionRow,
  ): Promise<ProviderGroupMember | null> {
    const key = config ? await actualMemberKey(binding.providerId, config, row) : null;
    if (key === null) {
      await deps.writeBinding(sessionId, null);
      return null;
    }
    if (key !== binding.memberKey) {
      await deps.writeBinding(sessionId, { providerId: binding.providerId, memberKey: key });
      return null;
    }
    return config!.members.find((m) => m.key === key) ?? null;
  }

  function cool(providerId: string, memberKey: string, cause: ProviderGroupSwitchCause, resetAt: number | null): void {
    const now = deps.now();
    const until = cause === 'usage-limit'
      ? (resetAt !== null && resetAt > now ? resetAt : now + PROVIDER_GROUP_DEFAULT_COOLDOWN_MS)
      : now + PROVIDER_GROUP_FAILURE_COOLDOWN_MS;
    router.markCooling(providerId, memberKey, until);
  }

  async function pickNext(
    groupProviderId: string,
    agentKind: AgentKind,
    model: string,
    exclude: ReadonlySet<string>,
  ) {
    return router.pick({ providerId: groupProviderId, agentKind, model, exclude });
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
    groupProviderId: string,
    config: ProviderGroupConfig,
  ): Promise<void> {
    const row = await deps.readSessionRow(sessionId);
    const key = row ? await actualMemberKey(groupProviderId, config, row) : null;
    await deps.writeBinding(sessionId, key ? { providerId: groupProviderId, memberKey: key } : null);
  }

  /** true = 已由本机制处理(含它自己交回原有处理)；false = 不归它管，调用方照常交回。 */
  async function failover(sessionId: string, signals: InterruptedTurnErrorSignals, token: number): Promise<boolean> {
    const binding = deps.readBinding(sessionId);
    const cause = classifyProviderGroupSwitchCause(signals);
    if (!binding || !cause) return false;
    const config = deps.readGroup(binding.providerId);
    if (!config?.autoSwitch) return false;
    if (!(await deps.isFailoverEligible(sessionId))) return false;
    const row = await deps.readSessionRow(sessionId);
    if (!row?.model || row.remoteHostId) return false;
    const current = await verifyBinding(sessionId, binding, config, row);
    if (!current) return false;
    // 交接会关闭旧会话(关闭撤销限额等待)：先取得这次错误的重试入口。用户已接手时什么都不做。
    const lease = deps.leaseRecovery(sessionId, token);
    if (!lease) return true;
    // 用户在换电脑途中接手(重试、发消息、换模型)或那次错误已不是当前状态：之后的每一步都停手。
    const run = { superseded: false };
    const runs = runningSwitches.get(sessionId) ?? new Set();
    runs.add(run);
    runningSwitches.set(sessionId, runs);
    const isCurrent = () => !run.superseded && deps.isLeaseCurrent(sessionId, lease);
    // 不再换电脑时交回原有的报错与额度重置后自动继续；之前的交接若已关掉旧会话，换一个对当前状态有效的令牌。
    const handBack = () => {
      if (!isCurrent()) return;
      const fallbackToken = deps.leaseRecovery(sessionId, token) ? token : deps.rearmContinue(sessionId, lease, null);
      if (fallbackToken !== null) deps.fallback(sessionId, signals, fallbackToken);
    };
    try {
      await switchUntilSettled({
        sessionId, signals, cause, binding, config, row: { ...row, model: row.model }, current, lease, isCurrent, handBack,
      });
    } catch (error) {
      deps.log.warn('provider group: automatic switch failed', { sessionId, error: errorText(error) });
      handBack();
    } finally {
      runs.delete(run);
      if (runs.size === 0 && runningSwitches.get(sessionId) === runs) runningSwitches.delete(sessionId);
    }
    return true;
  }

  async function switchUntilSettled(input: {
    sessionId: string;
    signals: InterruptedTurnErrorSignals;
    cause: ProviderGroupSwitchCause;
    binding: ProviderGroupBinding;
    config: ProviderGroupConfig;
    row: ProviderGroupSessionRow & { model: string };
    current: ProviderGroupMember;
    lease: object;
    isCurrent: () => boolean;
    handBack: () => void;
  }): Promise<void> {
    const { sessionId, signals, cause, binding, config, row, current, lease, isCurrent, handBack } = input;
    cool(binding.providerId, current.key, cause, deps.readResetAt(signals));
    deps.directory.invalidate(current.agentDeviceId ?? undefined);
    const tried = router.markTried(sessionId, current.key);
    // 换回本机时：原本就在本机的保留原来的来源写法(可能是隐式来源)，否则用组所属的供应商。
    const localProviderId = current.kind === 'local' ? row.providerId : binding.providerId;
    let fromLabel = current.label ?? current.key;

    for (;;) {
      if (!isCurrent()) return;
      const pick = await pickNext(binding.providerId, row.agentKind, row.model, switchExclusion(config, current, tried));
      // 选电脑期间用户已接手：绑定与任务记录都还没动，直接停下。
      if (!isCurrent()) return;
      if (pick.kind !== 'none') {
        fromLabel = pick.resolved.find((r) => r.member.key === current.key)?.label ?? fromLabel;
      }
      if (pick.kind !== 'member') {
        deps.log.info('provider group: no computer left to switch to', { sessionId, cause, tried: tried.size });
        router.resetTurn(sessionId);
        handBack();
        return;
      }
      const route = memberRoute(pick.member, localProviderId);
      // 先写绑定再交接：交接会重建会话，分配入口据绑定认出它已归组，不会重新分配。
      await deps.writeBinding(sessionId, { providerId: binding.providerId, memberKey: pick.member.key });
      try {
        await deps.switchAgentLocation(sessionId, {
          agentKind: row.agentKind,
          model: row.model,
          providerId: route.providerId,
          agentDeviceId: route.agentDeviceId,
        }, { isCurrent });
      } catch (error) {
        await restoreBindingAfterFailedSwitch(sessionId, binding.providerId, config);
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
        cool(binding.providerId, pick.member.key, targetCause, null);
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
      if (outcome !== 'resumed') deps.cancelContinue(sessionId, continueToken);
      return;
    }
  }

  return {
    async assignBeforeStart({ sessionId, agentKind, model }) {
      const row = await deps.readSessionRow(sessionId);
      if (!row || row.remoteHostId) return null;
      const binding = deps.readBinding(sessionId);
      if (binding) {
        const config = deps.readGroup(binding.providerId);
        const current = await verifyBinding(sessionId, binding, config, row).catch((error) => {
          deps.log.warn('provider group: binding reconciliation failed', { sessionId, error: errorText(error) });
          return null;
        });
        // 从没运行过的任务(上次全部没能启动、重启应用后再打开等)：带上启动上下文，这次启动失败时仍能
        // 换组里下一台。已经运行过的任务在原来那台上有原生会话，换电脑要走交接，不在这里换。
        if (!current || row.sdkSessionId || (await deps.hasAssistantHistory(sessionId))) return null;
        const localProviderId = current.kind === 'local' ? row.providerId : binding.providerId;
        return {
          sessionId,
          groupProviderId: binding.providerId,
          agentKind,
          model,
          member: current,
          route: memberRoute(current, localProviderId),
          localProviderId,
        };
      }
      // 已指定 Agent 所在电脑的任务不动。
      if (row.agentDeviceId) return null;
      const groupProviderId = row.providerId ?? (await deps.resolveImplicitProvider(agentKind, model));
      const config = groupProviderId ? deps.readGroup(groupProviderId) : null;
      if (!groupProviderId || !config) return null;
      // 已经运行过的任务(回退、清空等清掉了原生会话)不按策略挪走：留在本机并纳入组，之后出问题时
      // 照常自动换电脑。
      if (row.sdkSessionId || (await deps.hasAssistantHistory(sessionId))) {
        if (config.members.some((m) => m.kind === 'local')) {
          await deps.writeBinding(sessionId, {
            providerId: groupProviderId,
            memberKey: providerGroupMemberKey(null, groupProviderId),
          });
        }
        return null;
      }
      const pick = await pickNext(groupProviderId, agentKind, model, new Set());
      if (pick.kind === 'none') return null;
      if (pick.kind === 'unavailable') {
        deps.log.warn('provider group: no computer available for a new task', { sessionId, groupProviderId });
        throw new Error(PROVIDER_GROUP_UNAVAILABLE_ERROR);
      }
      const route = memberRoute(pick.member, row.providerId);
      await deps.writeBinding(sessionId, { providerId: groupProviderId, memberKey: pick.member.key });
      if (route.agentDeviceId !== null) await deps.persistRoute(sessionId, route);
      deps.log.info('provider group: assigned a computer', { sessionId, groupProviderId, member: pick.member.key });
      return {
        sessionId,
        groupProviderId,
        agentKind,
        model,
        member: pick.member,
        route,
        localProviderId: row.providerId,
      };
    },

    async nextAfterStartFailure(context, error) {
      const cause = classifyProviderGroupSwitchCause({ message: errorText(error) })
        ?? (/not authenticated|login/i.test(errorText(error)) ? 'auth' : null);
      const config = deps.readGroup(context.groupProviderId);
      if (!cause || !config?.autoSwitch) return null;
      cool(context.groupProviderId, context.member.key, cause, null);
      deps.directory.invalidate(context.member.agentDeviceId ?? undefined);
      const tried = router.markTried(context.sessionId, context.member.key);
      const pick = await pickNext(context.groupProviderId, context.agentKind, context.model, tried);
      if (pick.kind !== 'member') {
        router.resetTurn(context.sessionId);
        return null;
      }
      const route = memberRoute(pick.member, context.localProviderId);
      await deps.writeBinding(context.sessionId, { providerId: context.groupProviderId, memberKey: pick.member.key });
      await deps.persistRoute(context.sessionId, route);
      deps.log.info('provider group: agent did not start; trying the next computer', {
        sessionId: context.sessionId,
        cause,
        to: pick.member.key,
      });
      return { ...context, member: pick.member, route };
    },

    onTurnError(sessionId, signals, token) {
      void failover(sessionId, signals, token)
        .then((handled) => {
          if (!handled) deps.fallback(sessionId, signals, token);
        })
        .catch((error) => {
          deps.log.warn('provider group: automatic switch failed', { sessionId, error: errorText(error) });
          deps.fallback(sessionId, signals, token);
        });
    },

    async beforeSend(sessionId) {
      const binding = deps.readBinding(sessionId);
      if (!binding || deps.isTurnRunning(sessionId)) return;
      const config = deps.readGroup(binding.providerId);
      if (!config?.autoSwitch) return;
      if (!(await deps.isFailoverEligible(sessionId))) return;
      const row = await deps.readSessionRow(sessionId);
      if (!row?.model || row.remoteHostId) return;
      const current = await verifyBinding(sessionId, binding, config, row);
      // 暂停分配只影响新任务，已在那台的任务不挪走。
      if (!current || current.paused) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const resolved = await Promise.race([
        deps.directory.resolveMembers(binding.providerId, config),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), PROVIDER_GROUP_BEFORE_SEND_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(timer));
      const state = resolved?.find((r) => r.member.key === current.key);
      if (!state) return;
      const cooling = router.coolingUntil(binding.providerId, current.key) !== null;
      if (state.state === 'ok' && !cooling) return;
      const tried = router.markTried(sessionId, current.key);
      const pick = await pickNext(binding.providerId, row.agentKind, row.model, switchExclusion(config, current, tried));
      if (pick.kind !== 'member') {
        router.resetTurn(sessionId);
        return;
      }
      const localProviderId = current.kind === 'local' ? row.providerId : binding.providerId;
      const route = memberRoute(pick.member, localProviderId);
      await deps.writeBinding(sessionId, { providerId: binding.providerId, memberKey: pick.member.key });
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
          reason: cooling ? 'cooling' : state.state,
        });
      } catch (error) {
        await restoreBindingAfterFailedSwitch(sessionId, binding.providerId, config);
        deps.log.warn('provider group: moving a task before sending failed', { sessionId, error: errorText(error) });
      }
    },

    noteUserAction(sessionId) {
      for (const run of runningSwitches.get(sessionId) ?? []) run.superseded = true;
      router.resetTurn(sessionId);
    },
  };
}
