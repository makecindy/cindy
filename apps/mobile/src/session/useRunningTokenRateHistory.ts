import { useEffect, useState } from 'react';
import {
  emptyRateHistory,
  loadCachedRateHistory,
  recordRunningTokenRate,
  saveCachedRateHistory,
  RATE_SAMPLE_FRESH_MS,
  type RateHistory,
} from '@cindy/maker-shared';

export function useRunningTokenRateHistory(input: {
  /** 会话身份：用于进程内缓存速度历史，切任务再切回不清零（重启应用清零）。 */
  sessionKey: string | null;
  startedAt: number | null;
  outputTokens: number;
  generationDurationMs: number;
  generationReliable: boolean;
}) {
  const { sessionKey, startedAt, outputTokens, generationDurationMs, generationReliable } = input;
  // 挂载时从按会话的进程内缓存播种：ComposerActivityStatus 以账号、设备和任务身份为 key，
  // 切走再切回是全新挂载，历史从缓存恢复而不是从零开始。
  const [history, setHistory] = useState<RateHistory>(() => {
    const cached = sessionKey ? loadCachedRateHistory(sessionKey) : null;
    if (!cached) return emptyRateHistory(null);
    // 空闲态恢复时丢弃两个计数起点：无法判断计数属于哪一轮，既不能
    // 用旧 baseline 计算区间，也不能用旧 lastReport 判定当前轮计数回退。
    return startedAt === null ? { ...cached, baseline: null, lastReport: null } : cached;
  });
  useEffect(() => {
    setHistory((previous) =>
      recordRunningTokenRate(previous, {
        startedAt,
        outputTokens,
        generationDurationMs,
        generationReliable,
      }),
    );
  }, [startedAt, outputTokens, generationDurationMs, generationReliable]);
  useEffect(() => {
    if (sessionKey) saveCachedRateHistory(sessionKey, history);
  }, [sessionKey, history]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timestamp = history.latestSampleAt;
    if (timestamp === undefined || history.latestRate === null) return;
    setNow(Date.now());
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, timestamp + RATE_SAMPLE_FRESH_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [history.latestSampleAt, history.latestRate]);
  const visibleHistory =
    history.latestSampleAt === undefined ||
    Math.max(now, Date.now()) - history.latestSampleAt >= RATE_SAMPLE_FRESH_MS
      ? { ...history, latestRate: null }
      : history;
  return startedAt === null || history.startedAt === startedAt
    ? visibleHistory
    : { ...history, startedAt, baseline: null, latestRate: null };
}
