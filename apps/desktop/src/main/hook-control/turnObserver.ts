/**
 * hook-control/turnObserver.ts
 * ---------------------------------------------------------------------------
 * 一个 turn 的事件观察器: 累积正文、维护过程区时间线、节流发射渲染快照, 并在
 * done / 终态错误上收口。从 session-runner 的 run() 里原样抽出 —— 现在有**两个**
 * 消费方需要完全相同的收口语义:
 *
 *   1. run(): hook 自己派发的 turn;
 *   2. watchContinuation(): 用户在桌面端续跑后, 把那一轮接回渠道消息
 *      (见 dispatcher 的 pending-reopen 记账与协议阶段 18)。
 *
 * 收口语义有几处不是"看着像就行"的细节, 复制第二份必然漂移:
 *   - done 时若还有在途后台 subagent, 延迟定格并用静默超时兜底;
 *   - silentStop done 不算收口, 挂到自动续跑守卫上, 只有 exhausted 才算失败;
 *   - 只有**终态** error 才失败 —— 非终态 error 是 agent 正在自愈(上游过载的
 *     自动重试), turn 还在跑, 但过程区必须留一行, 否则零产出的退避窗口里渠道
 *     那条消息整段静止(见 turnRetryNotice.ts 的模块注释);
 *   - 文本累积按 translator 契约区分 isFinal 形态, 不做内容猜测(见下)。
 *
 * 本模块只碰事件流与定时器, 不做 IO —— 图片旁路、附件收集、落库都留在调用方。
 */

import type { AgentEvent } from '@cindy/maker-core';
import { isTerminalAgentErrorEvent } from '@cindy/maker-core';

import {
  createTurnActivity,
  markActivityWriting,
  pushThinkingStep,
  pushToolStep,
  renderActivity,
  setActivityNotice,
} from '../im/shared/turnActivity.js';
import { overloadFailureNotice, overloadRetryNotice } from '../im/shared/turnRetryNotice.js';

/** 后台 subagent 事件静默兜底(同 scheduler BG_TASK_IDLE_FALLBACK_MS 语义)。 */
const BG_TASK_IDLE_FALLBACK_MS = 10 * 60_000;

/**
 * 进度快照节流(trailing-edge): 事件密集时最多每 1.5s 发一帧, 与 IM 流式卡的
 * chat.update 节流(1300ms)同量级 —— server 侧每帧一次 chat.update(Tier 3
 * ~50/min/频道), 这个间隔留有安全余量。
 */
const PROGRESS_THROTTLE_MS = 1500;
/** 无新事件时的低频刷新(过程区耗时行"第 N 步 · 42s"不冻结)。 */
const PROGRESS_TICK_MS = 5000;
/** 单帧快照长度上限: 头部截断 —— server 侧占位消息本就 3900 上限, 中间帧
 *  开头(过程区 + 正文起始)信息量最大, 收口后 turn.end 会带完整文本。 */
const PROGRESS_SNAPSHOT_MAX_CHARS = 3800;

/**
 * 进度快照发射器: 合成「过程区时间线 + 部分正文」并按 trailing-edge 节流回调。
 * 纯定时器逻辑, 不做 IO —— 真正的发送(turn.progress 帧)由调用方注入的
 * onProgress 承担。stop() 后不再发射(收口后的迟到事件被丢弃)。
 */
function createProgressEmitter(
  emit: (text: string) => void,
  compose: () => string,
): { schedule: () => void; ensureTicker: () => void; stop: () => void } {
  let lastEmitAt = 0;
  let lastEmittedText = '';
  let pending: NodeJS.Timeout | null = null;
  let ticker: NodeJS.Timeout | null = null;
  let stopped = false;

  const fire = (): void => {
    if (stopped) return;
    const text = compose();
    if (text.length === 0) return;
    const snapshot =
      text.length > PROGRESS_SNAPSHOT_MAX_CHARS
        ? `${text.slice(0, PROGRESS_SNAPSHOT_MAX_CHARS - 1)}…`
        : text;
    // The low-frequency activity ticker can fire while the user-visible
    // answer is unchanged. Do not spend provider API calls on identical
    // full snapshots (and, for Telegram, do not re-animate the same draft).
    if (snapshot === lastEmittedText) return;
    lastEmitAt = Date.now();
    lastEmittedText = snapshot;
    emit(snapshot);
  };
  const schedule = (): void => {
    if (stopped || pending !== null) return;
    const wait = Math.max(0, lastEmitAt + PROGRESS_THROTTLE_MS - Date.now());
    pending = setTimeout(() => {
      pending = null;
      fire();
    }, wait);
    pending.unref?.();
  };
  return {
    schedule,
    ensureTicker(): void {
      if (stopped || ticker !== null) return;
      ticker = setInterval(schedule, PROGRESS_TICK_MS);
      ticker.unref?.();
    },
    stop(): void {
      stopped = true;
      if (pending !== null) clearTimeout(pending);
      if (ticker !== null) clearInterval(ticker);
      pending = null;
      ticker = null;
    },
  };
}

/** 观察器只需要 session 的这两样东西(测试可注入最小假实现)。 */
export interface ObservableSession {
  readonly id: string;
  onEvent(listener: (ev: AgentEvent) => void): () => void;
}

export interface HookTurnObserverDeps {
  /**
   * true = 进度快照**只发正文**, 不掺过程区时间线。
   *
   * Telegram DM 的 Rich draft 是"部分终稿"动画, 过程时间线随 thinking / tool
   * 事件反复重排会让 Telegram 整段清空重播 —— DM 因此只流单调增长的正文。
   * 群/topic 的进度载体是可编辑消息(无 draft 动画), 与 Slack 过程卡同款:
   * 时间线在上正文在下, 让群成员看到"正在干什么"而不是盯着一句旧话干等
   * (2026-07-28 实踩)。调用方按 `isTelegram && laneKind !== 'group'` 计算。
   */
  answerOnlyProgress: boolean;
  /** 渲染快照出口(turn.progress); 省略 = 不发进度, 零开销路径。 */
  onProgress?: (text: string) => void;
  /** tool_result 全文旁路(出站图片收集留在调用方, 观察器不碰 IO)。 */
  onToolResult?: (fullText: string) => void;
  /** silent-stop 自动续跑守卫的 settle 订阅(生产为 maker-ipc 的同名函数)。 */
  onSilentStopSettled: (
    sessionId: string,
    cb: (sessionId: string, reason: string) => void,
  ) => () => void;
  log: { warn(msg: string): void };
}

export interface HookTurnObserver {
  /** done(含后台任务定格)时 resolve; 终态错误 / silent-stop 耗尽时 reject。 */
  readonly finished: Promise<void>;
  /** 摘监听 + 停止发射。幂等; 收口后自动调用过。 */
  stop(): void;
  /** 当前累积的助手正文(已定稿段 + 流式尾部)。 */
  text(): string;
}

/** 挂上事件监听并开始观察。调用方必须 await finished 或自己 stop()。 */
export function observeHookTurn(
  session: ObservableSession,
  deps: HookTurnObserverDeps,
): HookTurnObserver {
  const { answerOnlyProgress, onProgress, onToolResult, onSilentStopSettled, log } = deps;
  // 文本累积语义(2026-07-28 修订): translator 的 isFinal 是**逐条**
  // agent_message 的完成信号(每条完成都携带该条全文), 不是整个 turn 的
  // 终稿 —— 用它整体替换累积文本, 会让"先回一句 → 思考 → 终答"的多消息
  // turn 只剩最后被替换的那条(实踩: Telegram 群里最终答案丢失)。
  // 正确姿势: isFinal 把该条追加进已定稿段, 流式增量走尾部缓冲。
  let finalizedText = '';
  let streamTail = '';
  let assistantText = '';
  /** 最近一次定稿段所属的 claude 消息 uuid(同消息相邻块连拼用)。 */
  let lastFinalUuid: string | undefined;
  const recomputeAssistantText = (): void => {
    // trim 只用于判空(纯空白尾巴不该拼出悬空分隔), 拼接用原文 ——
    // 首行缩进/换行是内容(markdown 代码块等), 不得被裁掉。
    const hasTail = streamTail.trim().length > 0;
    assistantText = hasTail
      ? finalizedText
        ? `${finalizedText}\n\n${streamTail}`
        : streamTail
      : finalizedText;
  };
  // 进度快照(turn.progress 链路): 过程区时间线与 IM 流式卡同一套纯逻辑
  // (turnActivity), 合成规则同 composeStreamingView —— 有正文时过程区在
  // 上正文在下, done/error 后 stop, 不再发射。
  const activity = createTurnActivity(Date.now());
  const progress = onProgress
    ? createProgressEmitter(onProgress, () => {
        // 只流正文的唯一例外: 还没有任何正文、而 agent 正在自动重试(上游过载)
        // 时, 草稿本来就是空的 —— 此时给出那一行状态说明, 否则用户在整个退避
        // 窗口里完全看不到任何反馈。有正文后仍只发正文, 不掺过程区。
        // (群/topic 走下面的完整过程卡, notice 已在那条路径里渲染。)
        if (answerOnlyProgress) return assistantText || (activity.notice ?? '');
        const act = renderActivity(activity, Date.now());
        if (!act) return assistantText;
        return assistantText ? `${act}\n\n${assistantText}` : act;
      })
    : null;

  let stopListening: (() => void) | undefined;
  const finished = new Promise<void>((resolve, reject) => {
    const runningBgTasks = new Set<string>();
    let waitingForBgTasks = false;
    let bgFallbackTimer: NodeJS.Timeout | undefined;
    let pendingSettleUnsub: (() => void) | undefined;
    const clearBgTimer = (): void => {
      if (bgFallbackTimer) {
        clearTimeout(bgFallbackTimer);
        bgFallbackTimer = undefined;
      }
    };
    const finish = (): void => {
      clearBgTimer();
      pendingSettleUnsub?.();
      pendingSettleUnsub = undefined;
      progress?.stop();
      off();
      stopListening = undefined;
      resolve();
    };
    const armBgTimer = (): void => {
      clearBgTimer();
      bgFallbackTimer = setTimeout(() => {
        log.warn(`[hook-runner] bg task events silent, finalizing: ${session.id}`);
        finish();
      }, BG_TASK_IDLE_FALLBACK_MS);
      bgFallbackTimer.unref?.();
    };
    const off = session.onEvent((ev: AgentEvent) => {
      if (waitingForBgTasks) armBgTimer();
      if (ev.type === 'agent_task_update') {
        const data = ev.data as { taskId?: string; status?: string } | null;
        if (data && typeof data.taskId === 'string') {
          if (data.status === 'running') runningBgTasks.add(data.taskId);
          else runningBgTasks.delete(data.taskId);
        }
        return;
      }
      if (ev.type === 'text') {
        const data = ev.data as { text?: string; isFinal?: boolean } | null;
        if (data && typeof data.text === 'string') {
          if (data.isFinal) {
            // isFinal 形态按 translator 契约区分, 不做内容猜测(前缀
            // 启发式在"尾段恰好以已流增量开头"时会误判丢正文):
            // ① claude 块终稿(带 agentMeta): data.text 是该块全文, 覆盖
            //   已流增量; 同一条消息(同 uuid)的相邻文本块按原文连拼
            //   (renderer 同款 raw concat), 不同消息之间空行分隔。
            // ② claude result 兜底 fallbackTail(刻意不带 agentMeta):
            //   只含 UI 缺的尾段, 与已流增量原样接上。
            // ③ codex item.completed: 该条全文, 覆盖已流增量。
            // ④ 未知 source: 保守用前缀启发式。
            const src = (ev as { source?: string }).source;
            const meta = (ev as { agentMeta?: { uuid?: unknown } }).agentMeta;
            const claudeTail = src === 'claude-code' && meta === undefined;
            const segment = claudeTail
              ? streamTail + data.text
              : src === 'claude-code' || src === 'codex'
                ? data.text
                : data.text.startsWith(streamTail)
                  ? data.text
                  : streamTail + data.text;
            const uuid =
              src === 'claude-code' && typeof meta?.uuid === 'string' ? meta.uuid : undefined;
            const sameMessage = uuid !== undefined && uuid === lastFinalUuid;
            finalizedText = finalizedText
              ? `${finalizedText}${sameMessage ? '' : '\n\n'}${segment}`
              : segment;
            lastFinalUuid = uuid;
            streamTail = '';
          } else {
            streamTail += data.text;
          }
          recomputeAssistantText();
          markActivityWriting(activity);
          progress?.schedule();
        }
        return;
      }
      if (ev.type === 'thinking') {
        if (pushThinkingStep(activity, ev.data)) {
          progress?.ensureTicker();
          progress?.schedule();
        }
        return;
      }
      if (ev.type === 'tool_use') {
        // 过程展示: 与 IM 流式卡同款滚动时间线(turnActivity), 让 Slack 侧
        // 在长 agentic turn 里看到"正在干什么", 而不是盯着 👀 表情干等
        const data = ev.data as {
          toolName?: unknown;
          toolUseId?: unknown;
          input?: unknown;
        } | null;
        if (data && typeof data.toolName === 'string') {
          pushToolStep(
            activity,
            data.toolName,
            data.input,
            typeof data.toolUseId === 'string' ? data.toolUseId : undefined,
          );
          progress?.ensureTicker();
          progress?.schedule();
        }
        return;
      }
      if (ev.type === 'error' && !isTerminalAgentErrorEvent(ev)) {
        // 非终止 error = agent 正在自愈(当前只透过载类的自动重试)。turn 没
        // 结束, 不收口; 但必须在过程区留一行, 否则零产出的退避窗口里渠道那
        // 条消息整段静止(见 turnRetryNotice.ts 的模块注释)。
        const notice = overloadRetryNotice(ev.data);
        if (notice !== null && setActivityNotice(activity, notice)) {
          // ticker 让"第 N 步 · 42s"与这行状态一起走时间, 重试期间没有任何
          // 新事件也能看出还在动。
          progress?.ensureTicker();
          progress?.schedule();
        }
        return;
      }
      if (ev.type === 'tool_result_full') {
        const data = ev.data as { fullText?: unknown } | null;
        if (data && typeof data.fullText === 'string') onToolResult?.(data.fullText);
        return;
      }
      if (ev.type === 'done') {
        if ((ev.data as { silentStop?: boolean } | null | undefined)?.silentStop === true) {
          pendingSettleUnsub?.();
          pendingSettleUnsub = onSilentStopSettled(session.id, (_sid, reason) => {
            pendingSettleUnsub?.();
            pendingSettleUnsub = undefined;
            if (reason === 'exhausted') {
              clearBgTimer();
              progress?.stop();
              off();
              stopListening = undefined;
              reject(new Error('silent-stop auto-resume exhausted'));
            } else {
              finish();
            }
          });
          return;
        }
        if (runningBgTasks.size > 0) {
          waitingForBgTasks = true;
          armBgTimer();
          return;
        }
        finish();
      } else if (isTerminalAgentErrorEvent(ev)) {
        clearBgTimer();
        progress?.stop();
        off();
        stopListening = undefined;
        const data = ev.data as
          | { message?: string; errorStatus?: number; codexErrorInfo?: string }
          | null;
        const raw = data?.message ?? 'agent terminal error';
        // 过载重试耗尽: 渠道里发裸英文原文(server 侧再前缀成 "Task failed:")
        // 等于把内部串丢给用户, 且没说清"怎么才能真的重试"。换成可读说明,
        // 原文留在本地日志里供排查。结构化 tag 一并传: 只认文案时 codex 改措辞
        // 会让这条终态说明退回裸英文原文(#1022)。
        const friendly = overloadFailureNotice(raw, data?.errorStatus, data?.codexErrorInfo);
        if (friendly !== null) {
          log.warn(`hook turn failed (upstream overload): ${raw}`);
        }
        reject(new Error(friendly ?? raw));
      }
    });
    stopListening = (): void => {
      clearBgTimer();
      pendingSettleUnsub?.();
      pendingSettleUnsub = undefined;
      progress?.stop();
      off();
    };
  });
  // 调用方可能先 stop() 再决定不消费结果; 没有消费方的 rejection 不该炸进程。
  void finished.catch(() => undefined);

  return {
    finished,
    stop(): void {
      stopListening?.();
      stopListening = undefined;
    },
    text(): string {
      return assistantText;
    },
  };
}
