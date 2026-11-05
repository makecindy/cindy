/**
 * useSessionSwitchFocusIntent —— 切换到某个任务后，「把焦点交给它的确认卡」这件事只在
 * 切换那一刻成立。
 *
 * 从侧栏点开一个正在等授权的任务，焦点还停在侧栏行上，回车会被那一行认领，用户只能
 * 再去点按钮。这里在「本视图当前承载的任务」变化时武装一次意图，确认卡渲染出来后
 * 消费掉它，把焦点放到确认按钮上，直接按回车就能批准。
 *
 * 「承载的任务」= enabled 时的 sessionId。两种切换都算：
 * - 同一视图换了 sessionId（含首次挂载）；
 * - sessionId 不变、视图从不可用变为可用：分屏里已挂载的 pane 被选中成为主视图时，
 *   它的 sessionId 不变，只是拿到了路由主权。
 *
 * 意图绑定到切换那一刻已经挂起的授权请求（按 requestId）：
 * - 本地已有挂起请求时直接用它；
 * - 否则向任务所在的 Host 查一次挂起交互（新窗口、刷新后本地状态还没重建，侧栏活动快照
 *   也可能还是空的），查到之前意图处于「待定」。
 * 只有确认卡展示的正是这些请求之一时才聚焦。切到一个还没要授权的任务、或交接的请求在
 * 恢复期间被别处处理掉又来了新请求，新请求都不抢焦点。
 *
 * 待确认请求可能晚于切换到达（历史与挂起交互是异步重建的），所以意图会一直保留到
 * 被消费、或用户在此期间有任何点击 / 按键为止：用户已经开始做别的事，之后到来的
 * 请求不应该把焦点抢走。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface SessionSwitchFocusIntent {
  /** 确认卡展示的请求是否正是这次切换要交接的那一个。 */
  armed: boolean;
  /** 确认卡已接管焦点（或不再需要），撤销意图。 */
  consume: () => void;
}

/** 切换目标；requestIds 为 null 表示还在向 Host 查询切换时挂起的授权请求。 */
interface SwitchTarget {
  sessionId: string;
  requestIds: readonly string[] | null;
}

function targetFor(sessionId: string | null, pendingRequestId: string | null): SwitchTarget | null {
  if (!sessionId) return null;
  return { sessionId, requestIds: pendingRequestId ? [pendingRequestId] : null };
}

export function useSessionSwitchFocusIntent(
  sessionId: string | undefined,
  enabled: boolean,
  /** 本地当前展示的授权请求 id。 */
  pendingRequestId: string | null,
  /** 向任务所在的 Host 查询当前挂起的授权请求 id。 */
  queryPendingPermissionIds: (sessionId: string) => Promise<readonly string[]>,
): SessionSwitchFocusIntent {
  const activeSessionId = enabled && sessionId ? sessionId : null;
  const [target, setTarget] = useState<SwitchTarget | null>(() =>
    targetFor(activeSessionId, pendingRequestId),
  );
  const pendingRef = useRef(pendingRequestId);
  pendingRef.current = pendingRequestId;
  const queryRef = useRef(queryPendingPermissionIds);
  queryRef.current = queryPendingPermissionIds;
  // 首次挂载的意图已由初值武装；ref 跳过挂载那次 effect，免得确认卡（子组件 effect
  // 先于本 effect 执行）刚消费掉，这里又把它重新武装。
  const lastActiveSessionIdRef = useRef(activeSessionId);

  useEffect(() => {
    if (lastActiveSessionIdRef.current === activeSessionId) return;
    lastActiveSessionIdRef.current = activeSessionId;
    setTarget(targetFor(activeSessionId, pendingRef.current));
  }, [activeSessionId]);

  // 待定时查一次。结果回来前用户已有操作、或又切换了任务，target 已经换了，结果作废。
  // 查询失败按「没有挂起请求」处理：宁可不聚焦，也不替一个不确定的请求抢焦点。
  useEffect(() => {
    if (!target || target.requestIds !== null) return;
    let cancelled = false;
    const settle = (ids: readonly string[]) => {
      if (cancelled) return;
      setTarget((current) =>
        current === target ? (ids.length > 0 ? { ...current, requestIds: ids } : null) : current,
      );
    };
    queryRef.current(target.sessionId).then(settle, () => settle([]));
    return () => {
      cancelled = true;
    };
  }, [target]);

  const live = enabled && !!sessionId && target?.sessionId === sessionId;
  const armed =
    live &&
    pendingRequestId !== null &&
    (target?.requestIds?.includes(pendingRequestId) ?? false);

  // 触发切换的那次点击 / 回车在本监听挂上之前已经分发完，不会把刚武装的意图撤掉。
  // 切换时仍按着的 Enter / 空格会继续产生重复 keydown；武装之后的重复只可能来自这种
  // 延续的按键（新按下的键第一下 repeat 为 false，已经撤销了意图），不算用户新的操作，
  // 否则确认卡晚一点重建出来时就拿不到焦点。
  // 读屏等辅助技术「激活」一个控件时，可能只派发一次可信的 click，前面没有 pointerdown /
  // keydown，所以也监听可信 click。代码里的 .click()（isTrusted=false）不是用户操作，不撤销。
  useEffect(() => {
    if (!live) return;
    const disarm = () => setTarget(null);
    const disarmOnKey = (e: KeyboardEvent) => {
      if (!e.repeat) disarm();
    };
    const disarmOnClick = (e: MouseEvent) => {
      if (e.isTrusted) disarm();
    };
    window.addEventListener('pointerdown', disarm, true);
    window.addEventListener('keydown', disarmOnKey, true);
    window.addEventListener('click', disarmOnClick, true);
    return () => {
      window.removeEventListener('pointerdown', disarm, true);
      window.removeEventListener('keydown', disarmOnKey, true);
      window.removeEventListener('click', disarmOnClick, true);
    };
  }, [live]);

  const consume = useCallback(() => setTarget(null), []);

  return { armed, consume };
}
