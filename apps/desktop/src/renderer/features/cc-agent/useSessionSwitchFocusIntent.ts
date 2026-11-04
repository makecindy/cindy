/**
 * useSessionSwitchFocusIntent —— 切换到某个任务后，「把焦点交给它的确认卡」这件事只在
 * 切换那一刻成立。
 *
 * 从侧栏点开一个正在等授权的任务，焦点还停在侧栏行上，回车会被那一行认领，用户只能
 * 再去点按钮。这里在 sessionId 变化（含首次挂载）时武装一次意图，确认卡渲染出来后
 * 消费掉它，把焦点放到确认按钮上，直接按回车就能批准。
 *
 * 待确认请求可能晚于切换到达（历史与挂起交互是异步重建的），所以意图会一直保留到
 * 被消费、或用户在此期间有任何点击 / 按键为止：用户已经开始做别的事，之后到来的
 * 请求不应该把焦点抢走。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface SessionSwitchFocusIntent {
  /** 当前任务是否还有未消费的「切换后聚焦」意图。 */
  armed: boolean;
  /** 确认卡已接管焦点（或不再需要），撤销意图。 */
  consume: () => void;
}

export function useSessionSwitchFocusIntent(
  sessionId: string | undefined,
  enabled: boolean,
): SessionSwitchFocusIntent {
  const [armedFor, setArmedFor] = useState<string | null>(() =>
    enabled && sessionId ? sessionId : null,
  );
  const lastSessionIdRef = useRef(sessionId);

  useEffect(() => {
    if (!enabled) {
      setArmedFor(null);
      return;
    }
    if (lastSessionIdRef.current === sessionId) return;
    lastSessionIdRef.current = sessionId;
    setArmedFor(sessionId ?? null);
  }, [enabled, sessionId]);

  const armed = enabled && !!sessionId && armedFor === sessionId;

  // 触发切换的那次点击 / 回车在本监听挂上之前已经分发完，不会把刚武装的意图撤掉。
  useEffect(() => {
    if (!armed) return;
    const disarm = () => setArmedFor(null);
    window.addEventListener('pointerdown', disarm, true);
    window.addEventListener('keydown', disarm, true);
    return () => {
      window.removeEventListener('pointerdown', disarm, true);
      window.removeEventListener('keydown', disarm, true);
    };
  }, [armed]);

  const consume = useCallback(() => setArmedFor(null), []);

  return { armed, consume };
}
