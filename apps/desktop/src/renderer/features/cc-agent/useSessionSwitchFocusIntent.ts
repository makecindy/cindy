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
 *   也可能还是空的），查到之前意图处于「待定」。任务归属还没解析时（远程任务刷新后
 *   设备镜像尚未填充）不查，免得问错 Host；归属解析后再查。
 * Host 快照是查询执行那一刻的实时读取，远程往返期间新建的请求也会出现在里面。所以每条
 * 请求要带上 Host 上已挂起的时长（pendingForMs，单调时钟），只接受「从切换到收到结果」
 * 这段时间之前就已挂起的请求。Host 侧的「现在」落在这段时间内，这个判定只会漏掉切换前
 * 一个往返内刚建的请求，不会接受切换后才建的请求。旧 Host 不带时长，按不确定处理、不聚焦。
 * 只有确认卡展示的正是这些请求之一时才聚焦。切到一个还没要授权的任务、或交接的请求在
 * 恢复期间被别处处理掉又来了新请求，新请求都不抢焦点。
 *
 * 待确认请求可能晚于切换到达（历史与挂起交互是异步重建的），所以意图会一直保留到
 * 被消费、或用户在此期间有任何点击 / 按键为止：用户已经开始做别的事，之后到来的
 * 请求不应该把焦点抢走。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { makerApiForDevice } from '@/lib/makerTransport';

export interface SessionSwitchFocusIntent {
  /** 确认卡展示的请求是否正是这次切换要交接的那一个。 */
  armed: boolean;
  /** 确认卡已接管焦点（或不再需要），撤销意图。 */
  consume: () => void;
}

/** Host 上一条挂起的授权请求；pendingForMs 缺省表示 Host 没报时长（旧版本）。 */
export interface HostPendingPermission {
  requestId: string;
  pendingForMs?: number;
}

export type QueryPendingPermissions = (
  sessionId: string,
) => Promise<readonly HostPendingPermission[]>;

/**
 * 向任务所在的 Host 查挂起的授权请求。deviceId 为 null 表示本机任务，字符串表示远程
 * 被控端；调用方必须先确认归属（undefined 时不要调用）。
 */
export async function queryHostPendingPermissions(
  deviceId: string | null,
  sessionId: string,
): Promise<readonly HostPendingPermission[]> {
  const api = deviceId ? makerApiForDevice(deviceId) : window.electronAPI.maker;
  const list: unknown = await api.getPendingInteractions(sessionId, { includeAge: true });
  if (!Array.isArray(list)) return [];
  const out: HostPendingPermission[] = [];
  for (const item of list as Array<{ request?: { kind?: unknown; requestId?: unknown }; pendingForMs?: unknown } | null>) {
    const request = item?.request;
    if (request?.kind !== 'permission' || typeof request.requestId !== 'string') continue;
    const age = item?.pendingForMs;
    out.push(
      typeof age === 'number' && Number.isFinite(age)
        ? { requestId: request.requestId, pendingForMs: age }
        : { requestId: request.requestId },
    );
  }
  return out;
}

/** 切换目标；requestIds 为 null 表示还在向 Host 查询切换时挂起的授权请求。 */
interface SwitchTarget {
  sessionId: string;
  /** 切换时刻（performance.now()），用来判断 Host 报的请求是否在切换前就已挂起。 */
  switchedAt: number;
  requestIds: readonly string[] | null;
}

function targetFor(sessionId: string | null, pendingRequestId: string | null): SwitchTarget | null {
  if (!sessionId) return null;
  return {
    sessionId,
    switchedAt: performance.now(),
    requestIds: pendingRequestId ? [pendingRequestId] : null,
  };
}

export function useSessionSwitchFocusIntent(
  sessionId: string | undefined,
  enabled: boolean,
  /** 本地当前展示的授权请求 id。 */
  pendingRequestId: string | null,
  /** 向任务所在的 Host 查询挂起的授权请求；null 表示任务归属还没解析，先不查。 */
  queryPendingPermissions: QueryPendingPermissions | null,
): SessionSwitchFocusIntent {
  const activeSessionId = enabled && sessionId ? sessionId : null;
  const [target, setTarget] = useState<SwitchTarget | null>(() =>
    targetFor(activeSessionId, pendingRequestId),
  );
  const pendingRef = useRef(pendingRequestId);
  pendingRef.current = pendingRequestId;
  const queryRef = useRef(queryPendingPermissions);
  queryRef.current = queryPendingPermissions;
  const queryReady = queryPendingPermissions !== null;
  // 首次挂载的意图已由初值武装；ref 跳过挂载那次 effect，免得确认卡（子组件 effect
  // 先于本 effect 执行）刚消费掉，这里又把它重新武装。
  const lastActiveSessionIdRef = useRef(activeSessionId);

  useEffect(() => {
    if (lastActiveSessionIdRef.current === activeSessionId) return;
    lastActiveSessionIdRef.current = activeSessionId;
    setTarget(targetFor(activeSessionId, pendingRef.current));
  }, [activeSessionId]);

  // 待定且归属已知时查一次。结果回来前用户已有操作、或又切换了任务，target 已经换了，
  // 结果作废。查询失败按「没有挂起请求」处理：宁可不聚焦，也不替一个不确定的请求抢焦点。
  useEffect(() => {
    const query = queryRef.current;
    if (!target || target.requestIds !== null || !query) return;
    let cancelled = false;
    const settle = (list: readonly HostPendingPermission[]) => {
      if (cancelled) return;
      const elapsed = performance.now() - target.switchedAt;
      const ids = list
        .filter((p) => p.pendingForMs !== undefined && p.pendingForMs >= elapsed)
        .map((p) => p.requestId);
      setTarget((current) =>
        current === target ? (ids.length > 0 ? { ...current, requestIds: ids } : null) : current,
      );
    };
    query(target.sessionId).then(settle, () => settle([]));
    return () => {
      cancelled = true;
    };
  }, [target, queryReady]);

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
  // 只认 detail === 0 的 click（键盘 / 辅助技术激活）：指针点击（detail ≥ 1）前面必有
  // pointerdown，监听挂上之后按下的已经由 pointerdown 撤销；挂上之前按下的，正是这次切换
  // 本身（分屏在 pointerdown 时就切换路由主权，路由可能在松开前就解析完），不能撤销。
  useEffect(() => {
    if (!live) return;
    const disarm = () => setTarget(null);
    const disarmOnKey = (e: KeyboardEvent) => {
      if (!e.repeat) disarm();
    };
    const disarmOnClick = (e: MouseEvent) => {
      if (e.isTrusted && e.detail === 0) disarm();
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
