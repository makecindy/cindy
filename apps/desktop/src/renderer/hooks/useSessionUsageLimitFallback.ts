import { useCallback, useEffect, useRef, useState } from 'react';

/** 备用目标：只换来源与模型，Harness 在写入时固定。 */
export interface SessionUsageLimitFallbackTarget {
  providerId: string;
  model: string;
}

export type SessionUsageLimitFallbackMutation =
  | { ok: true; target: SessionUsageLimitFallbackTarget | null }
  | {
      ok: false;
      errorCode: UsageLimitFallbackErrorCode;
      message: string;
    };

/** 与主进程 `UsageLimitFallbackSetResult` 的错误码一一对应，界面按它取文案。 */
export type UsageLimitFallbackErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_ARGS'
  | 'ROUTE_UNAVAILABLE'
  | 'CONFLICT'
  | 'HOST_NOT_READY';

export interface SessionUsageLimitFallbackState {
  target: SessionUsageLimitFallbackTarget | null;
  /** 配置时的组合已不是任务当前组合：策略还保存着，但不会再命中。 */
  stale: boolean;
  loading: boolean;
  error: string | null;
  /**
   * 失败的错误码（主进程返回的）；宿主不在、IPC reject 等拿不到码的情况为 `null`。
   * 界面按码取本地文案，原始 message 只当诊断信息留在 title 里。
   */
  errorCode: UsageLimitFallbackErrorCode | null;
  /** 写入成功返回 true；失败落 error 并返回 false，不抛。 */
  setTarget: (target: SessionUsageLimitFallbackTarget) => Promise<boolean>;
  clearTarget: () => Promise<boolean>;
}

function readErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * 任务级额度备用路线的 renderer 状态。
 *
 * 策略按「已建任务 + 配置时那一组来源/模型」保存，所以 sessionId 为 null（新任务草稿）
 * 时不发 IPC，只给出空状态。写入走与 Agent 控制面完全相同的一条主进程路径，
 * 界面这边只负责读回结果、失效标记与错误文案。
 */
export function useSessionUsageLimitFallback(
  sessionId: string | null,
): SessionUsageLimitFallbackState {
  const [target, setTargetState] = useState<SessionUsageLimitFallbackTarget | null>(null);
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<UsageLimitFallbackErrorCode | null>(null);
  const mountedRef = useRef(true);
  /** 写入是异步的：回来时要确认任务没被换掉，否则旧任务的目标会显示到新任务上。 */
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!sessionId) {
      setTargetState(null);
      setStale(false);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    // 换任务时先清掉上一个任务的状态：读取失败不能把旧目标当成新任务的配置显示。
    setTargetState(null);
    setStale(false);
    setLoading(true);
    setError(null);
    // 宿主可能比 renderer 老（preload 里没有这个方法）：同步 TypeError 进不了 .catch，
    // 会在 effect 里直接抛掉，所以先确认可调用再发请求。
    const read = window.electronAPI?.maker?.sessionUsageLimitFallbackGet;
    if (typeof read !== 'function') {
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    void read(sessionId)
      .then((state) => {
        if (cancelled) return;
        setTargetState(state.target);
        // 没有策略就没有「失效」可言。
        setStale(state.target ? state.stale : false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(readErrorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const applyMutation = useCallback(
    (result: SessionUsageLimitFallbackMutation, forSessionId: string): boolean => {
      // 写入期间切了任务：这次结果属于上一个任务，不能回写当前 state。
      if (!mountedRef.current || sessionIdRef.current !== forSessionId) return result.ok;
      if (!result.ok) {
        setError(result.message);
        setErrorCode(result.errorCode);
        return false;
      }
      setTargetState(result.target);
      // 写入时的来源就是当前组合，所以刚写完一定不是失效态。
      setStale(false);
      setErrorCode(null);
      return true;
    },
    [],
  );

  const setTarget = useCallback(
    async (next: SessionUsageLimitFallbackTarget): Promise<boolean> => {
      if (!sessionId) return false;
      setLoading(true);
      setError(null);
      try {
        const result = await window.electronAPI.maker.sessionUsageLimitFallbackSet?.(sessionId, next);
        if (!result) return false;
        return applyMutation(result, sessionId);
      } catch (cause) {
        if (mountedRef.current && sessionIdRef.current === sessionId) setError(readErrorMessage(cause));
        return false;
      } finally {
        if (mountedRef.current && sessionIdRef.current === sessionId) setLoading(false);
      }
    },
    [applyMutation, sessionId],
  );

  const clearTarget = useCallback(async (): Promise<boolean> => {
    if (!sessionId) return false;
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.maker.sessionUsageLimitFallbackClear?.(sessionId);
      if (!result) return false;
      return applyMutation(result, sessionId);
    } catch (cause) {
      if (mountedRef.current && sessionIdRef.current === sessionId) setError(readErrorMessage(cause));
      return false;
    } finally {
      if (mountedRef.current && sessionIdRef.current === sessionId) setLoading(false);
    }
  }, [applyMutation, sessionId]);

  return { target, stale, loading, error, errorCode, setTarget, clearTarget };
}
