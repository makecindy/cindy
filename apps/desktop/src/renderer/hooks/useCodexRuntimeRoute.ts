import { useEffect, useState } from 'react';

export type CodexAuthInjection = 'oauth-bearer' | 'env-key' | 'provider-oauth';

export interface CodexRuntimeRoute {
  authInjection: CodexAuthInjection;
}

/**
 * useCodexRuntimeRoute — 读取 Codex app-server 当前进程启动时冻结的实际路由。
 *
 * 这个值和当前登录态不同: 用户可以在 env-key host 启动后再登录 OAuth,运行中的
 * host 仍然走 gateway。右下角用量 chip 必须按这个 runtime route 显示订阅/API 形态。
 */
export function useCodexRuntimeRoute(options?: { enabled?: boolean; refreshKey?: unknown }) {
  const enabled = options?.enabled ?? true;
  const refreshKey = options?.refreshKey;
  const [route, setRoute] = useState<CodexRuntimeRoute>({
    authInjection: 'env-key',
  });
  // authInjection 在真值回来前是保守占位('env-key'),消费方无法区分「真的是
  // env-key」与「还没查到」。需要区分的消费方(如计费入口门控)用 resolved:
  // 首次 get 成功或收到 push 后才为 true;get 失败保持 false(形态未定)。
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    window.electronAPI.maker
      .codexRuntimeRouteGet()
      .then((next) => {
        if (!cancelled) {
          setRoute(next);
          setResolved(true);
        }
      })
      .catch(() => {
        /* keep conservative env-key default */
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, refreshKey]);

  useEffect(() => {
    if (!enabled) return undefined;
    return window.electronAPI.maker.onCodexRuntimeRouteChanged((next) => {
      setRoute(next);
      setResolved(true);
    });
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const off = window.electronAPI.maker.auth.onStateChanged((payload) => {
      if (payload.agentKind !== 'codex') return;
      window.electronAPI.maker
        .codexRuntimeRouteGet()
        .then((next) => {
          if (!cancelled) setRoute(next);
        })
        .catch(() => {
          /* keep current route */
        });
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [enabled]);

  return { ...route, resolved };
}
