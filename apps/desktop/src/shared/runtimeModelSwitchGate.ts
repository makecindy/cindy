/**
 * 已建任务里 SET_MODEL 的窗口 / busy 闸门(纯函数)。
 *
 * 统一选择器把 Harness 与模型叠在一次点选上之后,同引擎切模会打到这条路。
 * 预检是护栏不是闸门:缺核实窗口或占用未知时放行热切,禁止拿「不确定」挡住用户。
 * 只有「核实过的缩窗 + 必须交接」才走重建;跑着无法重建时延期到回合结束,不丢选择。
 */

import { composeAtomicModelSelection } from '@cindy/model-providers';

import {
  assessModelSwitchContext,
  MODEL_WINDOW_SWITCH_FORCE_REBUILD_PCT,
} from './modelSwitchAssessment.js';

export type RuntimeModelSwitchGate = {
  /** 跳过破坏性换窗,继续 setModel / 延期登记。 */
  skipRebuild: boolean;
  /** 本轮不能 live 生效:登记 pending,回合结束后再 apply。 */
  defer: boolean;
  /** 远端无法交接缩窗时仍拒绝(没有本机 rebuild)。 */
  reject?: 'remote-shrink-rebuild';
};

export interface RuntimeModelSwitchGateInput {
  inTurn: boolean;
  isRemote: boolean;
  agentKind: string | null | undefined;
  runtimeRouteChanged: boolean;
  verifiedTargetWindow: number | null | undefined;
  verifiedCurrentWindow: number | null | undefined;
  contextTokensKnown: boolean;
  contextTokens: number;
}

function isPositiveWindow(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * 判定一次运行时切模该热切、延期还是拒绝。
 *
 * 矩阵(与单测逐行对应):
 *   - 路由没变 → 热切、不换窗
 *   - 远端 + 回合中 → 延期(不能 live 改远端 turn)
 *   - Pi + 回合中 + 路由变了 → 延期(Pi 要在空闲时核实窗口)
 *   - 目标/当前窗口未核实或占用未知 → 热切、不换窗(fail-open)
 *   - 核实缩窗且 danger/overflow:
 *       远端 → 拒绝(远端不能 rebuild)
 *       回合中 → 延期
 *       空闲 → 走换窗重建
 *   - 同窗 / 扩窗 → 热切、不换窗
 */
export function assessRuntimeModelSwitchGate(
  input: RuntimeModelSwitchGateInput,
): RuntimeModelSwitchGate {
  if (input.isRemote && input.inTurn) {
    return { skipRebuild: true, defer: true };
  }
  if (input.agentKind === 'pi' && input.inTurn && input.runtimeRouteChanged) {
    return { skipRebuild: true, defer: true };
  }
  if (!input.runtimeRouteChanged) {
    return { skipRebuild: true, defer: false };
  }

  const targetWindow = input.verifiedTargetWindow;
  const currentWindow = input.verifiedCurrentWindow;
  if (
    !isPositiveWindow(targetWindow) ||
    !isPositiveWindow(currentWindow) ||
    !input.contextTokensKnown
  ) {
    return { skipRebuild: true, defer: false };
  }

  const shrinks = targetWindow < currentWindow;
  if (!shrinks) {
    return { skipRebuild: true, defer: false };
  }

  const assessment = assessModelSwitchContext({
    contextTokens: input.contextTokens,
    targetContextWindow: targetWindow,
    autoCompactThresholdPct: MODEL_WINDOW_SWITCH_FORCE_REBUILD_PCT,
  });
  const needsRebuild = assessment.level === 'danger' || assessment.level === 'overflow';
  if (!needsRebuild) {
    return { skipRebuild: true, defer: false };
  }
  if (input.isRemote) {
    return { skipRebuild: false, defer: false, reject: 'remote-shrink-rebuild' };
  }
  if (input.inTurn) {
    return { skipRebuild: false, defer: true };
  }
  return { skipRebuild: false, defer: false };
}

/** 回合中登记 pending 时写入的运行时快照:必须带上点选时的 effort / Fast,不能等结算再猜。 */
export function buildDeferredRuntimeSelectionProfile<
  TAgent extends string,
  TEffort extends string | null = string | null,
>(input: {
  agentKind: TAgent;
  model: string;
  providerId: string | null;
  atomicSelection?: { effort: TEffort; fastMode: boolean } | null;
  currentFastMode: boolean;
}): {
  agentKind: TAgent;
  model: string;
  providerId: string | null;
  effort: TEffort | null;
  fastMode: boolean;
} {
  return {
    agentKind: input.agentKind,
    model: input.model,
    providerId: input.providerId,
    effort: input.atomicSelection?.effort ?? null,
    fastMode: input.atomicSelection?.fastMode ?? input.currentFastMode,
  };
}

export type DeferredModelWindowRetry =
  | { action: 'done' }
  | { action: 'retry'; confirmedContextWindow: number }
  | { action: 'cancel' };

/** 延期选择在空闲结算时若仍要换窗确认:带着核实窗口再 apply,缺窗口才取消。 */
export function nextDeferredModelWindowRetry(
  confirmationRequired: boolean,
  confirmedWindow: number | undefined,
): DeferredModelWindowRetry {
  if (!confirmationRequired) return { action: 'done' };
  if (typeof confirmedWindow === 'number' && Number.isFinite(confirmedWindow) && confirmedWindow > 0) {
    return { action: 'retry', confirmedContextWindow: confirmedWindow };
  }
  return { action: 'cancel' };
}

export type UserRuntimeModelSwitchOutcome = 'hot-apply' | 'defer' | 'reject';

export interface UserRuntimeModelSwitchPlan {
  outcome: UserRuntimeModelSwitchOutcome;
  skipRebuild: boolean;
  reason?: 'remote-shrink-rebuild';
  selection: { effort: string | null; fastMode: boolean };
  pendingProfile: {
    agentKind: string;
    model: string;
    providerId: string | null;
    effort: string | null;
    fastMode: boolean;
  };
}

/**
 * 用户点选后的完整规划:原子快照 ⊕ 窗口闸门 ⊕ 延期 profile。
 * renderer 用 click 组快照;main 已归一化的 atomic selection 直接传入,不再猜档。
 */
export function planUserRuntimeModelSwitch(input: {
  agentKind: string;
  model: string;
  providerId: string | null;
  currentFastMode: boolean;
  gate: RuntimeModelSwitchGateInput;
  selection?: { effort: string | null; fastMode: boolean };
  click?: {
    efforts: readonly string[];
    effort: string;
    fastSupported: boolean;
    requestedFast: boolean;
  };
}): UserRuntimeModelSwitchPlan {
  const selection =
    input.selection ??
    composeAtomicModelSelection({
      efforts: input.click?.efforts ?? [],
      effort: input.click?.effort ?? 'low',
      fastSupported: input.click?.fastSupported === true,
      requestedFast: input.click?.requestedFast === true,
    });
  const gate = assessRuntimeModelSwitchGate(input.gate);
  const pendingProfile = buildDeferredRuntimeSelectionProfile({
    agentKind: input.agentKind,
    model: input.model,
    providerId: input.providerId,
    atomicSelection: selection,
    currentFastMode: input.currentFastMode,
  });
  if (gate.reject === 'remote-shrink-rebuild') {
    return {
      outcome: 'reject',
      skipRebuild: gate.skipRebuild,
      reason: 'remote-shrink-rebuild',
      selection,
      pendingProfile,
    };
  }
  if (gate.defer) {
    return { outcome: 'defer', skipRebuild: gate.skipRebuild, selection, pendingProfile };
  }
  return { outcome: 'hot-apply', skipRebuild: gate.skipRebuild, selection, pendingProfile };
}
