import { useEffect, useRef, useState } from 'react';

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
  // env-key」与「还没查到」。需要区分的消费方(如计费入口门控)用 resolved。
  // resolved 不是独立布尔:它记录「真值属于哪个 refreshKey」,并在**渲染期**与
  // 当前 key 比对——切会话(refreshKey 变化)的同一帧即为未解析,不存在
  // 「effect 重置前泄漏一帧旧真值」的窗口(PR review P1)。
  const [resolution, setResolution] = useState<{ key: unknown } | null>(null);
  // push / auth 恢复路径的回调生命周期跨越 refreshKey 变化,经 ref 取当前 key。
  const refreshKeyRef = useRef(refreshKey);
  refreshKeyRef.current = refreshKey;
  const resolved = enabled && resolution !== null && Object.is(resolution.key, refreshKey);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const myKey = refreshKey;
    window.electronAPI.maker
      .codexRuntimeRouteGet()
      .then((next) => {
        if (!cancelled) {
          setRoute(next);
          setResolution({ key: myKey });
        }
      })
      .catch(() => {
        /* keep conservative env-key default; resolution 不写 → 保持未解析 */
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, refreshKey]);

  useEffect(() => {
    if (!enabled) return undefined;
    return window.electronAPI.maker.onCodexRuntimeRouteChanged((next) => {
      setRoute(next);
      setResolution({ key: refreshKeyRef.current });
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
          if (!cancelled) {
            setRoute(next);
            // 这是首查失败后的恢复路径:拿到权威真值同样要标记已解析,
            // 否则计费门控会永久停留在「形态未定」(PR review P1)。
            setResolution({ key: refreshKeyRef.current });
          }
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
