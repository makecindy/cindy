import type { Logger } from '../../interfaces/logger.js';

const MIN_THRESHOLD_PCT = 50;
const MAX_THRESHOLD_PCT = 95;

interface UsageSnapshot {
  ratio: number;
  contextTokens: number;
  contextWindow: number;
}

export interface AutoCompactControllerDeps {
  logger: Logger;
  /** 当前 session 绑定的 workdir (日志 context) */
  workdir: string;
  /** 当前 session 的 agent kind（日志用，如 claude-code / pi） */
  agentKind: string;
  /** 返回当前自动压缩阈值百分比。undefined 表示关闭 host 侧自动压缩。 */
  getThresholdPct: () => number | undefined;
}

/**
 * AutoCompactController — 基于 usage 快照在 turn 结束时触发一次 host 自动压缩。
 *
 * 控制器只做判定与 fire-once 状态管理; Claude Code 注入 `/compact`，Pi 调 compact RPC。
 */
export class AutoCompactController {
  private latest: UsageSnapshot | null = null;
  private fired = false;

  constructor(private readonly deps: AutoCompactControllerDeps) {}

  /** 记录 SDK 最新 context usage。无效窗口或负 token 直接忽略, 不做估算。 */
  onUsageUpdate(contextTokens: number, contextWindow: number): void {
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) return;
    if (!Number.isFinite(contextTokens) || contextTokens < 0) return;
    this.latest = {
      ratio: contextTokens / contextWindow,
      contextTokens,
      contextWindow,
    };
  }

  /**
   * turn end 时调用。达到当前阈值且本轮 compact_boundary 后尚未触发过时返回 true。
   * 每次调用都读取 getter, 因此 host 设置变更对当前会话实时生效。
   */
  shouldCompactNow(): boolean {
    const thresholdPct = this.normalizeThreshold(this.deps.getThresholdPct());
    if (thresholdPct === undefined || this.latest === null || this.fired) return false;
    if (this.latest.ratio < thresholdPct / 100) return false;
    this.fired = true;
    this.deps.logger.debug('auto-compact threshold crossed', {
      thresholdPct,
      ratio: Number(this.latest.ratio.toFixed(3)),
      contextTokens: this.latest.contextTokens,
      contextWindow: this.latest.contextWindow,
      workdir: this.deps.workdir,
      agentKind: this.deps.agentKind,
    });
    return true;
  }

  /**
   * setModel 切换上下文窗口后调用: 用新窗口重算 latest ratio。
   * 不重算的话 latest.ratio 仍是旧窗口口径 —— 大窗口切小窗口后本应立即可触发的
   * compact 会漏判(或反向误判), 直到下一次 onUsageUpdate 才被修正。
   * 无效窗口 / 尚无 usage 快照时不动(保持"无估算"原则, 与 onUsageUpdate 一致)。
   */
  onContextWindowChanged(contextWindow: number): void {
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) return;
    if (this.latest === null) return;
    this.latest = {
      ratio: this.latest.contextTokens / contextWindow,
      contextTokens: this.latest.contextTokens,
      contextWindow,
    };
  }

  /** compact_boundary 后重置 fire-once 状态, 允许后续上下文再次涨过阈值时触发。 */
  onCompactBoundary(): void {
    const wasFired = this.fired;
    this.fired = false;
    // compact_boundary 之后必须等 SDK 再报告新的 usage; 否则旧的高 ratio 会在
    // `/compact` turn end 被重复消费, 形成连续 compact。
    this.latest = null;
    if (!wasFired) return;
    this.deps.logger.debug('auto-compact fired flag reset (compact_boundary)', {
      workdir: this.deps.workdir,
      agentKind: this.deps.agentKind,
    });
  }

  /** compact 请求被取消/丢弃(未到 compact_boundary)时重置 fire-once,保留 latest 供重试。 */
  onCompactCanceled(reason: string): void {
    const wasFired = this.fired;
    this.fired = false;
    if (!wasFired) return;
    this.deps.logger.debug('auto-compact fired flag reset (compact canceled)', {
      reason,
      workdir: this.deps.workdir,
      agentKind: this.deps.agentKind,
    });
  }

  getLatestSnapshot(): UsageSnapshot | null {
    return this.latest ? { ...this.latest } : null;
  }

  getCurrentThresholdPct(): number | undefined {
    return this.normalizeThreshold(this.deps.getThresholdPct());
  }

  private normalizeThreshold(value: number | undefined): number | undefined {
    if (value === undefined) return undefined;
    if (!Number.isFinite(value)) return undefined;
    const rounded = Math.round(value);
    if (rounded < MIN_THRESHOLD_PCT || rounded > MAX_THRESHOLD_PCT) return undefined;
    return rounded;
  }
}
