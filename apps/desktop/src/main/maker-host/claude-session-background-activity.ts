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
 *
 * 第二个信号源 —— 插件引擎(ACP,2026-11-20):有的外部 Agent 先回答 prompt(回合结束),
 * 再自己接着干活(推分支、建 PR、隔几分钟查一次 CI)。maker-core 把这段输出标成
 * turnScope:'background',回合结束时没报完成的工具调用也保持未完成
 * (agents/acp/translator.ts)。observePluginEngineEvent 据此点亮同一份状态,
 * 状态栏、任务列表、「全部停止」与归档守卫因此照常生效;从没有回合外工作的插件
 * 不会触发。判定在上式之外再并上两条(仍要求 !turnRunning && lastTurnEndAt > 0):
 *      engineActivityAt >= lastTurnEndAt && now - engineActivityAt <= ACTIVITY_WINDOW_MS
 *   || 有尚未到期的活动工具调用或原生命令
 * 回合外事件本身就是确定信号,不需要 proxy 那段收尾宽限。插件引擎的这部分另外通知
 * Agent Island(setPluginEngineBackgroundWorkListener),其他设备与手机的任务列表也显示运行中;
 * 内置引擎不经过这条通知。
 */

import type { ResponseObserver } from '@cindy/anthropic-compat-proxy';
import { ANTIGRAVITY_NATIVE_TOOL_NAME, type AgentEvent, type AntigravityToolActivity } from '@cindy/maker-core';
import { createLogger } from '../logger.js';

const log = createLogger('claude-bg-activity');

/** 活动静默窗:超过该时长没有任何 API 活动即视为后台任务已停。 */
const ACTIVITY_WINDOW_MS = 30_000;
/** turn 结束后的宽限:排除最后一笔主线请求的收尾字节被误判为后台活动。 */
const TURN_END_GRACE_MS = 2_500;
/** sdkSessionId → sessionId 粘滞缓存容量(防无界;单机会话数远小于此)。 */
const STICKY_CACHE_LIMIT = 512;
/** 响应流 onData 的记录节流:SSE 每 chunk 都进,毫秒级 set 也没必要。 */
const STREAM_TOUCH_THROTTLE_MS = 5_000;
/**
 * 后台命令结束 → CLI 自动续跑那一轮开始之间的空窗。期间保持「仍在工作」,任务列表不会先闪成
 * 已结束再亮回来;续跑没来时到点熄灭。
 */
const COMMAND_WORK_END_GRACE_MS = 5_000;
/**
 * 未配对的工具调用最多撑到进入后台 31 分钟，到期只清活动记录，迟到结果仍可展示。
 * 通用 ACP 保留已有的滚动静默窗，回合外的新输出可以延长尚未过期的后台活动。
 */
const PLUGIN_ENGINE_OPEN_WORK_CAP_MS = 31 * 60_000;
/** 插件引擎回合外算作「在工作」的输出(状态类事件不算)。 */
const PLUGIN_ENGINE_WORK_EVENT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'thinking',
  'tool_use',
  'tool_result',
  'tool_result_full',
]);

interface EngineWork {
  /** null means the work started in an ongoing foreground turn. */
  deadline: number | null;
  /** New in this turn, or explicitly observed making progress since it began. */
  observed: boolean;
}

interface SessionActivityState {
  lastActivityAt: number;
  /** 最近一次 turn 结束时刻;0 = 本次 app 生命周期内还没跑完过 turn。 */
  lastTurnEndAt: number;
  turnRunning: boolean;
  active: boolean;
  offTimer: NodeJS.Timeout | null;
  /** 插件引擎最近一次回合外输出的时刻;0 = 没有。 */
  engineActivityAt: number;
  engineOpenTools: Map<string, EngineWork>;
  engineOpenToolsUntil: number;
  antigravity: boolean;
  antigravitySessionInstanceId?: string;
  /** 已通知 Agent Island 的「插件引擎仍在回合外工作」。 */
  engineActive: boolean;
  /** 最近一次快照:该会话是否有仍在运行、会自己结束的后台命令(不含长驻服务)。 */
  commandWork: boolean;
  /** 已广播的「回合已结束但后台命令仍在工作」。 */
  commandWorkActive: boolean;
  commandWorkOffTimer: NodeJS.Timeout | null;
}

const states = new Map<string, SessionActivityState>();
/** 解析成功过的 sdkSessionId → xdt sessionId(插入序即 LRU 近似,超限删最老)。 */
const stickySdkToSession = new Map<string, string>();

let broadcaster: ((payload: { sessionId: string; active: boolean }) => void) | null = null;
let commandWorkBroadcaster: ((payload: { sessionId: string; active: boolean }) => void) | null =
  null;
type PluginEngineBackgroundWorkListener = (
  sessionId: string,
  active: boolean,
  options: { turnStarting: boolean },
) => void;
let pluginEngineListener: PluginEngineBackgroundWorkListener | null = null;

/** host 注入:插件引擎回合外工作开始 / 结束(给 Agent Island);null = 卸载。 */
export function setPluginEngineBackgroundWorkListener(fn: PluginEngineBackgroundWorkListener | null): void {
  pluginEngineListener = fn;
}

/** host(register 阶段)注入广播函数;null = 卸载(测试收尾用)。 */
export function setClaudeBackgroundActivityBroadcaster(
  fn: ((payload: { sessionId: string; active: boolean }) => void) | null,
): void {
  broadcaster = fn;
}

function ensureState(sessionId: string): SessionActivityState {
  let st = states.get(sessionId);
  if (!st) {
    st = {
      lastActivityAt: 0,
      lastTurnEndAt: 0,
      turnRunning: false,
      active: false,
      offTimer: null,
      engineActivityAt: 0,
      engineOpenTools: new Map(),
      engineOpenToolsUntil: 0,
      antigravity: false,
      engineActive: false,
      commandWork: false,
      commandWorkActive: false,
      commandWorkOffTimer: null,
    };
    states.set(sessionId, st);
  }
  return st;
}

/** 插件引擎这两条单独能撑住「后台活动」到何时;0 = 撑不住。 */
function engineActiveUntil(st: SessionActivityState): number {
  const outputUntil = st.engineActivityAt > 0 && st.engineActivityAt >= st.lastTurnEndAt
    ? st.engineActivityAt + ACTIVITY_WINDOW_MS
    : 0;
  return Math.max(outputUntil, engineOpenToolsDeadline(st));
}

function acpProgressDeadline(st: SessionActivityState): number {
  return !st.antigravity && st.engineActivityAt > 0
    ? st.engineActivityAt + PLUGIN_ENGINE_OPEN_WORK_CAP_MS
    : 0;
}

function engineOpenToolsDeadline(st: SessionActivityState): number {
  return st.engineOpenToolsUntil > 0 ? Math.max(st.engineOpenToolsUntil, acpProgressDeadline(st)) : 0;
}

function refreshEngineOpenToolDeadlines(
  st: SessionActivityState,
  now: number,
  turnEnded = false,
): void {
  st.engineOpenToolsUntil = 0;
  const progressDeadline = acpProgressDeadline(st);
  for (const [id, item] of st.engineOpenTools) {
    if (item.deadline === null && turnEnded) item.deadline = now + PLUGIN_ENGINE_OPEN_WORK_CAP_MS;
    if (item.deadline === null) continue;
    if (Math.max(item.deadline, progressDeadline) < now) {
      st.engineOpenTools.delete(id);
    } else if (!st.antigravity || item.observed) {
      st.engineOpenToolsUntil = Math.max(st.engineOpenToolsUntil, item.deadline);
    }
  }
}

/** 当前输入下「后台活动」保持到何时;0 = 现在就不成立。 */
function activeUntil(st: SessionActivityState): number {
  if (st.turnRunning || st.lastTurnEndAt <= 0) return 0;
  const proxyUntil =
    st.lastActivityAt > st.lastTurnEndAt + TURN_END_GRACE_MS
      ? st.lastActivityAt + ACTIVITY_WINDOW_MS
      : 0;
  return Math.max(proxyUntil, engineActiveUntil(st));
}

function shouldBeActive(st: SessionActivityState, now: number): boolean {
  return now <= activeUntil(st);
}

function setActive(
  sessionId: string,
  st: SessionActivityState,
  next: boolean,
  options: { turnStarting?: boolean } = {},
): void {
  setEngineActive(
    sessionId,
    st,
    next && !st.turnRunning && st.lastTurnEndAt > 0 && Date.now() <= engineActiveUntil(st),
    options.turnStarting === true,
  );
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

function setEngineActive(
  sessionId: string,
  st: SessionActivityState,
  next: boolean,
  turnStarting: boolean,
): void {
  if (st.engineActive === next) return;
  st.engineActive = next;
  try {
    pluginEngineListener?.(sessionId, next, { turnStarting });
  } catch (err) {
    log.warn('plugin engine background work listener threw', { sessionId, error: String(err) });
  }
}

/**
 * active 期间按当前输入挂静默倒计时;每次重评都重挂 —— 未完成的工具调用结束后,
 * 熄灭时刻会从 31 分钟上限提前到静默窗。
 */
function armOffTimer(sessionId: string, st: SessionActivityState): void {
  if (st.offTimer) clearTimeout(st.offTimer);
  const delay = Math.max(50, activeUntil(st) - Date.now() + 50);
  st.offTimer = setTimeout(() => {
    st.offTimer = null;
    evaluate(sessionId, st);
  }, delay);
}

function evaluate(sessionId: string, st: SessionActivityState): void {
  const now = Date.now();
  if (st.engineOpenToolsUntil > 0 && engineOpenToolsDeadline(st) < now) {
    refreshEngineOpenToolDeadlines(st, now);
  }
  const next = shouldBeActive(st, now);
  setActive(sessionId, st, next);
  if (next) armOffTimer(sessionId, st);
}

/** A confirmed exit can arrive after Session has fenced its event stream. */
export function clearAntigravityProcessActivity(sessionId: string, sessionInstanceId: string | undefined): void {
  const st = states.get(sessionId);
  if (!st?.antigravity || st.antigravitySessionInstanceId !== sessionInstanceId) return;
  st.engineOpenTools.clear();
  st.engineOpenToolsUntil = 0;
  st.engineActivityAt = 0;
  if (!st.turnRunning) evaluate(sessionId, st);
}

/**
 * 插件引擎(ACP)任务的事件:记下未完成的工具调用与回合外输出,再重评。
 * 只给 ACP 和 Antigravity 任务调用;回合内的工具调用也要记,回合结束时仍未完成的
 * 那些就是 Agent 还在跑的工作。
 */
export function observePluginEngineEvent(sessionId: string, event: AgentEvent): void {
  const data =
    event.data && typeof event.data === 'object' ? (event.data as Record<string, unknown>) : {};
  const antigravity = event.source === 'antigravity';
  const background = event.turnScope === 'background' && PLUGIN_ENGINE_WORK_EVENT_TYPES.has(event.type);
  let st = states.get(sessionId);
  if (event.type === 'antigravity_tool_activity' && antigravity) {
    const activity = event.data as AntigravityToolActivity;
    if (activity.kind === 'process_exited') {
      clearAntigravityProcessActivity(sessionId, event.sessionInstanceId);
      return;
    }
    const call = st?.engineOpenTools.get(activity.toolUseId);
    if (!st || !call) return;
    if (activity.kind === 'command_exited') {
      // The native receipt supplies the linked ACP call ID. Its task ID is in
      // a separate namespace and does not complete or replace the tool result.
      st.engineOpenTools.delete(activity.toolUseId);
    } else {
      call.observed = true;
    }
    refreshEngineOpenToolDeadlines(st, Date.now());
  } else if (event.type === 'tool_use' && typeof data.toolUseId === 'string' && data.toolUseId) {
    // The native schedule tool may never pair with a terminal ACP frame.
    // Its card and eventual wake output still follow the normal event pipeline.
    const nativeToolName = event[ANTIGRAVITY_NATIVE_TOOL_NAME];
    const waitsForWake = nativeToolName !== undefined
      ? nativeToolName === 'schedule'
      : data.toolName === 'Run schedule' || data.toolName === 'schedule';
    if (antigravity && waitsForWake) return;
    st ??= ensureState(sessionId);
    if (antigravity) {
      st.antigravity = true;
      st.antigravitySessionInstanceId = event.sessionInstanceId;
    }
    if (!st.engineOpenTools.has(data.toolUseId)) {
      const now = Date.now();
      const deadline = st.turnRunning && !background ? null : now + PLUGIN_ENGINE_OPEN_WORK_CAP_MS;
      st.engineOpenTools.set(data.toolUseId, { deadline, observed: true });
      refreshEngineOpenToolDeadlines(st, now);
    }
  } else if (event.type === 'tool_result' && st) {
    const ids = Array.isArray(data.toolUseIds) ? data.toolUseIds : [data.toolUseId];
    let removed = false;
    for (const id of ids) {
      if (typeof id === 'string') removed = st.engineOpenTools.delete(id) || removed;
    }
    if (removed) refreshEngineOpenToolDeadlines(st, Date.now());
  }
  // Antigravity tool results can arrive long after the work ended. The call ID
  // handles their bookkeeping without treating history delivery as new work.
  if (background && (!antigravity || event.type === 'text' || event.type === 'thinking')) {
    st ??= ensureState(sessionId);
    if (antigravity) {
      st.antigravity = true;
      st.antigravitySessionInstanceId = event.sessionInstanceId;
    }
    const now = Date.now();
    if (st.engineOpenToolsUntil > 0 && engineOpenToolsDeadline(st) < now) {
      refreshEngineOpenToolDeadlines(st, now);
    }
    st.engineActivityAt = now;
  }
  if (st && !st.turnRunning) evaluate(sessionId, st);
}

/**
 * 判定一笔代理 URL 是否为上下文用量探测(count_tokens 计量端点)。
 *
 * /context 卡片走 SDK getContextUsage(默认 detail:'full'),CLI 会对每类输入各发
 * 一笔 POST /v1/messages/count_tokens(带 ?beta=true query)。这类计量请求不生成
 * token、也不是后台子 agent 的采样流量,却同样带 cc 会话标头穿过 proxy —— 计入
 * 活动的话,用户查一次 /context 就会点亮「后台子任务运行中」横幅(#8671)。
 *
 * 判据与 provider-upstream-error-observer 的 isCountTokensUrl 同源:剥掉 query
 * 后按后缀匹配。真实的 /v1/messages 采样(含上游不支持 count_tokens 时 CLI 可能
 * 的极小计量回退)不受影响,仍照常记为活动。
 */
export function isClaudeContextUsageProbeUrl(url: string): boolean {
  return url.split('?', 1)[0].endsWith('/count_tokens');
}

/**
 * proxy 侧记录一笔该 sdkSessionId 的 API 活动。resolvedSessionId 为 host 用
 * 当前活跃会话表反解的结果(null = 当前解析不到,尝试粘滞缓存兜底)。
 */
export function recordClaudeApiActivity(sdkSessionId: string, resolvedSessionId: string | null): void {
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
export function noteClaudeSessionTurnState(sessionId: string, running: boolean): void {
  const st = ensureState(sessionId);
  if (st.turnRunning === running) return;
  st.turnRunning = running;
  if (running) {
    if (st.antigravity) {
      for (const call of st.engineOpenTools.values()) call.observed = false;
      st.engineOpenToolsUntil = 0;
    }
    // turn 期间的 API 活动是正常主线流量,后台横幅熄灭。
    setActive(sessionId, st, false, { turnStarting: true });
  } else {
    st.lastTurnEndAt = Date.now();
    refreshEngineOpenToolDeadlines(st, st.lastTurnEndAt, true);
    // turn 刚结束:此刻的 lastActivityAt 必然 ≤ lastTurnEndAt,proxy 信号不会立即误亮;
    // 之后若仍有请求进来(后台子 agent),record 路径会重新评估点亮。
    evaluate(sessionId, st);
  }
  evaluateCommandWork(sessionId, st);
}

// ── 后台命令仍在工作 ─────────────────────────────────────────────────────────
// 后台命令(run_in_background 的 Bash)不调模型,上面的 proxy 信号永远看不到它;回合也不等它
// (长驻服务不能把回合挂住)。但「跑测试、构建」这类会自己结束的命令没跑完时任务其实没做完:
// CLI 会在它结束后自动开新一轮。这里把「回合已结束 + 仍有这类命令在跑」广播给任务列表,
// 显示为运行中,与 Codex / Pi(命令没跑完回合就不结束)一致。只影响展示:不改回合边界、
// 完成提醒、发送排队与停止语义。长驻服务(backgroundCommandKind=service)不计。

/** 后台任务快照里是否有仍在运行、会自己结束的后台命令。种类未知按工作算。 */
export function hasWorkingBackgroundCommand(
  tasks: ReadonlyArray<{ taskType?: string; backgroundCommandKind?: 'work' | 'service' }>,
): boolean {
  return tasks.some(
    (task) => task.taskType === 'local_bash' && task.backgroundCommandKind !== 'service',
  );
}

function setCommandWorkActive(sessionId: string, st: SessionActivityState, next: boolean): void {
  if (st.commandWorkOffTimer) {
    clearTimeout(st.commandWorkOffTimer);
    st.commandWorkOffTimer = null;
  }
  if (st.commandWorkActive === next) return;
  st.commandWorkActive = next;
  try {
    commandWorkBroadcaster?.({ sessionId, active: next });
  } catch (err) {
    log.warn('background command work broadcast threw', { sessionId, error: String(err) });
  }
}

function evaluateCommandWork(sessionId: string, st: SessionActivityState): void {
  if (st.turnRunning) {
    // 回合在跑:列表本来就显示运行中,这一层让位。
    setCommandWorkActive(sessionId, st, false);
    return;
  }
  if (st.commandWork) {
    setCommandWorkActive(sessionId, st, true);
    return;
  }
  if (!st.commandWorkActive || st.commandWorkOffTimer) return;
  st.commandWorkOffTimer = setTimeout(() => {
    st.commandWorkOffTimer = null;
    if (st.turnRunning || !st.commandWork) setCommandWorkActive(sessionId, st, false);
  }, COMMAND_WORK_END_GRACE_MS);
}

/** host(register 阶段)注入「后台命令仍在工作」的广播函数;null = 卸载。 */
export function setClaudeBackgroundCommandWorkBroadcaster(
  fn: ((payload: { sessionId: string; active: boolean }) => void) | null,
): void {
  commandWorkBroadcaster = fn;
}

/**
 * 会话后台任务表变化、或回合收尾时,用该会话的权威快照刷新一次。调用方传的是
 * hasWorkingBackgroundCommand(session.listBackgroundTasks()) 的结果,不靠事件自己配对。
 */
export function noteClaudeSessionBackgroundCommandWork(sessionId: string, hasWork: boolean): void {
  const existing = states.get(sessionId);
  if (!existing && !hasWork) return;
  const st = existing ?? ensureState(sessionId);
  st.commandWork = hasWork;
  evaluateCommandWork(sessionId, st);
}

/** 当前「回合已结束但后台命令仍在工作」的全部会话 id(renderer 任务列表挂载时的初始快照)。 */
export function listClaudeBackgroundCommandWorkSessions(): string[] {
  const ids: string[] = [];
  for (const [sessionId, st] of states) {
    if (st.commandWorkActive) ids.push(sessionId);
  }
  return ids;
}

/** 会话进程被关闭 / 会话被删除时清账(广播熄灭;插件引擎未完成的工具调用随进程结束)。 */
export function clearClaudeSessionBackgroundActivity(sessionId: string): void {
  const st = states.get(sessionId);
  if (!st) return;
  setActive(sessionId, st, false);
  if (st.offTimer) {
    clearTimeout(st.offTimer);
    st.offTimer = null;
  }
  // 进程已关,后台命令随之结束:不等续跑空窗,立即熄灭。
  st.commandWork = false;
  setCommandWorkActive(sessionId, st, false);
  states.delete(sessionId);
}

/** renderer 初始查询用快照。 */
export function getClaudeSessionBackgroundActivity(sessionId: string): boolean {
  return states.get(sessionId)?.active === true;
}

/** 当前处于后台活动态的全部会话 id(renderer 侧边栏挂载时的初始快照)。 */
export function listActiveClaudeBackgroundActivitySessions(): string[] {
  const ids: string[] = [];
  for (const [sessionId, st] of states) {
    if (st.active) ids.push(sessionId);
  }
  return ids;
}

/** 测试收尾:清空全部状态与定时器。 */
export function resetClaudeBackgroundActivityForTests(): void {
  for (const [sessionId, st] of states) {
    if (st.offTimer) clearTimeout(st.offTimer);
    if (st.commandWorkOffTimer) clearTimeout(st.commandWorkOffTimer);
    void sessionId;
  }
  states.clear();
  stickySdkToSession.clear();
  broadcaster = null;
  commandWorkBroadcaster = null;
  pluginEngineListener = null;
}

/**
 * 组合进 cc loopback proxy 的响应观察器:请求头带 x-claude-code-session-id 的
 * 响应,按节流刷新该会话的活动时刻 —— 覆盖「一笔长 SSE 跨过 turn 结束点仍在
 * 吐字」的场景(事故现场正是遗留子 agent 的长流)。零 body 解析,只摸时间戳。
 * count_tokens 用量探测不算活动(#8671,判据同 isClaudeContextUsageProbeUrl)。
 */
export function createClaudeSessionActivityResponseObserver(
  resolveSessionId: (sdkSessionId: string) => string | null,
): ResponseObserver {
  return ({ requestHeaders, url }) => {
    if (isClaudeContextUsageProbeUrl(url)) return null;
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
