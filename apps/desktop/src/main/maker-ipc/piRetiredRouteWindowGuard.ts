import type { ModelWindowSwitchPreparationResult } from './contextOverflowRollover.js';

/**
 * Pi「已退役路由」的下一次发送前窗口核验（PR #4496 / issue #4486 / #4840）。
 *
 * 背景：本地 Pi 跨 proxy 供应商身份切换、Orca worker 路由重建等场景会退役旧 live
 * runtime（`runtimeRetired`），目标 route 交给下一次发送懒创建；冷 Pi 在目录窗口对已知
 * 占用有余量时也会跳过启动期核实。两种情况都让「切换时按目录窗口做的 90% 压力评估」
 * 少了对新进程真实窗口的确认——目录窗口（catalog / 历史列）可能与 Pi `get_state`
 * 回报的 contextWindow 不同。
 *
 * 本模块把这份核验挪到「下一次发送、新进程已懒创建之后、消息真正发给模型之前」：
 *  - 读新进程实际上报的窗口；拿不到就 fail closed，不发送；
 *  - 用 #3601 的同一目标窗口事务（`prepareModelWindowSwitch`，90% 固定压力线）决定是否
 *    需要缩窗重建；需要时先完成 bounded handoff + `context_rebuild` 再放行发送；
 *  - 核验/保护失败时保留待核验标记（用户重试会重新核验）并向上报可恢复的失败原因，
 *    由发送路径把消息退回队列；不静默降级（不回退旧供应商、不跳过保护照发）。
 *
 * 不变量：
 *  - 只有 `record()` 过的 session 才会核验；核验成功即清除标记，避免同一意图反复核验。
 *  - 失败**不**清除标记：下一次发送必须重新核验，保护不允许被绕过。
 *  - `contextTokensFloor` 只用于抬高占用估算（关闭时固化的 live 读数），绝不低报。
 */

export interface RetiredPiRouteWindowCheck {
  /** 退役时落定的目标 route。 */
  model: string;
  providerId: string | null;
  /** 退役决策依据的目录/核实目标窗口；新进程实际窗口可能更小。 */
  catalogTargetWindow: number | null;
  /** 退役前 live runtime 报告的窗口（历史按它积累）。 */
  previousWindow: number | null;
  /** 关闭时固化的 live 占用；只用于抬高估算，绝不低报。 */
  contextTokensFloor: number | null;
}

export type PiRetiredRouteWindowFailureCode =
  | 'MODEL_WINDOW_TARGET_CONTEXT_UNKNOWN'
  | 'MODEL_WINDOW_PROTECTION_UNAVAILABLE'
  | 'MODEL_WINDOW_CURRENT_CONTEXT_UNKNOWN'
  | 'MODEL_WINDOW_PREPARATION_IN_PROGRESS'
  | 'MODEL_SWITCH_TASK_RUNNING'
  | 'MODEL_WINDOW_REMOTE_REBUILD_UNSUPPORTED';

export type PiRetiredRouteWindowGuardResult =
  | { status: 'not-required' }
  | { status: 'verified'; contextWindow: number; rebuilt: boolean }
  | { status: 'failed'; code: PiRetiredRouteWindowFailureCode; message: string };

export interface PiRetiredRouteWindowGuardDeps {
  prepareModelWindowSwitch: (
    sessionId: string,
    target: {
      contextWindow: number;
      recheckTargetPressure?: boolean;
      confirmedTargetPressure?: boolean;
      contextTokensFloor?: number;
    },
  ) => Promise<ModelWindowSwitchPreparationResult>;
  /** 新进程实际上报的上下文窗口；读不到时返回 undefined。 */
  readLiveContextWindow: (sessionId: string) => number | undefined;
  log: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
  };
}

/** 失败原因 → 用户可读、可恢复的说明；都明确「这条消息没有发送」。 */
const FAILURE_REASONS: Record<PiRetiredRouteWindowFailureCode, string> = {
  MODEL_WINDOW_TARGET_CONTEXT_UNKNOWN:
    '新来源的 Pi 进程没有回报实际上下文窗口，这条消息没有发送；请重试或改回原来源',
  MODEL_WINDOW_PROTECTION_UNAVAILABLE:
    '新来源的实际窗口更小且历史已接近上限，但缩窗保护当前不可用，这条消息没有发送',
  MODEL_WINDOW_CURRENT_CONTEXT_UNKNOWN:
    '无法确认当前上下文占用，无法判断是否需要缩窗保护，这条消息没有发送；请重试或新建任务',
  MODEL_WINDOW_PREPARATION_IN_PROGRESS:
    '上一次上下文保护还在进行中，这条消息没有发送；稍后重试即可',
  MODEL_SWITCH_TASK_RUNNING:
    '任务正在运行，无法在发送前完成上下文保护，这条消息没有发送；等这一轮结束后重试即可',
  MODEL_WINDOW_REMOTE_REBUILD_UNSUPPORTED:
    '远端任务不支持缩窗重建，这条消息没有发送；请新建任务或改回原来源',
};

function failureFromPreparation(
  preparation: Exclude<ModelWindowSwitchPreparationResult, 'not-needed' | 'rebuilt'>,
): Extract<PiRetiredRouteWindowGuardResult, { status: 'failed' }> {
  const code: PiRetiredRouteWindowFailureCode =
    preparation === 'remote-unsupported'
      ? 'MODEL_WINDOW_REMOTE_REBUILD_UNSUPPORTED'
      : preparation === 'busy'
        ? 'MODEL_SWITCH_TASK_RUNNING'
        : preparation === 'in-flight'
          ? 'MODEL_WINDOW_PREPARATION_IN_PROGRESS'
          : preparation === 'confirmation-required'
            ? 'MODEL_WINDOW_PROTECTION_UNAVAILABLE'
            : 'MODEL_WINDOW_CURRENT_CONTEXT_UNKNOWN';
  return { status: 'failed', code, message: FAILURE_REASONS[code] };
}

export function createPiRetiredRouteWindowGuard(deps: PiRetiredRouteWindowGuardDeps) {
  const pending = new Map<string, RetiredPiRouteWindowCheck>();

  return {
    /** 退役（或跳过启动期核实的冷 Pi）落定目标 route 时登记。 */
    record(sessionId: string, check: RetiredPiRouteWindowCheck): void {
      pending.set(sessionId, check);
    },
    clear(sessionId: string): void {
      pending.delete(sessionId);
    },
    has(sessionId: string): boolean {
      return pending.has(sessionId);
    },
    read(sessionId: string): RetiredPiRouteWindowCheck | undefined {
      return pending.get(sessionId);
    },

    /**
     * 发送前核验：新进程实际窗口 + （必要时）#3601 缩窗保护。
     * 返回 failed 时调用方必须放弃这次发送，把消息退回队列。
     */
    async verifyBeforeSend(sessionId: string): Promise<PiRetiredRouteWindowGuardResult> {
      const check = pending.get(sessionId);
      if (!check) return { status: 'not-required' };

      const actualWindow = deps.readLiveContextWindow(sessionId);
      if (typeof actualWindow !== 'number' || !Number.isFinite(actualWindow) || actualWindow <= 0) {
        deps.log.warn('retired Pi route: new runtime did not report a window; send blocked', {
          sessionId,
          model: check.model,
          providerId: check.providerId,
          catalogTargetWindow: check.catalogTargetWindow,
        });
        return {
          status: 'failed',
          code: 'MODEL_WINDOW_TARGET_CONTEXT_UNKNOWN',
          message: FAILURE_REASONS.MODEL_WINDOW_TARGET_CONTEXT_UNKNOWN,
        };
      }

      let preparation: ModelWindowSwitchPreparationResult;
      try {
        preparation = await deps.prepareModelWindowSwitch(sessionId, {
          contextWindow: actualWindow,
          // 以**目标窗口压力**重算：历史按旧窗口积累，切到更小的实际窗口时 90% 线必须重判。
          recheckTargetPressure: true,
          // 用户在已退役来源上的显式发送即对该来源实际窗口的确认：发送路径没有二次确认
          // 入口，此处再要一次确认会让任务彻底无法推进。重建本身仍走 #3601 的同一事务
          // （bounded handoff + context_rebuild），保护口径不放宽。
          confirmedTargetPressure: true,
          ...(check.contextTokensFloor === null
            ? {}
            : { contextTokensFloor: check.contextTokensFloor }),
        });
      } catch (error) {
        deps.log.warn('retired Pi route: model-window protection threw; send blocked', {
          sessionId,
          actualWindow,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          status: 'failed',
          code: 'MODEL_WINDOW_PROTECTION_UNAVAILABLE',
          message: FAILURE_REASONS.MODEL_WINDOW_PROTECTION_UNAVAILABLE,
        };
      }

      if (preparation === 'not-needed' || preparation === 'rebuilt') {
        pending.delete(sessionId);
        deps.log.info('retired Pi route verified before send', {
          sessionId,
          model: check.model,
          providerId: check.providerId,
          catalogTargetWindow: check.catalogTargetWindow,
          actualWindow,
          rebuilt: preparation === 'rebuilt',
        });
        return { status: 'verified', contextWindow: actualWindow, rebuilt: preparation === 'rebuilt' };
      }

      deps.log.warn('retired Pi route verification failed; send blocked', {
        sessionId,
        actualWindow,
        preparation,
      });
      return failureFromPreparation(preparation);
    },
  };
}

export type PiRetiredRouteWindowGuard = ReturnType<typeof createPiRetiredRouteWindowGuard>;
