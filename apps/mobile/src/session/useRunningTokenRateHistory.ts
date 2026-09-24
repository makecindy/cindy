import { useEffect, useRef, useState } from 'react';
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
  /** 本地发送或队列已让活动条出现，但远端本轮 startedAt 可能仍是 null。 */
  streaming?: boolean;
}) {
  const {
    sessionKey,
    startedAt,
    outputTokens,
    generationDurationMs,
    generationReliable,
    streaming = false,
  } = input;
  // 挂载时从按会话的进程内缓存播种：ComposerActivityStatus 以账号、设备和任务身份为 key，
  // 切走再切回是全新挂载，历史从缓存恢复而不是从零开始。
  const [history, setHistory] = useState<RateHistory>(() => {
    const cached = sessionKey ? loadCachedRateHistory(sessionKey) : null;
    if (!cached) return emptyRateHistory(null);
    // 空闲态恢复时丢弃两个计数起点：无法判断计数属于哪一轮，既不能
    // 用旧 baseline 计算区间，也不能用旧 lastReport 判定当前轮计数回退。
    // 同时也丢掉上一轮速率。活动条会在远端 startedAt 到达前因本地发送重新挂载，
    // 空闲切回同样没有当前轮可归属的速率。
    if (startedAt !== null) return cached;
    return { ...cached, baseline: null, lastReport: null, latestRate: null };
  });
  const loadedSessionKey = useRef(sessionKey);
  useEffect(() => {
    setHistory((previous) => {
      const switched = loadedSessionKey.current !== sessionKey;
      loadedSessionKey.current = sessionKey;
      const cached = switched && sessionKey ? loadCachedRateHistory(sessionKey) : null;
      const seeded = !switched
        ? previous
        : !cached
          ? emptyRateHistory(startedAt)
          : startedAt === null
            ? { ...cached, baseline: null, lastReport: null, latestRate: null }
            : cached;
      const recorded = recordRunningTokenRate(seeded, {
        startedAt,
        outputTokens,
        generationDurationMs,
        generationReliable,
      });
      // 同一挂载在 600ms 收尾粘滞内再次发送时不会重新播种。本地活动已开始而
      // 远端 startedAt 仍为 null 时，上一轮速率不能继续当作当前速度。
      if (
        streaming &&
        startedAt === null &&
        (recorded.latestRate !== null || recorded.baseline !== null || recorded.lastReport !== null)
      ) {
        return { ...recorded, baseline: null, lastReport: null, latestRate: null };
      }
      return recorded;
    });
  }, [sessionKey, startedAt, outputTokens, generationDurationMs, generationReliable, streaming]);
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
  const displayed =
    startedAt === null || history.startedAt === startedAt
      ? visibleHistory
      : { ...history, startedAt, baseline: null, latestRate: null };
  return streaming && startedAt === null
    ? { ...displayed, baseline: null, lastReport: null, latestRate: null }
    : displayed;
}
