import type { PreRunHookRunResult } from './types.js';

/** 瞬时前置检查故障（限流／超时／DNS）持续超过 1 天未恢复时，升级为正常未读失败提醒。 */
export const TRANSIENT_PRECHECK_ESCALATION_MS = 24 * 60 * 60 * 1000;

const KNOWN_PR_CHECK_DIAGNOSIS_KINDS = new Set(['dns', 'timeout', 'auth', 'rate-limit', 'unknown']);
const TRANSIENT_PR_CHECK_DIAGNOSIS_KINDS = new Set(['dns', 'timeout', 'rate-limit']);

export interface TransientPrecheckOutageState {
  /** 当前未恢复的连续瞬时检查故障中，最早一次的 firedAt（ms）；无未恢复瞬时故障时为 null。 */
  firstUnrecoveredFiredAt: number | null;
  /** 当前未恢复的瞬时检查故障中，最近一次已升级提醒（非 transientQuiet）的 firedAt（ms）。 */
  lastEscalatedFiredAt: number | null;
}

/**
 * 判定一次被前置检查拦下的运行是否属于「可自动重试的瞬时外部故障」：
 * - 结构化 PR 诊断为 `rate-limit` / `timeout` / `dns`（`auth` 与 `unknown` 需要人工处理，不静默）；
 * - 缺少插件（`missingPlugin`）或被取消（`aborted`）不静默；
 * - 无结构化 PR 诊断时，stderr 含 `rate limit`（与 `failureKind === 'rate-limit'` 同口径）视为瞬时限流。
 */
export function isTransientPrecheckHookFailure(
  result: Pick<
    PreRunHookRunResult,
    'status' | 'aborted' | 'decision' | 'prCheckDiagnosis' | 'missingPlugin' | 'stderr'
  > | null | undefined,
): boolean {
  if (!result || result.decision !== 'block') return false;
  if (result.status === 'aborted' || result.aborted) return false;
  if (result.missingPlugin) return false;
  const diagnosis = result.prCheckDiagnosis;
  if (diagnosis && typeof diagnosis === 'object' && !Array.isArray(diagnosis)) {
    const kind = (diagnosis as { kind?: unknown }).kind;
    if (typeof kind === 'string' && KNOWN_PR_CHECK_DIAGNOSIS_KINDS.has(kind)) {
      return TRANSIENT_PR_CHECK_DIAGNOSIS_KINDS.has(kind);
    }
  }
  return typeof result.stderr === 'string' && /rate limit/i.test(result.stderr);
}

/**
 * 超过 1 天未恢复时升级为兜底提醒；升级后若故障仍持续，至多每 24 小时再提醒一次，
 * 避免无去重脚本每次触发都反复顶起任务。
 */
export function shouldEscalateTransientPrecheckFailure(
  state: TransientPrecheckOutageState,
  now: number,
  thresholdMs = TRANSIENT_PRECHECK_ESCALATION_MS,
): boolean {
  const anchor = state.lastEscalatedFiredAt ?? state.firstUnrecoveredFiredAt;
  if (anchor === null || !Number.isFinite(anchor)) return false;
  return now - anchor >= thresholdMs;
}
