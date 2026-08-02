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
 *   - done 时若还有在途后台 subagent, 延迟定格直到任务终态后的下一次 done;
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

/*
 * ── 为什么这里**没有**整轮静默兜底 ──────────────────────────────────────────
 *
 * 因为 maker-core 的 Session 已经有一条(`armTurnStallWatchdog` / 默认 45min),
 * 而且它做对了这里很难做对的几件事:
 *   - 等用户回应交互(权限询问 / AskUserQuestion / plan review)期间不计时;
 *   - 有后台任务在跑期间不计时;
 *   - 按分片计时并核对真实经过时间, 把合盖睡眠那段排除掉;
 *   - 触发时**真的 abort 这一轮**, 还复核 abort 是否生效, 没生效就关会话。
 * 它触发时 fan out 的是终态 error 事件, 本观察器对终态 error 本来就收口 ——
 * 所以「observer 永不 settle → dispatcher 的队列槽位永不释放」那条路早就被堵上,
 * 与控制连接是否还在无关。
 *
 * 后台任务同样不能在 hook 层按静默时长猜成完成:它结束后可能通过
 * task_notification 自动续跑新 turn。观察器一旦提前 settle,Telegram 群轮次
 * 就会恢复原权限档并释放 host-turn lease,后续自动续跑可与桌面 turn 并发且重新
 * 获得 Full access。后台任务无论静默多久都保留观察器;任务终态后的 done、用户
 * Stop 引发的终态事件或 session closed/error 才是可证明的收口信号。
 *
 * 本 PR 一度在这里另起了一个裸 setTimeout, 上面四条一条都没有: 等交互和跑后台
 * 任务时会误杀, 合盖睡眠会误杀, 而且只 reject 观察者、**不 abort 底层 turn** ——
 * 渠道报错了, agent 还在继续跑并继续产生副作用(PR #1272 review 指出)。
 * 同一条不变量在两处判定, 弱的那处只会先开火。已删除。
 */

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

/** 观察器需要 session 的这几样东西(测试可注入最小假实现)。 */
export interface ObservableSession {
  readonly id: string;
  onEvent(listener: (ev: AgentEvent) => void): () => void;
  /**
   * 会话状态变更订阅(生产为 maker-core Session.onStatusChange)。
   *
   * 收口必须同时认它, 不能只认事件流: SDK handle 的事件迭代器**抛错或自然结束**
   * 时, maker-core 只 setStatus('error'/'closed') 并**主动清掉** stall 看门狗,
   * 不 fan out 任何终态事件 —— 而看门狗本身也只在 status 仍是 'active' 时开火。
   * 于是「会话已死」这条路上没有任何东西会让 observer settle: 渠道请求永远结束
   * 不了, 同 session 的后续消息持续排队, finalizeInteractions 也跑不到
   * (PR #1272 review 指出)。
   *
   * 判据是**状态**不是时间, 所以不会误杀等用户回应交互 / 跑后台任务 / 合盖睡眠
   * 那些合法静默 —— 那正是本 PR 删掉裸 setTimeout 的理由, 两者不冲突。
   */
  onStatusChange(
    listener: (status: 'active' | 'aborting' | 'closed' | 'error') => void,
  ): () => void;
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
  /** 完整 turn（含后台续跑）收口时同步通知，早于 finished settle。 */
  onTurnTerminal?: () => void;
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
  /**
   * **仅**本轮最后一条助手消息(不含此前的过程叙述)。
   *
   * 给"一次交互只有一条公开消息名额"的渠道用 —— 目前是 X: 一次 mention 只
   * 允许回一条推文, 而 agent 的常态是"先说一句要去看看 → 干活 → 给结论",
   * text() 那样整轮拼接会把过程叙述原样发到公开时间线上, 还会挤占 280 字符
   * 里本就不够的额度。提示词侧同步告知模型"只有最后一条会被发出"(见
   * outbound.buildHookPromptNote 的 X 分支), 让机制与模型预期一致 —— 只靠
   * 提示词要求模型别写过程是软约束, 不听就穿透(2026-08-01 实踩)。
   *
   * 最后一条为空白时回退整轮正文: 公开回帖宁可带上过程, 也不能发成空。
   */
  finalSegment(): string;
}

/** 挂上事件监听并开始观察。调用方必须 await finished 或自己 stop()。 */
export function observeHookTurn(
  session: ObservableSession,
  deps: HookTurnObserverDeps,
): HookTurnObserver {
  const { answerOnlyProgress, onProgress, onToolResult, onTurnTerminal, onSilentStopSettled, log } =
    deps;
  // 文本累积语义(2026-07-28 修订): translator 的 isFinal 是**逐条**
  // agent_message 的完成信号(每条完成都携带该条全文), 不是整个 turn 的
  // 终稿 —— 用它整体替换累积文本, 会让"先回一句 → 思考 → 终答"的多消息
  // turn 只剩最后被替换的那条(实踩: Telegram 群里最终答案丢失)。
  // 正确姿势: isFinal 把该条追加进已定稿段, 流式增量走尾部缓冲。
  // 定稿段**按消息切开存**(而不是直接拼成一个串): 拼接后消息边界就没了, 而
  // finalSegment() 需要它 —— 见该方法的注释。join('\n\n') 与此前的逐段拼接
  // 完全等价(同一条消息的相邻块在入栈时已连拼, 段内不含分隔)。
  const finalizedSegments: string[] = [];
  let streamTail = '';
  let assistantText = '';
  /** 最近一次定稿段所属的 claude 消息标识(uuid, 缺失时退到 requestId)。 */
  let lastFinalUuid: string | undefined;
  const recomputeAssistantText = (): void => {
    const finalizedText = finalizedSegments.join('\n\n');
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
    let turnTerminalNotified = false;
    let pendingSettleUnsub: (() => void) | undefined;
    const notifyTurnTerminal = (): void => {
      if (turnTerminalNotified) return;
      turnTerminalNotified = true;
      try {
        onTurnTerminal?.();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`[hook-runner] onTurnTerminal failed: ${message}`);
      }
    };
    /**
     * 摘监听 + 停定时器。收口的三条出口(resolve / reject / 调用方 stop)必须
     * 走同一份拆装 —— 之前是三处各抄一遍, 新加一个定时器就得记着补三处。
     */
    const teardown = (): void => {
      pendingSettleUnsub?.();
      pendingSettleUnsub = undefined;
      progress?.stop();
      off();
      offStatus();
      stopListening = undefined;
    };
    const finish = (): void => {
      notifyTurnTerminal();
      teardown();
      resolve();
    };
    const failTurn = (err: Error): void => {
      notifyTurnTerminal();
      teardown();
      reject(err);
    };
    // 会话已死(见 ObservableSession.onStatusChange)。终态事件永远不会来了,
    // 按失败收口 —— 已累积的正文不足以判定这一轮真的完成了。
    const offStatus = session.onStatusChange((status) => {
      if (status !== 'closed' && status !== 'error') return;
      failTurn(new Error(`hook turn session ended without a terminal event (${status})`));
    });
    const off = session.onEvent((ev: AgentEvent) => {
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
            // ③ codex item.completed / pi message_end:该条全文,覆盖已流增量。
            // ④ 未知 source: 保守用前缀启发式。
            const src = (ev as { source?: string }).source;
            const meta = (ev as { agentMeta?: { uuid?: unknown; requestId?: unknown } }).agentMeta;
            const claudeTail = src === 'claude-code' && meta === undefined;
            const segment = claudeTail
              ? streamTail + data.text
              : src === 'claude-code' || src === 'codex' || src === 'pi'
                ? data.text
                : data.text.startsWith(streamTail)
                  ? data.text
                  : streamTail + data.text;
            // 消息边界标识。uuid 是 envelope 顶层的可选字段, **确实会缺**
            // (extractAssistantMeta 允许它缺); 缺了就退到 requestId —— 那是
            // Anthropic 的 message id(`msg_...`), 同一条消息的各 text block 共享、
            // 不同消息不同, 正好是这里要的语义。
            //
            // 少了这道回退, 一条含多个 text block 的消息会被拆成多个"消息",
            // 而 X 的 finalSegment() 只发最后一段 —— 回帖被从中间截断, 用户拿到
            // 半句话(PR #1272 review 指出)。
            const messageId =
              src === 'claude-code'
                ? typeof meta?.uuid === 'string'
                  ? meta.uuid
                  : typeof meta?.requestId === 'string'
                    ? meta.requestId
                    : undefined
                : undefined;
            // claudeTail(claude result 的 fallbackTail)**自成一段**, 不并入上一条。
            //
            // 它刻意不带 agentMeta(translator 的原话: 补推文本是"孤儿正文",
            // 拿 lastAssistantMeta 当锚点会污染 fork/rewind), 所以 hook 层**拿不到
            // 它属于哪条消息** —— 这个歧义是结构性的, 不是这里少判了一个条件。
            //
            // 两种真实情形都存在, 从这里看完全一样:
            //   ① 它续的是上一条(该消息有多个 block, 只流了前一个);
            //   ② 它是**新的一条**: translator 明写覆盖"前面 call 推过旁白、最后
            //      一次 call 的最终回复被截断"(见 translator.ts 的 fallbackTail 注释)。
            //
            // 选 ②(自成一段)是因为两侧代价不对称: 按 ② 处理而实为 ① 时, X 发出
            // 的是尾段 —— 而尾段按构造就是整轮文本的**结尾**, 结论在里面; 按 ① 处理
            // 而实为 ② 时, 旁白会被粘进公开回帖一起发出去。何况 ② 才是 translator
            // 文档里点名的那个场景(PR #1272 review 指出, 推翻了上一版的无条件并入)。
            const sameMessage = messageId !== undefined && messageId === lastFinalUuid;
            if (sameMessage && finalizedSegments.length > 0) {
              finalizedSegments[finalizedSegments.length - 1] += segment;
            } else {
              finalizedSegments.push(segment);
            }
            lastFinalUuid = messageId;
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
              failTurn(new Error('silent-stop auto-resume exhausted'));
            } else {
              finish();
            }
          });
          return;
        }
        if (runningBgTasks.size > 0) {
          return;
        }
        finish();
      } else if (isTerminalAgentErrorEvent(ev)) {
        const data = ev.data as {
          message?: string;
          errorStatus?: number;
          codexErrorInfo?: string;
        } | null;
        const raw = data?.message ?? 'agent terminal error';
        // 过载重试耗尽: 渠道里发裸英文原文(server 侧再前缀成 "Task failed:")
        // 等于把内部串丢给用户, 且没说清"怎么才能真的重试"。换成可读说明,
        // 原文留在本地日志里供排查。结构化 tag 一并传: 只认文案时 codex 改措辞
        // 会让这条终态说明退回裸英文原文(#1022)。
        const friendly = overloadFailureNotice(raw, data?.errorStatus, data?.codexErrorInfo);
        if (friendly !== null) {
          log.warn(`hook turn failed (upstream overload): ${raw}`);
        }
        failTurn(new Error(friendly ?? raw));
      }
    });
    stopListening = teardown;
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
    finalSegment(): string {
      // streamTail 非空 = 最后一条消息还没收到 isFinal(收口时它就是完整的
      // 那一条), 此时它**本身**就是最后一条, 不能和上一条定稿段拼起来 ——
      // 那会把倒数第二条消息也带上。
      const last =
        streamTail.trim().length > 0
          ? streamTail
          : (finalizedSegments[finalizedSegments.length - 1] ?? '');
      return last.trim().length > 0 ? last : assistantText;
    },
  };
}
