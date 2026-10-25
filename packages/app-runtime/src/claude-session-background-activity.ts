/**
 * claude-session-background-activity —— 「turn 已结束但该会话的 CC 子进程仍在
 * 调模型」的检测与广播(2026-07-13 假停止烧 token 事故的产品修复,方案:保留
 * 后台子任务,但必须对用户可见 + 可一键全停)。
 *
 * 背景:Claude Code 的后台子 agent 不跟随单个 turn 的生死 —— turn 报错 / 结束后
 * 它们继续在常驻子进程里跑、持续调 API 计费,而 UI 的运行状态只看 turn,用户
 * 看到「已停止」却在持续扣费。本模块以 loopback proxy 观察到的 per-session API
 * 活动为信号(代码确定性,规则 9),在「无 turn 在跑 + turn 结束之后仍有 API
 * 活动」时判定该会话存在后台活动,推给 renderer 显示横幅与「全部停止」入口
 * (全停 = host 调 maker.closeSession 杀常驻子进程,会话下次发消息自动续)。
 *
 * 判定式:active :=
 *      !turnRunning
 *   && lastTurnEndAt > 0                                    // 本次 app 生命周期内跑过 turn
 *   && lastActivityAt > lastTurnEndAt + TURN_END_GRACE_MS   // 排除 turn 自身收尾的余波
 *   && now - lastActivityAt <= ACTIVITY_WINDOW_MS           // 静默超窗自动熄灭
 *
 * sdkSessionId 粘滞缓存:rewind 重建(三件套)后活跃 handle 换新 sdkSessionId,
 * 而遗留子 agent 仍拿旧 id 发请求 —— resolver 只认当前活跃 id 会漏归因(正是
 * 事故里的形态),这里把解析成功过的映射记住(容量有限防无界),旧 id 请求仍能
 * 归到会话。
 *
 * 覆盖边界:仅本机 claude-code 会话(信号源是本机 loopback proxy)。SSH 远程
 * 工作区的 CC 进程与 proxy 都在远端,本模块观察不到;codex 无子 agent 概念,
 * 不在本期范围。
 */

import type { ResponseObserver } from '@cindy/anthropic-compat-proxy';
import type {DbLogger} from '@cindy/runtime-db/logging';


interface SessionActivityState {
  lastActivityAt: number;
  /** 最近一次 turn 结束时刻;0 = 本次 app 生命周期内还没跑完过 turn。 */
  lastTurnEndAt: number;
  turnRunning: boolean;
  active: boolean;
  offTimer: NodeJS.Timeout | null;
}
export function createClaudeSessionBackgroundActivity(createLogger: (name:string)=>DbLogger) {



const log = createLogger('claude-bg-activity');

/** 活动静默窗:超过该时长没有任何 API 活动即视为后台任务已停。 */
const ACTIVITY_WINDOW_MS = 30_000;
/** turn 结束后的宽限:排除最后一笔主线请求的收尾字节被误判为后台活动。 */
const TURN_END_GRACE_MS = 2_500;
/** sdkSessionId → sessionId 粘滞缓存容量(防无界;单机会话数远小于此)。 */
const STICKY_CACHE_LIMIT = 512;
/** 响应流 onData 的记录节流:SSE 每 chunk 都进,毫秒级 set 也没必要。 */
const STREAM_TOUCH_THROTTLE_MS = 5_000;

const states = new Map<string, SessionActivityState>();
/** 解析成功过的 sdkSessionId → xdt sessionId(插入序即 LRU 近似,超限删最老)。 */
const stickySdkToSession = new Map<string, string>();

let broadcaster: ((payload: { sessionId: string; active: boolean }) => void) | null = null;

/** host(register 阶段)注入广播函数;null = 卸载(测试收尾用)。 */
function setClaudeBackgroundActivityBroadcaster(
  fn: ((payload: { sessionId: string; active: boolean }) => void) | null,
): void {
  broadcaster = fn;
}

function ensureState(sessionId: string): SessionActivityState {
  let st = states.get(sessionId);
  if (!st) {
    st = { lastActivityAt: 0, lastTurnEndAt: 0, turnRunning: false, active: false, offTimer: null };
    states.set(sessionId, st);
  }
  return st;
}

function shouldBeActive(st: SessionActivityState, now: number): boolean {
  return (
    !st.turnRunning &&
    st.lastTurnEndAt > 0 &&
    st.lastActivityAt > st.lastTurnEndAt + TURN_END_GRACE_MS &&
    now - st.lastActivityAt <= ACTIVITY_WINDOW_MS
  );
}

function setActive(sessionId: string, st: SessionActivityState, next: boolean): void {
  if (st.active === next) return;
  st.active = next;
  if (!next && st.offTimer) {
    clearTimeout(st.offTimer);
    st.offTimer = null;
  }
  log.info(next ? 'session background activity detected' : 'session background activity cleared', {
    sessionId,
  });
  try {
    broadcaster?.({ sessionId, active: next });
  } catch (err) {
    log.warn('background activity broadcast threw', { sessionId, error: String(err) });
  }
}

/** active 期间挂静默倒计时;到点重评,仍活跃则按新活动时刻续档。 */
function armOffTimer(sessionId: string, st: SessionActivityState): void {
  if (st.offTimer) return;
  const delay = Math.max(50, st.lastActivityAt + ACTIVITY_WINDOW_MS - Date.now() + 50);
  st.offTimer = setTimeout(() => {
    st.offTimer = null;
    const now = Date.now();
    if (shouldBeActive(st, now)) {
      armOffTimer(sessionId, st);
      return;
    }
    setActive(sessionId, st, false);
  }, delay);
}

function evaluate(sessionId: string, st: SessionActivityState): void {
  const now = Date.now();
  const next = shouldBeActive(st, now);
  setActive(sessionId, st, next);
  if (next) armOffTimer(sessionId, st);
}

/**
 * proxy 侧记录一笔该 sdkSessionId 的 API 活动。resolvedSessionId 为 host 用
 * 当前活跃会话表反解的结果(null = 当前解析不到,尝试粘滞缓存兜底)。
 */
function recordClaudeApiActivity(sdkSessionId: string, resolvedSessionId: string | null): void {
  let sessionId = resolvedSessionId;
  if (sessionId) {
    if (!stickySdkToSession.has(sdkSessionId)) {
      stickySdkToSession.set(sdkSessionId, sessionId);
      if (stickySdkToSession.size > STICKY_CACHE_LIMIT) {
        const oldest = stickySdkToSession.keys().next().value;
        if (oldest !== undefined) stickySdkToSession.delete(oldest);
      }
    }
  } else {
    sessionId = stickySdkToSession.get(sdkSessionId) ?? null;
  }
  if (!sessionId) return;
  const st = ensureState(sessionId);
  st.lastActivityAt = Date.now();
  evaluate(sessionId, st);
}

/**
 * host 的 turn 运行态边沿(register 的 status/isRunning 事件处接线)。
 * 只在真实边沿更新 lastTurnEndAt —— 重复的 not-running 状态若反复推后
 * lastTurnEndAt,后台活动会被永久掩盖。
 */
function noteClaudeSessionTurnState(sessionId: string, running: boolean): void {
  const st = ensureState(sessionId);
  if (st.turnRunning === running) return;
  st.turnRunning = running;
  if (running) {
    // turn 期间的 API 活动是正常主线流量,后台横幅熄灭。
    setActive(sessionId, st, false);
  } else {
    st.lastTurnEndAt = Date.now();
    // turn 刚结束:此刻的 lastActivityAt 必然 ≤ lastTurnEndAt,不会立即误亮;
    // 之后若仍有请求进来(后台子 agent),record 路径会重新评估点亮。
    setActive(sessionId, st, false);
  }
}

/** 会话进程被关闭 / 会话被删除时清账(广播熄灭)。 */
function clearClaudeSessionBackgroundActivity(sessionId: string): void {
  const st = states.get(sessionId);
  if (!st) return;
  setActive(sessionId, st, false);
  if (st.offTimer) {
    clearTimeout(st.offTimer);
    st.offTimer = null;
  }
  states.delete(sessionId);
}

/** renderer 初始查询用快照。 */
function getClaudeSessionBackgroundActivity(sessionId: string): boolean {
  return states.get(sessionId)?.active === true;
}

/** 当前处于后台活动态的全部会话 id(renderer 侧边栏挂载时的初始快照)。 */
function listActiveClaudeBackgroundActivitySessions(): string[] {
  const ids: string[] = [];
  for (const [sessionId, st] of states) {
    if (st.active) ids.push(sessionId);
  }
  return ids;
}

/** 测试收尾:清空全部状态与定时器。 */
function resetClaudeBackgroundActivityForTests(): void {
  for (const [sessionId, st] of states) {
    if (st.offTimer) clearTimeout(st.offTimer);
    void sessionId;
  }
  states.clear();
  stickySdkToSession.clear();
  broadcaster = null;
}

/**
 * 组合进 cc loopback proxy 的响应观察器:请求头带 x-claude-code-session-id 的
 * 响应,按节流刷新该会话的活动时刻 —— 覆盖「一笔长 SSE 跨过 turn 结束点仍在
 * 吐字」的场景(事故现场正是遗留子 agent 的长流)。零 body 解析,只摸时间戳。
 */
function createClaudeSessionActivityResponseObserver(
  resolveSessionId: (sdkSessionId: string) => string | null,
): ResponseObserver {
  return ({ requestHeaders }) => {
    const sdkSessionId = requestHeaders['x-claude-code-session-id'];
    if (!sdkSessionId) return null;
    let lastTouch = 0;
    const touch = (): void => {
      const now = Date.now();
      if (now - lastTouch < STREAM_TOUCH_THROTTLE_MS) return;
      lastTouch = now;
      recordClaudeApiActivity(sdkSessionId, resolveSessionId(sdkSessionId));
    };
    touch();
    return { onData: touch, onEnd: touch, onError: touch };
  };
}
return {
  setClaudeBackgroundActivityBroadcaster,
  recordClaudeApiActivity,
  noteClaudeSessionTurnState,
  clearClaudeSessionBackgroundActivity,
  getClaudeSessionBackgroundActivity,
  listActiveClaudeBackgroundActivitySessions,
  resetClaudeBackgroundActivityForTests,
  createClaudeSessionActivityResponseObserver
};
}
