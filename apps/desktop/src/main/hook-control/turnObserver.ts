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
 *   - done 时只在 provider 明确还有自动续 turn 时延迟定格；UI 任务卡本身
 *     不是生命周期信号;
 *   - silentStop done 不算收口, 挂到自动续跑守卫上, 只有 exhausted 才算失败;
 *   - 只有**终态** error 才失败 —— 非终态 error 是 agent 正在自愈(上游过载的
 *     自动重试), turn 还在跑, 但过程区必须留一行, 否则零产出的退避窗口里渠道
 *     那条消息整段静止(见 turnRetryNotice.ts 的模块注释);
 *   - 文本累积按 translator 契约区分 isFinal 形态, 不做内容猜测(见下)。
 *
 * 本模块只碰事件流与定时器, 不做 IO —— 图片旁路、附件收集、落库都留在调用方。
 */

import type { AgentEvent, TurnContinuationState } from '@cindy/maker-core';
import { isTerminalAgentErrorEvent } from '@cindy/maker-core';

import {
  createTurnPresenter,
  type ProgressBodyMode,
} from '../im/shared/turnPresenter.js';
import { terminalErrorText } from '../im/shared/turnRetryNotice.js';

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

/** 观察器需要 session 的这几样东西(测试可注入最小假实现)。 */
export interface ObservableSession {
  readonly id: string;
  onEvent(listener: (ev: AgentEvent) => void): () => void;
  /** Resolve the provider claim atomically attached to this exact `done`. */
  beginTurnContinuationWait?(continuationId?: number): TurnContinuationState | null;
  /** Observe provider-owned continuation cancellation/start transitions. */
  onTurnContinuationChange?(
    listener: (continuationId: number, state: TurnContinuationState) => void,
  ): () => void;
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
  /** 渲染快照出口(turn.progress); 省略 = 不发进度, 零开销路径。 */
  onProgress?: (text: string) => void;
  /** 运行中正文范围；官方 Telegram 用 whole 对齐个人 bot，其它车道保留 latest。 */
  progressBodyMode?: ProgressBodyMode;
  /** done 时跳过尾沿节流并先发最新进度；仅官方 Telegram 车道启用。 */
  flushProgressOnDone?: boolean;
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
  /** 真正的新交互请求边界；等待提示的后续文案更新不得重复调用。 */
  markInteractionBoundary(): void;
  /** 当前累积的助手正文(已定稿段 + 流式尾部)。 */
  text(): string;
  /** 按桌面消息流同款折叠规则得到的正式答复正文。 */
  finalText(): string;
  /**
   * 在过程区挂 / 摘一行状态说明(渲染成 `> ⏳ …`, 与过载重试同一个位置)。
   *
   * 用途: agent 挂起等用户授权时, 渠道那条消息除了"工作中"什么都不显示 ——
   * 而卡片可能根本不在这个会话里(Telegram 群里的授权卡改投宿主私聊了), 群里
   * 看起来就是彻底静止。**刻意不写卡片去了哪**: 投递位置由 hook server 决定,
   * 客户端不知道对端版本, 说"已发到私聊"可能是假的。
   *
   * null = 摘掉。不新增任何渠道消息, 只改已经在发的那条快照。
   */
  setNotice(notice: string | null): void;
}

/** 挂上事件监听并开始观察。调用方必须 await finished 或自己 stop()。 */
export function observeHookTurn(
  session: ObservableSession,
  deps: HookTurnObserverDeps,
): HookTurnObserver {
  const {
    onProgress,
    progressBodyMode,
    flushProgressOnDone,
    onToolResult,
    onTurnTerminal,
    onSilentStopSettled,
    log,
  } = deps;
  // 呈现大脑(正文累积 / render 投影 / 过程区合成 / trailing-edge 快照)抽到
  // im/shared/turnPresenter, 与个人 IM 渠道共用同一实现。这里用 finalized-segments
  // 策略: isFinal 逐条契约、定稿段按消息切开、claude fallbackTail 自成段、uuid 缺失
  // 退 requestId、完成态经 buildMessageRenderItems 折叠 —— #1272/#1636/#1703 的实踩
  // 教训随代码留在该模块。收口(何时结束)刻意**不在** presenter: 见下面 done /
  // silentStop / onStatusChange 三条出口, 只有它们能让本观察器 settle。
  const presenter = createTurnPresenter({
    mode: 'finalized-segments',
    onProgress,
    progressBodyMode,
  });

  let stopListening: (() => void) | undefined;
  const finished = new Promise<void>((resolve, reject) => {
    let turnTerminalNotified = false;
    let pendingSettleUnsub: (() => void) | undefined;
    let pendingContinuationUnsub: (() => void) | undefined;
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
      pendingContinuationUnsub?.();
      pendingContinuationUnsub = undefined;
      presenter.stopProgress();
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
      if (ev.type === 'text') {
        // 正文累积(isFinal 逐条契约 / 定稿段按消息切开 / fallbackTail 自成段 /
        // uuid 缺失退 requestId)都在 presenter 的 finalized-segments 策略里。
        if (presenter.applyText(ev)) presenter.scheduleProgress();
        return;
      }
      if (ev.type === 'thinking') {
        // Desktop 不把 thinking 当 assistant block 边界: presenter 只投影思考活动
        // 本身、不 flush 正文; pushThinkingStep 变化时才刷帧。
        if (presenter.applyThinking(ev)) {
          presenter.ensureProgressTicker();
          presenter.scheduleProgress();
        }
        return;
      }
      if (ev.type === 'tool_use') {
        // 过程展示: 与 IM 流式卡同款滚动时间线(turnActivity), 让 Slack 侧
        // 在长 agentic turn 里看到"正在干什么", 而不是盯着 👀 表情干等。
        // tool_use 是明确的 assistant 消息边界(presenter 封存尾段并投影 tool 消息)。
        if (presenter.applyToolUse(ev)) {
          presenter.ensureProgressTicker();
          presenter.scheduleProgress();
        }
        return;
      }
      if (ev.type === 'error' && !isTerminalAgentErrorEvent(ev)) {
        // 非终止 error = agent 正在自愈(仅透已有本地化契约的自动重试)。turn 没
        // 结束, 不收口; 但必须在过程区留一行, 否则零产出的退避窗口里渠道那
        // 条消息整段静止(见 turnRetryNotice.ts 的模块注释)。ticker 让
        // "第 N 步 · 42s"与这行状态一起走时间, 重试期间没有任何新事件也能看出还在动。
        if (presenter.applyRetryNotice(ev)) {
          presenter.ensureProgressTicker();
          presenter.scheduleProgress();
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
        presenter.seal();
        // Telegram 的 turn.end 仍要经过 server 发布队列。先把节流窗里的最新安全
        // 快照冲进既有 progress 载体，避免客户端在 teardown 时直接吞掉最后一帧。
        if (flushProgressOnDone) presenter.flushProgress();
        // done 是 SDK turn 的权威完成事件；只有 provider 明确锁存了会自动
        // 唤醒下一 turn 的任务时，它才是中间边界。agent_task_update 只是 UI
        // 任务卡事件，Codex / Pi 子代理和 local_bash 都没有资格阻塞收口。
        const continuationId = ev.turnContinuationId;
        const continuationState = continuationId === undefined
          ? null
          : session.beginTurnContinuationWait?.(continuationId) ?? null;
        if (continuationState === 'cancelled') {
          // The provider already observed an explicit stop/teardown. There is
          // no automatic continuation output to wait for; Session receives a
          // separate ordered boundary, while this observer can settle now.
          finish();
          return;
        }
        if (continuationState === 'awaiting' || continuationState === 'active') {
          pendingContinuationUnsub?.();
          pendingContinuationUnsub = session.onTurnContinuationChange?.(
            (changedContinuationId, state) => {
              if (
                state !== 'cancelled' ||
                (continuationId !== undefined && changedContinuationId !== continuationId)
              ) {
                return;
              }
              pendingContinuationUnsub?.();
              pendingContinuationUnsub = undefined;
              finish();
            },
          );
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
        const friendly = terminalErrorText(data);
        if (friendly !== raw) {
          log.warn(`hook turn failed (mapped channel error): ${raw}`);
        }
        failTurn(new Error(friendly));
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
    markInteractionBoundary(): void {
      // main 的任一 interaction 请求会先封存 assistant block，再落交互消息。
      // 这只在请求首次出现时调用；剩余等待文案的切换不是新边界。
      presenter.markInteractionBoundary();
    },
    setNotice(notice: string | null): void {
      // 走**独立**的等交互通道, 不是瞬态 notice: 后者会被 pushToolStep /
      // pushThinkingStep / markActivityWriting 的 clearNotice 抹掉, 而挂起期间
      // agent 的其它子任务照样在吐这些事件。
      if (!presenter.setInteractionNotice(notice)) return;
      // ticker 让过程区的「第 N 步 · 42s」继续走时间: 等授权期间没有任何 agent
      // 事件, 不续 ticker 那条消息会连耗时都冻住。
      presenter.ensureProgressTicker();
      presenter.scheduleProgress();
    },
    text(): string {
      return presenter.wholeText();
    },
    finalText(): string {
      return presenter.finalText();
    },
  };
}
