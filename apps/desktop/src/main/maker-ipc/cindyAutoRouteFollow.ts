import {
  effectiveSourceIdForModel,
  isCindyAutoModelId,
  isCindyDistributedProvider,
  movedCindyAutoSourceId,
  type AgentKind,
  type ProviderView,
} from '@cindy/model-providers';

import { isSupportedRuntimeEffort } from './runtimeSelectionAxes.js';
import type { PendingAgentSwitchIntent } from './sessionAgentSwitchHandler.js';
import type { SessionRuntimeControlSnapshot } from './sessionRuntimeControl.js';

/**
 * 进行中任务跟随服务端挪动的 Auto。
 *
 * 模型组 Auto（`auto/<组ID>`）挂在 Cindy AI 还是企业号池供应商下由服务端决定，管理员在
 * 平台模型与号池模型之间切换目标后，同一个模型 ID 会换到另一家供应商。目录刷新后，把仍记着
 * 旧来源的进行中任务登记为「下一条消息前切换」：引擎与模型 ID 不变，只换供应商（随之换 Key），
 * 沿用系统按配置发起的切换流程。不抢占运行中的轮次，不覆盖已登记的切换或运行时改道。
 */

export interface CindyAutoRoute {
  agentKind: AgentKind;
  model: string;
  providerId: string | null;
  effort: string | null;
  fastMode: boolean | 'ultrafast';
}

/** 该路由的 Auto 已被服务端挪到另一家 Cindy 来源时返回新来源，否则 null。 */
export function movedCindyAutoProviderId(
  providers: readonly ProviderView[],
  route: CindyAutoRoute,
): string | null {
  return movedCindyAutoSourceId(providers, {
    agent: route.agentKind,
    model: route.model,
    providerId: route.providerId,
  });
}

/** 加锁后重读到的任务运行时状态。 */
export interface CindyAutoRuntimeState {
  /** 任务当前实际路由（有运行时覆盖时就是覆盖的那条）。 */
  effective: CindyAutoRoute;
  control: Pick<SessionRuntimeControlSnapshot, 'fallbackHop'>;
  /** 用户或系统已登记、下一条消息生效的切换（含延后的运行时选择）。 */
  hasPendingSelection: boolean;
}

/**
 * 要跟随的当前路由；已有登记的切换或正在故障切换时返回 null，不覆盖。
 * 运行时覆盖本身不算改道：目录刷新按原路由重新加载进行中任务时也会写上它，这时它就是当前路由。
 */
export function cindyAutoRouteToFollow(state: CindyAutoRuntimeState): CindyAutoRoute | null {
  if (state.hasPendingSelection || state.control.fallbackHop > 0) return null;
  return state.effective;
}

/** 系统按配置登记、下一条消息生效的 Auto 换来源（同引擎、同一个 Auto，只换来源）。 */
export interface StagedCindyAutoSwitch {
  /** 任务当前实际路由（登记还没生效）。 */
  current: CindyAutoRoute;
  targetProviderId: string | null;
  cindyAutoRelocation?: PendingAgentSwitchIntent['cindyAutoRelocation'];
}

/** 从切换意图里认出系统登记的 Auto 换来源；用户自己点选、换引擎、换模型或换电脑的都不算。 */
export function stagedCindyAutoSwitch(
  intent: PendingAgentSwitchIntent | undefined,
  current: CindyAutoRoute,
): StagedCindyAutoSwitch | null {
  if (!intent?.configStaged || !intent.sameAgentSelection) return null;
  if (intent.targetAgentDeviceId !== undefined) return null;
  if (intent.targetAgentKind !== current.agentKind || intent.model !== current.model) return null;
  if (!isCindyAutoModelId(intent.model)) return null;
  return {
    current,
    targetProviderId: intent.providerId ?? null,
    ...(intent.cindyAutoRelocation ? { cindyAutoRelocation: intent.cindyAutoRelocation } : {}),
  };
}

/** Pi 的 providerId=null 就是 Cindy AI；其它引擎的 null 不推断。 */
function cindySourceId(agentKind: AgentKind, providerId: string | null): string | null {
  return providerId ?? (agentKind === 'pi' ? 'xd' : null);
}

export interface CindyAutoRouteFollowDeps {
  /**
   * 本地数据库是否已就绪。启动早期目录先到、数据库还没接管时直接跳过（不算失败）；
   * 数据库就绪后的那次 Cindy AI 刷新会再跑一次跟随。
   */
  isReady?(): boolean;
  /** 本机进行中、正在用 Auto 的任务（目录刷新时的粗筛，加锁后会重读）。 */
  listCandidates(): Promise<readonly ({ sessionId: string } & CindyAutoRoute)[]>;
  listProviders(): Promise<readonly ProviderView[]>;
  withSessionLock(sessionId: string, run: () => Promise<void>): Promise<void>;
  /** 加锁后重读任务当前实际路由；已有登记的切换或运行时改道时返回 null，不覆盖。 */
  readRoute(sessionId: string): Promise<CindyAutoRoute | null>;
  /** 系统已登记的 Auto 换来源；没有时返回 null。加锁后会重读。 */
  readStagedSwitch?(sessionId: string): Promise<StagedCindyAutoSwitch | null>;
  /** 撤销上面那条登记（调用方已持有该任务的 send 锁）。 */
  cancelStagedSwitch?(sessionId: string): Promise<void>;
  /** 登记下一条消息前的切换（调用方已持有该任务的 send 锁）。 */
  stage(
    sessionId: string,
    route: CindyAutoRoute,
    identity: NonNullable<PendingAgentSwitchIntent['cindyAutoRelocation']>,
  ): Promise<void>;
  assertCurrent(): void;
  logger?: { info(message: string, meta?: Record<string, unknown>): void };
}

/** 返回本次登记了切换的任务数；单个任务失败只记日志，不影响其余任务。 */
export async function followMovedCindyAutoRoutes(deps: CindyAutoRouteFollowDeps): Promise<number> {
  if (deps.isReady && !deps.isReady()) return 0;
  const candidates = await deps.listCandidates();
  if (candidates.length === 0) return 0;
  const providers = await deps.listProviders();
  deps.assertCurrent();
  let staged = 0;
  for (const candidate of candidates) {
    try {
      // 已登记过换来源的任务，按 Auto 现在的位置重新核对那条登记（任务库里的路由还是旧的）。
      if (deps.readStagedSwitch && (await deps.readStagedSwitch(candidate.sessionId))) {
        await deps.withSessionLock(candidate.sessionId, async () => {
          deps.assertCurrent();
          const switchToCheck = await deps.readStagedSwitch?.(candidate.sessionId);
          if (
            switchToCheck &&
            (await recheckStagedSwitch(deps, providers, candidate.sessionId, switchToCheck))
          ) {
            staged += 1;
          }
        });
        continue;
      }
      if (!movedCindyAutoProviderId(providers, candidate)) continue;
      await deps.withSessionLock(candidate.sessionId, async () => {
        deps.assertCurrent();
        const route = await deps.readRoute(candidate.sessionId);
        const providerId = route ? movedCindyAutoProviderId(providers, route) : null;
        if (!route || !providerId) return;
        // Auto 没有推理档位，任务里存的是空串；登记切换只接受合法档位或 null。
        const effort = isSupportedRuntimeEffort(route.effort) ? route.effort : null;
        const fromProviderId = cindySourceId(route.agentKind, route.providerId);
        if (!fromProviderId) return;
        await deps.stage(
          candidate.sessionId,
          { ...route, providerId, effort },
          {
            fromProviderId,
            targetProviderId: providerId,
          },
        );
        staged += 1;
        deps.logger?.info('Cindy Auto moved provider; staged switch for next message', {
          sessionId: candidate.sessionId,
          model: route.model,
          from: route.providerId,
          to: providerId,
        });
      });
    } catch (error) {
      deps.assertCurrent();
      deps.logger?.info('Cindy Auto provider follow failed; task keeps its route', {
        sessionId: candidate.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return staged;
}

/**
 * 以任务当前路由为准，看 Auto 现在该在哪：目标仍对就不动；当前位置又能用、或哪里都没有了就撤销；
 * 去了别处就改登记到那里。返回是否改登记。调用方已持有该任务的 send 锁。
 */
async function recheckStagedSwitch(
  deps: CindyAutoRouteFollowDeps,
  providers: readonly ProviderView[],
  sessionId: string,
  { current, targetProviderId, cindyAutoRelocation }: StagedCindyAutoSwitch,
): Promise<boolean> {
  const from = cindySourceId(current.agentKind, current.providerId);
  // 其它引擎的默认来源不一定是 Cindy AI，判断不了就不动。
  if (!from) return false;
  const target = cindySourceId(current.agentKind, targetProviderId);
  // configStaged 也用于伙伴/IM。首次跟随已验证两端；标记必须仍匹配当前和目标路由。
  const rememberedIdentity =
    cindyAutoRelocation?.fromProviderId === from && cindyAutoRelocation.targetProviderId === target;
  const fromProvider = providers.find((provider) => provider.id === from);
  const targetProvider = providers.find((provider) => provider.id === target);
  if (fromProvider && !isCindyDistributedProvider(fromProvider)) return false;
  if (targetProvider && !isCindyDistributedProvider(targetProvider)) return false;
  if (!rememberedIdentity && (!fromProvider || !targetProvider)) return false;
  // 旧来源也已删除时，凭登记时的身份只在当前 Cindy 来源中重新找，不接入自定义同名模型。
  const now = fromProvider
    ? effectiveSourceIdForModel([...providers], from, current.model, current.agentKind)
    : effectiveSourceIdForModel(
        providers.filter(isCindyDistributedProvider),
        null,
        current.model,
        current.agentKind,
      );
  if (now === target) return false;
  if (!now || now === from) {
    await deps.cancelStagedSwitch?.(sessionId);
    deps.logger?.info('Cindy Auto staged switch withdrawn', {
      sessionId,
      model: current.model,
      from,
      to: target,
    });
    return false;
  }
  const effort = isSupportedRuntimeEffort(current.effort) ? current.effort : null;
  await deps.stage(
    sessionId,
    { ...current, providerId: now, effort },
    {
      fromProviderId: from,
      targetProviderId: now,
    },
  );
  deps.logger?.info('Cindy Auto staged switch retargeted', {
    sessionId,
    model: current.model,
    from,
    to: now,
    previousTarget: target,
  });
  return true;
}
