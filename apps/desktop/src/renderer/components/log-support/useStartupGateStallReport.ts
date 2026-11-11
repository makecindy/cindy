import { useEffect, useRef } from 'react';

import {
  STARTUP_GATE_STALL_AFTER_MS,
  clampStartupGateStallMs,
  type StartupGateStallSnapshot,
} from '../../../shared/startupGateStall';

export type StartupGateState = Omit<
  StartupGateStallSnapshot,
  'elapsedMs' | 'waitingMs' | 'documentVisible'
>;

/**
 * 启动门挡住主界面超过阈值时,向 main 上报一次各启动门的状态。
 *
 * 用户反馈「卡在开屏」时,主进程日志可能一切正常(已登录、数据库就绪),却说不出是哪个门
 * 没放行。只认「等待中」:登录面板已显示说明是在等用户登录,不算卡住。阈值从这一段等待
 * 开始时算起——在登录页停留很久后再登录,数据库准备的那一小段不能立刻算超时。每次 renderer
 * 加载最多报一次,快照取上报那一刻的最新值。
 */
export function useStartupGateStallReport(waiting: boolean, state: StartupGateState): void {
  const loadedAtRef = useRef(Date.now());
  const stateRef = useRef(state);
  stateRef.current = state;
  const reportedRef = useRef(false);

  useEffect(() => {
    if (!waiting || reportedRef.current) return;
    const waitingSince = Date.now();
    const timer = window.setTimeout(() => {
      reportedRef.current = true;
      const now = Date.now();
      window.electronAPI?.reportStartupGateStall?.({
        ...stateRef.current,
        elapsedMs: clampStartupGateStallMs(now - loadedAtRef.current),
        waitingMs: clampStartupGateStallMs(now - waitingSince),
        documentVisible: document.visibilityState === 'visible',
      });
    }, STARTUP_GATE_STALL_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [waiting]);
}
