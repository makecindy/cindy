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
  // 单调票据:每次发起读取 / 收到 push 都自增。读取只有在 settle 时票据仍是
  // 最新(期间没有更新的读取发起、也没有 push 落地)才允许提交——同 key 的两个
  // 在途读取(常规 + auth 触发)之间旧结果迟到也不得覆盖新真值(PR review P1)。
  const ticketRef = useRef(0);
  const resolved = enabled && resolution !== null && Object.is(resolution.key, refreshKey);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const myKey = refreshKey;
    const myTicket = ++ticketRef.current;
    window.electronAPI.maker
      .codexRuntimeRouteGet()
      .then((next) => {
        if (cancelled || ticketRef.current !== myTicket) return;
        setRoute(next);
        setResolution({ key: myKey });
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
      // push 是最新事实:直接提交,并作废所有在途读取(它们的结果不比 push 新)。
      ticketRef.current += 1;
      setRoute(next);
      setResolution({ key: refreshKeyRef.current });
    });
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const off = window.electronAPI.maker.auth.onStateChanged((payload) => {
      if (payload.agentKind !== 'codex') return;
      // 以**发起时**的 key + 票据为准:切会话(key 变化)或有更新的读取/push
      // 落地后,本次结果一律丢弃,不覆盖更新的真值(PR review P1 ×2)。
      const myKey = refreshKeyRef.current;
      const myTicket = ++ticketRef.current;
      window.electronAPI.maker
        .codexRuntimeRouteGet()
        .then((next) => {
          if (
            cancelled ||
            ticketRef.current !== myTicket ||
            !Object.is(myKey, refreshKeyRef.current)
          ) {
            return;
          }
          setRoute(next);
          // 这是首查失败后的恢复路径:拿到权威真值同样要标记已解析,
          // 否则计费门控会永久停留在「形态未定」(PR review P1)。
          setResolution({ key: myKey });
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
