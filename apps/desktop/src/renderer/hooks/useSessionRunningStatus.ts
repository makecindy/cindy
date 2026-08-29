/**
 * useSessionRunningStatus — F-SB-7: Session status indicator data hook.
 * ---------------------------------------------------------------------------
 * Provides two pieces of data to the Sidebar:
 *
 * 1. `runningSessionIds` — a Set of session IDs whose agent is currently running.
 *    Subscribes to ALL sessions via `makerChatStore.subscribeAll` so it
 *    reacts to any session's `isRunning` change.
 *
 * 2. `notifications` — a Set of session IDs that need the user's attention
 *    (角标点;颜色由 sessionAttentionStore 的 kind 决定:done=橙 / error=红 /
 *    awaiting=黄)。A session enters this set when (均限非 active 会话):
 *    - It transitions from running to not-running while NOT active —— 正常完成记
 *      'done'(橙),以 error 结束记 'error'(红,V5 起出错也亮角标)。
 *    - It has a pending ask-user question (`hasPendingAskUser`) while NOT
 *      being the active session —— 记 'awaiting'(黄)。
 *    - It has a pending permission request (`hasPendingPermission`) while NOT
 *      being the active session.
 *    - It has a pending plan review (`hasPendingPlanReview`) while NOT being
 *      the active session (FP-3).
 *    - It has pending local plugin setup (`hasPendingPluginSetup`) while NOT
 *      being the active session.
 *
 * Notifications are cleared when:
 *    - The user navigates to that session (clicks it) — done / awaiting only。
 *      'error' 例外:红角标是未处理告警的派生投影(hooks/usePendingAlertAttention),
 *      展示不构成已读 —— 只有用户处置横幅或告警本身消失才清。
 *    - The pending state that caused the notification disappears (e.g. the
 *      ask-user or permission was resolved elsewhere) — 同样不清 'error'。
 *
 * The notification state is in-memory only (not persisted); a page refresh
 * clears it.
 *
 * 队列去抖:排了多条队列时,turn A done → main 会几十毫秒后自动 spawn turn B。
 * 正常 done 的角标 + 系统通知都经 QUEUE_DEBOUNCE_MS 去抖:窗口内又起新 turn
 * 就取消(是自动衔接的中间态),排空到真正 idle 才触发一次。error / side-task /
 * 静默完成不走去抖(见下方分支)。
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { makerChatStore } from '@/lib/makerChatStore';
import type { SessionStatusInfo } from '@/lib/makerChatStore';
import {
  addSessionAttention,
  clearSessionAttention,
  getSessionAttentionKind,
  hasSessionAttention,
  useSessionAttentionSnapshot,
} from '@/lib/sessionAttentionStore';
import {
  clearCompletedSchedulerOwnedRunForNewActivity,
  clearCompletedSilencedRunForNewActivity,
  isSessionTerminalNotificationOwnedByScheduler,
  isSessionDoneSilenced,
} from '@/lib/silencedSessionDoneStore';
import { noteSessionTurnStartedForAlerts } from '@/hooks/usePendingAlertAttention';

// Codex maker 化后, codex session 也走 makerChatStore;
// 不再需要双 store 合并 —— 直接订阅 makerChatStore 即可。

/**
 * turn-A-done 后,main 自动 spawn turn-B 的最大间隔。经测本机 auto-drain
 * 路径通常 <100ms,给 500ms 稳定裕度。太小容易漏(队列 drain 慢弹通知),
 * 太大用户等真通知等太久。
 */
const QUEUE_DEBOUNCE_MS = 500;

interface UseSessionRunningStatusOptions {
  /**
   * Fired when a session transitions running → done. Filters out errored
   * sessions only — does NOT filter out the active session, because the
   * "should we actually notify the user" decision (focus state, etc.) is
   * the consumer's. The in-app dot still skips active session via its own
   * branch; the callback fires for any non-error done.
   */
  onSessionDone?: (sessionId: string) => void;
  /**
   * Fired when a session transitions running → terminal error. It mirrors
   * onSessionDone's no-active-session-filter policy so the consumer can gate
   * on focus state and notification channel settings.
   */
  onSessionError?: (sessionId: string) => void;
  /**
   * Fired when a session enters a pending state needing user input
   * (`pendingAskUser` / `pendingPermission` / `pendingPlanReview` /
   * `pendingPluginSetup`). Rising
   * edge only — re-fires only after the pending state clears and re-enters.
   * Like onSessionDone, no active-session filter; the consumer decides.
   */
  onSessionNeedsReply?: (sessionId: string) => void;
}

/**
 * @param activeSessionId - The currently viewed session ID (from URL match).
 * @param options - Optional callbacks for transition side effects.
 */
export function useSessionRunningStatus(
  activeSessionId: string | undefined,
  options?: UseSessionRunningStatusOptions,
) {
  // Codex maker 化后, codex 与 Claude 共用 makerChatStore;
  // sidebar 的 running 三点指示器对两个 vendor 一视同仁, 单 store 订阅即可。
  const statusMap = useSyncExternalStore(
    makerChatStore.subscribeAll,
    makerChatStore.getRunningSnapshot,
    makerChatStore.getRunningSnapshot,
  );

  // Latest callbacks — kept in refs so the transition effect doesn't
  // re-run when the caller passes inline lambdas each render.
  const onSessionDoneRef = useRef(options?.onSessionDone);
  const onSessionErrorRef = useRef(options?.onSessionError);
  const onSessionNeedsReplyRef = useRef(options?.onSessionNeedsReply);
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  useEffect(() => {
    onSessionDoneRef.current = options?.onSessionDone;
    onSessionErrorRef.current = options?.onSessionError;
    onSessionNeedsReplyRef.current = options?.onSessionNeedsReply;
  }, [options?.onSessionDone, options?.onSessionError, options?.onSessionNeedsReply]);

  // Track previous running set to detect running -> done transitions
  const prevRunningRef = useRef(new Set<string>());

  // Track which sessions had pending states last cycle, so we can detect
  // when pending states disappear and auto-clear notifications.
  const prevPendingRef = useRef(new Set<string>());

  /**
   * Pending done-notifications waiting for a debounce window to expire.
   * 场景:用户排了队列,turn A done → main 会几十毫秒后自动 spawn turn B。
   * 基于状态的 `hasQueuedNext` 检查不够 robust(main 有可能先清 pendingQueue
   * 再发 running=false 的 projection);改用时间去抖:done 后先塞进这张 map,
   * QUEUE_DEBOUNCE_MS 内若同 session 又开新 turn,取消这次 fire(是自动衔接);
   * 时限内没起新 turn 才真正弹通知 + 亮角标。
   */
  const pendingDoneTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const notifications = useSessionAttentionSnapshot();

  // Detect transitions that should add or remove notifications.
  useEffect(() => {
    const currentRunningSet = deriveRunningSet(statusMap);
    const prevRunning = prevRunningRef.current;

    // --- 1. Detect new turn starts ---
    for (const sessionId of currentRunningSet) {
      if (!prevRunning.has(sessionId)) {
        // 只清「run 已终态」的标记(用户手动起的新对话或下一个 run);run 还在跑时
        // 是 subagent 续 turn / silent-stop 自动续跑,标记必须留着。兜底定时器不在
        // 这里动 —— 统一由本 effect 末尾的对账按当前 running 状态处理。
        clearCompletedSilencedRunForNewActivity(sessionId);
        clearCompletedSchedulerOwnedRunForNewActivity(sessionId);
        // error 红角标与真实错误态同步:新 turn 启动会清掉 store 的终止错误
        // (staleErrorClearedOnTurnStart),若此时角标还是 'error' 就成了 orphan——
        // 活跃会话的 done 分支不覆写它,角标会永久残留。错误已不存在,这里显式清除
        // (explicit 才能过 store 咽喉);新 turn 的结局(done/error)会按最新状态
        // 重新挂角标,提醒不丢失。
        // 与派生红点(usePendingAlertAttention)一致:turn 启动会插入新的 user 行,
        // 原 error 行不再是尾行,pending-alerts 也不再命中 —— 两条路径同向收敛。
        // hasSessionTerminalError 仍为 true 时不清(mivo 等 skipTurnReset 上升沿
        // 不拆横幅);派生账本另走 noteSessionTurnStartedForAlerts,只在仍认领
        // 错误尾行时重算,横幅已灭则差分熄灭红点。
        if (
          getSessionAttentionKind(sessionId) === 'error' &&
          !makerChatStore.hasSessionTerminalError(sessionId)
        ) {
          clearSessionAttention(sessionId, { intent: 'explicit' });
        }
        noteSessionTurnStartedForAlerts(sessionId);
        // Queue auto-drain cancellation:如果此 session 有 pending done 定时器
        // (刚 turn done 还在 debounce 窗口内),说明 main 正在自动衔接下一条队列
        // 消息 —— 取消这次通知/角标 fire。用户视角这是一条完整任务的中间态。
        const pendingTimer = pendingDoneTimersRef.current.get(sessionId);
        if (pendingTimer !== undefined) {
          clearTimeout(pendingTimer);
          pendingDoneTimersRef.current.delete(sessionId);
        }
      }
    }

    // --- 2. Detect running -> done transitions ---
    for (const sessionId of prevRunning) {
      if (!currentRunningSet.has(sessionId)) {
        // Session transitioned from running -> not running.
        const info = statusMap.get(sessionId);
        // side-task(mivo 等 skipTurnReset)的结束不是 turn 终态:done/error/角标/
        // 通知全部跳过。transition entry 只存活一个投递窗口(store 调度清除),
        // 本 effect 若晚于清除运行会拿到 info===undefined,用 store 兜底查询
        // (与 hasError fallback 同款)。
        const isSideTaskStop = info?.sideTask ?? makerChatStore.wasLastStopSideTask(sessionId);
        if (isSideTaskStop) continue;
        // The transition entry lives in the snapshot only until the store's
        // scheduled clear fires — this effect may observe the generation where
        // the entry is already gone (info === undefined). Falling back to
        // `false` here was the root cause of failed turns being notified as
        // "done"; always resolve errors against the authoritative store.
        const hasError = info?.hasError ?? makerChatStore.hasSessionTerminalError(sessionId);
        // 两个查询都无副作用、且在 run 存续期间对每次 done 转换都成立:一个静默
        // run 内 running→done 会翻转多次(后台 subagent 续 turn、silent-stop 自动
        // 续跑),标记若被第一次中间 done 消费掉,最终那次真 done 就会当成普通完成
        // 把系统通知发出去。标记的清除只由 scheduler 事件驱动,见
        // silencedSessionDoneStore 的文件头注释。
        const isSilencedDone = !hasError && isSessionDoneSilenced(sessionId);
        // Scheduler 已按 schedule.notify 接管这次终态的桌面 / 飞书通知。这里只
        // 抑制 callback，侧栏 / Dock attention 仍按普通 done/error 逻辑保留。
        const notificationOwnedByScheduler =
          isSessionTerminalNotificationOwnedByScheduler(sessionId);
        // error 立刻处理:队列会被 abort,不存在"下一条自动接着跑"的场景;红角标 +
        // 系统通知(onSessionError,由 renderer 侧 gate focus)都马上触发,不走
        // debounce。出错永不静默:失败的后台 turn 不能伪装成正常完成或悄无声息消失。
        if (hasError) {
          // 即使是当前活跃会话也挂红角标:红点跟随「告警未处理」而非「是否看到」,
          // 横幅就在眼前时列表同样亮点(2026-07 统一决策)。不能沿用「活跃会话不亮」
          // 的 done 语义。清除只能来自用户处置横幅或 pending-alerts 派生收敛。
          addSessionAttention(sessionId, 'error');
          if (!notificationOwnedByScheduler) onSessionErrorRef.current?.(sessionId);
          continue;
        }

        // 静默完成(scheduled automation 等):既不亮角标也不发系统通知,直接跳过、
        // 不进 debounce 调度。中间 done 与最终 done 都会走到这里。
        if (isSilencedDone) continue;

        // 正常 done:走 debounce。QUEUE_DEBOUNCE_MS 内若同 session 又变 running
        // (main 自动衔接下一条队列),上面的 "--- 1. Detect new turn starts ---"
        // 分支会 clearTimeout 取消这次。窗口过完仍是 not-running,才认为队列真的
        // 排空 idle,再触发通知 + 亮角标。debounce 用时间维度解耦 main 侧「先清
        // pendingQueue 再发 running=false projection」的时序,比 hasQueuedNext
        // 状态判断更 robust。存量 pending 若存在(理论上不会:起新 turn 就清了),覆盖掉。
        const existing = pendingDoneTimersRef.current.get(sessionId);
        if (existing !== undefined) clearTimeout(existing);
        const wasActiveAtCompletion = sessionId === activeSessionId;
        const timer = setTimeout(() => {
          pendingDoneTimersRef.current.delete(sessionId);
          // 落地前重查一次当前状态:若此刻会话正等待用户输入(ask-user / permission /
          // plan-review),不要用 done 橙角标覆盖 section 3 已亮的 awaiting 黄角标 ——
          // 否则「需要处理的交互」被降级成「已完成」,用户看不到。非 debounce 版本里
          // section 3 在 section 2 之后跑、awaiting 天然覆盖 done;debounce 把 done 推迟到
          // section 3 之后,必须显式让 awaiting 优先。done 系统通知仍照常发(与原行为一致)。
          const cur = makerChatStore.getRunningSnapshot().get(sessionId);
          const isActive = sessionId === activeSessionIdRef.current;
          const isRunning = cur?.isRunning === true;
          // debounce 期间下一轮可能在真正进入 running 前失败并写入 terminal error。
          // error 红点由现有告警 owner 投影；这里必须避免旧 run 的延迟 done 把它
          // 覆盖成橙点，或再发一条过期的完成通知。starting 本身不作为抑制条件：
          // 侧栏已把它显示为 running，保留旧 done 才能在启动失败时继续提醒用户。
          const hasTerminalError = makerChatStore.hasSessionTerminalError(sessionId);
          const stillPending =
            !!cur &&
            (cur.hasPendingAskUser ||
              cur.hasPendingPermission ||
              cur.hasPendingPlanReview ||
              cur.hasPendingPluginSetup);
          if (
            !wasActiveAtCompletion &&
            !isActive &&
            !isRunning &&
            !hasTerminalError &&
            !stillPending
          ) {
            addSessionAttention(sessionId, 'done');
          }
          if (!notificationOwnedByScheduler && !hasTerminalError) {
            onSessionDoneRef.current?.(sessionId);
          }
        }, QUEUE_DEBOUNCE_MS);
        pendingDoneTimersRef.current.set(sessionId, timer);
      }
    }

    // --- 3. Detect pending ask-user / permission / plan-review / plugin-setup ---
    const currentPendingSet = new Set<string>();
    for (const [id, info] of statusMap) {
      if (
        info.hasPendingAskUser ||
        info.hasPendingPermission ||
        info.hasPendingPlanReview ||
        info.hasPendingPluginSetup
      ) {
        currentPendingSet.add(id);
        const isActive = id === activeSessionId;
        const wasAlreadyPending = prevPendingRef.current.has(id);
        // In-app dot + dock badge: RISING edge only (mirror onSessionNeedsReply
        // below), NOT a per-tick re-derive. A backgrounded session keeps
        // hasPendingX=true until the prompt is answered, so the old
        // `!hasSessionAttention(id)` guard re-added it on every snapshot tick:
        // the moment the user cleared the badge (clicked the session / focused
        // the window → clearAllSessionAttention), the next tick resurrected it,
        // leaving the macOS Dock red dot impossible to clear. Edge-triggering
        // means a cleared badge stays cleared until pending clears and re-enters.
        if (!isActive && !wasAlreadyPending) {
          addSessionAttention(id, 'awaiting'); // 待用户回复/选择 → 黄(V5)
        }
        // System notification callback: rising edge only, no active filter.
        // Same reasoning as onSessionDone — focus state is the consumer's
        // call. Re-firing for the same session requires the pending state
        // to clear and re-enter (prevents repeat-pings).
        if (!wasAlreadyPending) {
          onSessionNeedsReplyRef.current?.(id);
        }
      }
    }

    // --- 4. Auto-clear notifications when pending state disappears ---
    // If a session previously had a pending state but no longer does, and
    // it's not running (i.e. the notification wasn't from a done transition),
    // remove the notification. We only auto-clear for sessions that were
    // in the previous pending set — done notifications are sticky until clicked.
    for (const sessionId of prevPendingRef.current) {
      if (
        !currentPendingSet.has(sessionId) &&
        !currentRunningSet.has(sessionId) &&
        hasSessionAttention(sessionId)
      ) {
        // The pending state is gone — the session was answered/resolved elsewhere.
        // Only auto-clear if it's not also a done-transition notification.
        // Since we can't distinguish, we clear it: if it truly just finished,
        // the done transition would have re-added it above.
        // 默认 passive:store 会保住 'error' 红角标(pending 消失往往正是 run 以
        // error 终止,branch 2 刚挂上的红角标不能被这条自动清理吞掉)。
        clearSessionAttention(sessionId);
      }
    }

    prevRunningRef.current = new Set(currentRunningSet);
    prevPendingRef.current = currentPendingSet;
  }, [statusMap, activeSessionId]);

  // Unmount cleanup:清掉所有还没 fire 的 done debounce 定时器,避免 hook 卸载后
  // 定时器仍触发 addSessionAttention / onSessionDone(referring stale refs 后果小,
  // 但 leak 不干净)。
  useEffect(() => {
    const timers = pendingDoneTimersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  // When the active session changes, clear its notification if any.
  // 默认 passive:切到会话 ≠ 处置了报错。store 会保住 'error' 红角标,
  // 只有用户处置横幅或告警本身消失才清。
  useEffect(() => {
    if (!activeSessionId) return;
    clearSessionAttention(activeSessionId);
    // 完成后的 debounce 窗口内用户已经点进任务,说明这次完成已被消费。
    // 直接取消待落地的 done,避免用户很快切走后定时器再补橙点并抬升排序。
    const pendingTimer = pendingDoneTimersRef.current.get(activeSessionId);
    if (pendingTimer !== undefined) {
      clearTimeout(pendingTimer);
      pendingDoneTimersRef.current.delete(activeSessionId);
    }
  }, [activeSessionId]);

  const clearNotification = useCallback((sessionId: string) => {
    // 默认 passive:点击会话卡片只导航,'error' 红角标由 store 保住。
    clearSessionAttention(sessionId);
  }, []);

  // Derive running set for the return value (outside effect, for rendering).
  // 必须 memo:裸调用每渲染都 new Set,会顺着 effectiveRunningSessionIds →
  // handleActionClick / handleMoveSession 一路换引用,把 SessionItem 的 memo
  // 全表打穿(见 sidebar/SessionItem.tsx 的性能不变量第 3 条)。statusMap 来自
  // useSyncExternalStore,只在真实状态变化时换引用,故这里的缓存是安全的。
  const runningSessionIds = useMemo(() => deriveRunningSet(statusMap), [statusMap]);

  return {
    /** Set of session IDs currently running. */
    runningSessionIds,
    /** Set of session IDs needing attention (done / pending ask / pending permission). */
    notifications,
    /** Clear notification for a session (called on click). */
    clearNotification,
  } as const;
}

/** Extract the set of currently-running session IDs from the status map. */
function deriveRunningSet(statusMap: ReadonlyMap<string, SessionStatusInfo>): ReadonlySet<string> {
  const set = new Set<string>();
  for (const [id, info] of statusMap) {
    if (info.isRunning) set.add(id);
  }
  return set;
}
