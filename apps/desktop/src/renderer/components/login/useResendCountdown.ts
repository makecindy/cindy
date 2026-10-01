import { useCallback, useEffect, useRef, useState } from 'react';

import { RESEND_COUNTDOWN_MS } from './loginDesignTokens';

/**
 * useResendCountdown — 验证码重发倒计时(implementation-plan Step 3a 契约全文)。
 *
 * - 起算 = `request-code` 动作成功返回时刻(调用方在 dispatch 成功后调 arm());
 * - 模型 = 绝对 deadline(`Date.now()+60_000` 存 state,渲染 derive 剩余秒,
 *   interval 只做 tick——系统休眠/挂起恢复自校正);
 * - 重发成功 → arm() 重置 deadline;重发失败 → 调用方不调 arm,保持当前 deadline;
 * - 离开 verification-code / reset / unmount → 清理 interval 与 state
 *   (active 由调用方按 step === 'verification-code' 传入);
 * - 显示数学(v5 冻结):remaining = max(0, ceil((deadline - now)/1000));
 *   tick = 1000ms interval(每 tick 重算,非递减计数);deadline <= now 时
 *   同步切「重新发送验证码」链接;首帧显示 60。
 * - 纯 renderer 状态,不进 auth-client。
 */
/** 显示数学(Step 3a v5 冻结):remaining = max(0, ceil((deadline - now)/1000))。 */
export function resendRemainingSeconds(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

export function useResendCountdown(active: boolean): {
  /** 剩余秒;0 = 显示重发链接 */
  remaining: number;
  /** request-code 成功返回时调用:deadline = now + 60s(首帧 60) */
  arm: () => void;
} {
  const [deadline, setDeadline] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const wasActive = useRef(active);

  const arm = useCallback(() => {
    setDeadline(Date.now() + RESEND_COUNTDOWN_MS);
    setNow(Date.now());
  }, []);

  // 离开 verification-code(active true→false 沿)清理 state;interval 由下方
  // effect 的 cleanup 清(unmount 同路径)。
  useEffect(() => {
    if (wasActive.current && !active) setDeadline(null);
    wasActive.current = active;
  }, [active]);

  useEffect(() => {
    if (!active || deadline == null) return;
    if (deadline <= Date.now()) return; // 已到 0,无需 tick
    const timer = setInterval(() => {
      // 每 tick 以 Date.now 重算(挂起恢复自校正,非递减计数);到 0 后自停,
      // 避免链接态下继续每秒空转 re-render。
      const ts = Date.now();
      setNow(ts);
      if (ts >= deadline) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [active, deadline]);

  const remaining = active && deadline != null ? resendRemainingSeconds(deadline, now) : 0;
  return { remaining, arm };
}
