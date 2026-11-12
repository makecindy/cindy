import type { UsageSnapshot } from '@cindy/maker-core';

/**
 * 会话最近一次 **live runtime** 的用量快照（进程内，不落库）。
 *
 * 冷 Pi 的窗口核实预检需要「当前占用」来判断目标窗口还有没有余量，但
 * `sessions.context_tokens` 只在 turn 正常收尾（`status: isRunning=false + Done`）时
 * 落库：turn 被中断 / 进程被杀 / 退出时在飞都可能留下低报的旧值，拿它证明「目标有余量」
 * 会绕过缩窗交接（Greptile P1，2026-09-21）。
 *
 * 这里改在 runtime **关闭的那一刻**直接读 live 快照（会话对象自己的用量记账，是当前
 * 唯一权威来源），并且只在**同一次进程生命周期内**可用：
 *  - 进程重启后没有缓存 → 预检自动回退到冷启动核实（保守，代价是一次 2~3s）；
 *  - 没走到 close 的硬杀同样没有缓存 → 回退核实。
 *
 * 因此只要读得到缓存，就一定是「这次变冷之前最后一次 live 读数」，不存在低报窗口。
 * 条目按会话保留（进程内生命周期，数量与本次运行关闭过的会话数同阶）。
 */
export interface SessionLastLiveUsage {
  contextTokens: number;
  contextWindow: number;
  capturedAtMs: number;
}

const lastLiveUsageBySession = new Map<string, SessionLastLiveUsage>();

function positiveOrZero(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** 关闭 runtime 时固化 live 用量；快照缺失或字段非法时不动缓存（保留更早的可信值）。 */
export function rememberSessionLastLiveUsage(
  sessionId: string,
  usage: Pick<UsageSnapshot, 'contextTokens' | 'contextWindow'> | undefined | null,
): void {
  if (!sessionId || !usage) return;
  const contextTokens = positiveOrZero(usage.contextTokens);
  const contextWindow = positiveOrZero(usage.contextWindow);
  if (contextTokens === null || contextWindow === null) return;
  lastLiveUsageBySession.set(sessionId, {
    contextTokens,
    contextWindow,
    capturedAtMs: Date.now(),
  });
}

export function getSessionLastLiveUsage(sessionId: string): SessionLastLiveUsage | undefined {
  return lastLiveUsageBySession.get(sessionId);
}

export function forgetSessionLastLiveUsage(sessionId: string): void {
  lastLiveUsageBySession.delete(sessionId);
}

export function _resetSessionLastLiveUsageForTests(): void {
  lastLiveUsageBySession.clear();
}
