/**
 * 伙伴资料 / 生命周期变化的零依赖信号：伙伴 IPC（bots.ts）与生命周期服务在广播时发，
 * 观察层（service.ts）收到后立即重读归属与跟进者——「它开的任务也交给总调度跟」、新建 / 暂停 /
 * 归档伙伴不必等 60 秒的定时重读。本文件不 import 任何模块，发送方不因此加载观察层依赖。
 */
let listener: (() => void) | null = null;
const subscribers = new Set<() => void>();

export function subscribeBotProfilesChanged(next: () => void): () => void {
  subscribers.add(next);
  return () => { subscribers.delete(next); };
}

export function setBotAutonomyBotsChangedListener(next: (() => void) | null): void {
  listener = next;
}

export function signalBotAutonomyBotsChanged(): void {
  for (const next of subscribers) {
    try { next(); } catch { /* A reader cannot block a committed profile change. */ }
  }
  try {
    listener?.();
  } catch {
    // 观察层的失败不影响伙伴资料写入与广播。
  }
}
