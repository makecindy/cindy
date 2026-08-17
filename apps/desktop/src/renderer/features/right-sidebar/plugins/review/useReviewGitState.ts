/**
 * Hooks for git-review read state.
 *
 * Refresh triggers are explicit refresh, window focus, and makerChatStore
 * updates for the current session (debounced; covers turn-end changes).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { createLogger } from '@/lib/logger';
import { gitReviewApiFor } from '@/lib/gitReviewTransport';
import { makerChatStore } from '@/lib/makerChatStore';
import type {
  ReviewBranchDiffData,
  ReviewCommitDiffData,
  ReviewCommitListData,
  ReviewData,
  ReviewDirtySummary,
  ReviewFileDiffData,
  ReviewFileDiffRequest,
} from '@/lib/gitReview.types';
import { extractIpcError } from '@/utils/ipcError';
import { LruCache } from './DiffViewer/highlight';

const log = createLogger('rightSidebar.review.git');
const REFRESH_DEBOUNCE_MS = 350;
const FILE_DIFF_BATCH_CONCURRENCY = 6;
const reviewLoadCache = new LruCache<string, unknown>(20);

interface LoadState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** IPC error code (e.g. 'DEVICE_LINK_CHANNEL_NOT_ALLOWED'); null when error is absent or not an IPC error. */
  errorCode: string | null;
  refresh: () => void;
  setData: (data: T) => void;
}

function useDebouncedCallback(cb: () => void, delayMs: number): () => void {
  const timerRef = useRef<number | null>(null);
  const cbRef = useRef(cb);
  cbRef.current = cb;
  return useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      cbRef.current();
    }, delayMs);
  }, [delayMs]);
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      out[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

function useGitReviewLoad<T>(
  sessionId: string | null,
  fetch: (sessionId: string) => Promise<T>,
  logLabel: string,
  options: { cacheKey?: string | null; preserveWhenDisabled?: boolean; scopeKey?: string | null } = {},
): LoadState<T> {
  const cacheKey = options.cacheKey ?? null;
  const preserveWhenDisabled = options.preserveWhenDisabled ?? false;
  // scope = 数据归属的会话/设备身份(`<deviceId|local>:<sessionId>`)。cacheKey 还编码
  // oid / baseRef / whitespace 等查询参数,粒度比 scope 细。
  const scopeKey = options.scopeKey ?? cacheKey;
  const [data, setDataState] = useState<T | null>(() => {
    const cached = cacheKey ? reviewLoadCache.get(cacheKey) as T | undefined : undefined;
    return cached ?? null;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const requestRef = useRef(0);
  // 渲染期 keyed reset(React "derived state during render"),不等 useEffect——effect
  // 跑在 paint 之后,切换的第一帧会把上一个 key 的旧审查结果画给新会话(review P1):
  //  - 新 key 有缓存 → 当帧采纳缓存;
  //  - scope(会话/设备)变了且无缓存 → 当帧清空 fail closed,绝不把 A 会话的 diff
  //    画给 B 会话;
  //  - 同 scope 内换 key(切 commit / baseRef / whitespace)且无缓存 → 保留旧数据,
  //    由 loading 态覆盖(既有 cache continuity 契约,见 useReviewGitState.test)。
  // preserveWhenDisabled 仅保护「scope 变 null 的禁用窗口」(commit/branch diff 视图
  // 暂时失焦),非空 scope 之间的切换一律重置。
  const [paintedScopeKey, setPaintedScopeKey] = useState(scopeKey);
  const [paintedCacheKey, setPaintedCacheKey] = useState(cacheKey);
  if (paintedScopeKey !== scopeKey || paintedCacheKey !== cacheKey) {
    const scopeChanged = paintedScopeKey !== scopeKey;
    setPaintedScopeKey(scopeKey);
    setPaintedCacheKey(cacheKey);
    const cached = cacheKey ? reviewLoadCache.get(cacheKey) as T | undefined : undefined;
    if (scopeChanged) {
      // 立即让旧 scope 的在途请求失效；不能等新 scope 的 load effect，旧请求可能
      // 在 render 与 effect 之间完成并把 A 会话数据写回 B 会话。
      requestRef.current += 1;
      setLoading(false);
    }
    if (cached !== undefined) {
      setDataState(cached);
    } else if (scopeChanged && (scopeKey !== null || !preserveWhenDisabled)) {
      setDataState(null);
      setError(null);
      setErrorCode(null);
    }
  }
  const setData = useCallback((next: T) => {
    setDataState(next);
    if (cacheKey) reviewLoadCache.set(cacheKey, next);
  }, [cacheKey]);

  const load = useCallback(() => {
    if (!sessionId) {
      requestRef.current += 1;
      if (!preserveWhenDisabled) setDataState(null);
      setError(null);
      setErrorCode(null);
      setLoading(false);
      return;
    }
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    fetch(sessionId)
      .then((next) => {
        if (requestRef.current !== requestId) return;
        setData(next);
        setError(null);
        setErrorCode(null);
      })
      .catch((err) => {
        if (requestRef.current !== requestId) return;
        const ipcErr = extractIpcError(err);
        setError(ipcErr?.message ?? (err instanceof Error ? err.message : String(err)));
        setErrorCode(ipcErr?.code ?? null);
        log.warn(logLabel, { sessionId, message: ipcErr?.message ?? String(err) });
      })
      .finally(() => {
        if (requestRef.current === requestId) setLoading(false);
      });
  }, [sessionId, fetch, logLabel, preserveWhenDisabled, setData]);
  const debouncedLoad = useDebouncedCallback(load, REFRESH_DEBOUNCE_MS);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!sessionId) return;
    const onFocus = () => debouncedLoad();
    window.addEventListener('focus', onFocus);
    const unsubscribe = makerChatStore.subscribe(sessionId, debouncedLoad);
    return () => {
      window.removeEventListener('focus', onFocus);
      unsubscribe();
    };
  }, [sessionId, debouncedLoad]);

  return { data, loading, error, errorCode, refresh: load, setData };
}

export function useReviewGitState(
  sessionId: string | null,
  ignoreWhitespace = false,
  deviceId: string | null = null,
): LoadState<ReviewData> {
  const fetchReviewData = useCallback((currentSessionId: string) =>
    gitReviewApiFor(deviceId).get({ sessionId: currentSessionId, ignoreWhitespace }), [deviceId, ignoreWhitespace]);
  return useGitReviewLoad(sessionId, fetchReviewData, 'git review load failed', {
    cacheKey: sessionId ? `${deviceId ?? 'local'}:worktree:${sessionId}:${ignoreWhitespace ? 'w' : 'plain'}` : null,
    scopeKey: sessionId ? `${deviceId ?? 'local'}:${sessionId}` : null,
  });
}

export function useReviewDirtySummary(sessionId: string | null, deviceId: string | null = null): LoadState<ReviewDirtySummary> {
  const fetchReviewSummary = useCallback((currentSessionId: string) =>
    gitReviewApiFor(deviceId).summary({ sessionId: currentSessionId }), [deviceId]);
  return useGitReviewLoad(sessionId, fetchReviewSummary, 'git review summary failed', {
    scopeKey: sessionId ? `${deviceId ?? 'local'}:${sessionId}` : null,
  });
}

export function useReviewCommits(
  sessionId: string | null,
  baseRef: string | null,
  deviceId: string | null = null,
): LoadState<ReviewCommitListData> {
  const fetchReviewCommits = useCallback((currentSessionId: string) =>
    gitReviewApiFor(deviceId).commits({ sessionId: currentSessionId, baseRef }), [baseRef, deviceId]);
  return useGitReviewLoad(sessionId, fetchReviewCommits, 'git review commits failed', {
    scopeKey: sessionId ? `${deviceId ?? 'local'}:${sessionId}` : null,
  });
}

export function useReviewCommitDiff(
  sessionId: string | null,
  oid: string | null,
  ignoreWhitespace = false,
  deviceId: string | null = null,
): LoadState<ReviewCommitDiffData> {
  const fetchCommitDiff = useCallback((currentSessionId: string) => {
    if (!oid) return Promise.reject(new Error('commit oid is required'));
    return gitReviewApiFor(deviceId).commitDiff({ sessionId: currentSessionId, oid, ignoreWhitespace });
  }, [deviceId, ignoreWhitespace, oid]);
  return useGitReviewLoad(sessionId && oid ? sessionId : null, fetchCommitDiff, 'git review commit diff failed', {
    cacheKey: sessionId && oid ? `${deviceId ?? 'local'}:commit:${sessionId}:${oid}:${ignoreWhitespace ? 'w' : 'plain'}` : null,
    scopeKey: sessionId && oid ? `${deviceId ?? 'local'}:${sessionId}` : null,
    preserveWhenDisabled: true,
  });
}

export function useReviewBranchDiff(
  sessionId: string | null,
  baseRef: string | null,
  ignoreWhitespace = false,
  enabled = true,
  deviceId: string | null = null,
): LoadState<ReviewBranchDiffData> {
  const fetchBranchDiff = useCallback((currentSessionId: string) =>
    gitReviewApiFor(deviceId).branchDiff({
      sessionId: currentSessionId,
      baseRef,
      ignoreWhitespace,
    }), [baseRef, deviceId, ignoreWhitespace]);
  return useGitReviewLoad(sessionId && enabled ? sessionId : null, fetchBranchDiff, 'git review branch diff failed', {
    cacheKey: sessionId ? `${deviceId ?? 'local'}:branch:${sessionId}:${baseRef ?? 'default'}:${ignoreWhitespace ? 'w' : 'plain'}` : null,
    scopeKey: sessionId ? `${deviceId ?? 'local'}:${sessionId}` : null,
    preserveWhenDisabled: true,
  });
}

export function useReviewFileDiff(
  sessionId: string | null,
  request: ReviewFileDiffRequest | null,
  refreshVersion = 0,
  deviceId: string | null = null,
): LoadState<ReviewFileDiffData> {
  const source = request?.source ?? null;
  const path = request?.path ?? null;
  const oldPath = request?.oldPath ?? null;
  const commitOid = request?.commitOid ?? null;
  const branchBaseRef = request?.branchBaseRef ?? null;
  const ignoreWhitespace = request?.ignoreWhitespace === true;
  const fetchFileDiff = useCallback((currentSessionId: string) => {
    if (!source || !path) return Promise.reject(new Error('file diff request is required'));
    return gitReviewApiFor(deviceId).fileDiff({
      sessionId: currentSessionId,
      source,
      path,
      oldPath,
      commitOid,
      branchBaseRef,
      ignoreWhitespace,
    });
  }, [branchBaseRef, commitOid, deviceId, ignoreWhitespace, oldPath, path, refreshVersion, source]);
  const cacheKey = sessionId && source && path
    ? `${deviceId ?? 'local'}:file:${sessionId}:${source}:${commitOid ?? branchBaseRef ?? 'worktree'}:${oldPath ?? ''}:${path}:${ignoreWhitespace ? 'w' : 'plain'}:${refreshVersion}`
    : null;
  return useGitReviewLoad(sessionId && source && path ? sessionId : null, fetchFileDiff, 'git review file diff failed', {
    cacheKey,
    scopeKey: sessionId && source && path ? `${deviceId ?? 'local'}:${sessionId}` : null,
    preserveWhenDisabled: true,
  });
}

export function useReviewFileDiffs(
  sessionId: string | null,
  requests: readonly ReviewFileDiffRequest[],
  deviceId: string | null = null,
): LoadState<ReviewFileDiffData[]> {
  const requestKey = requests.length > 0
    ? JSON.stringify(requests.map((request) => ({
      source: request.source,
      path: request.path,
      oldPath: request.oldPath ?? null,
      commitOid: request.commitOid ?? null,
      branchBaseRef: request.branchBaseRef ?? null,
      ignoreWhitespace: request.ignoreWhitespace === true,
    })))
    : null;
  // React exhaustive-deps note: requestKey encodes request contents; array identity changes alone should not reload the batch.
  const fetchFileDiffs = useCallback((currentSessionId: string) =>
    mapWithConcurrency(requests, FILE_DIFF_BATCH_CONCURRENCY, (request) =>
      gitReviewApiFor(deviceId).fileDiff({
        sessionId: currentSessionId,
        source: request.source,
        path: request.path,
        oldPath: request.oldPath ?? null,
        commitOid: request.commitOid ?? null,
        branchBaseRef: request.branchBaseRef ?? null,
        ignoreWhitespace: request.ignoreWhitespace === true,
      })), [deviceId, requestKey]);
  return useGitReviewLoad(
    sessionId && requestKey ? sessionId : null,
    fetchFileDiffs,
    'git review file diff batch failed',
    {
      cacheKey: sessionId && requestKey ? `${deviceId ?? 'local'}:files:${sessionId}:${requestKey}` : null,
      scopeKey: sessionId && requestKey ? `${deviceId ?? 'local'}:${sessionId}` : null,
      preserveWhenDisabled: false,
    },
  );
}
