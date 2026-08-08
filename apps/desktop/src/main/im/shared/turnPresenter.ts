/**
 * im/shared/turnPresenter.ts
 * ---------------------------------------------------------------------------
 * 一轮 turn 的**呈现大脑**(纯逻辑, 不做 IO): 正文累积、过程区时间线合成、进度
 * 快照的 trailing-edge 节流骨架。两个消费方共用同一实现:
 *
 *   1. hook-control/turnObserver —— 官方 bot(Slack / 官方 Telegram / X);
 *   2. im/shared/turnRunner —— 个人 IM 渠道(Telegram / 飞书 / Discord …)。
 *
 * 两侧的**正文累积语义天生不同**, 所以做成显式参数(`mode`), 不强行统一:
 *   - `finalized-segments`(observer): isFinal 是**逐条** agent_message 的完成
 *     信号, 追加进已定稿段(按消息边界切开), 流式增量走尾部缓冲; claude result
 *     的 fallbackTail 自成一段; 消息边界用 uuid 缺失时退到 requestId。完成态正文
 *     投影成 maker-shared 的 normalized messages, 交给桌面 / Mobile 共用的
 *     buildMessageRenderItems 判定折叠。#1272 / #1636 / #1703 的实踩教训嵌在下面
 *     的注释里, 搬运时原样保留。
 *   - `buffer-replace`(turnRunner): isFinal 用该条全文**整体替换**累积缓冲,
 *     流式增量追加。这是个人 IM 渠道现有行为, 本次抽取显式保留、不修旧账。
 *
 * 收口(何时结束)**不在这里** —— 由各消费方(observer 的 done/silentStop/
 * onStatusChange/settle 三出口、runner 的队列收口)自己负责。本模块只管"这一刻
 * 该显示什么", 不管"这一轮何时收口"。
 *
 * #1855 L1: 呈现策略集中为 PresenterPolicy(纯, presenter 可兑现)与
 * DriverPresentationCapabilities(声明车道能力, 由各 driver 出站时兑现, presenter
 * 不做 IO); 进度帧去重统一到 shouldEmitProgressFrame 的三槽基线(严格
 * pending ?? sending ?? lastSent, 只判完全相等, 绝无前缀判据)。**均不含 replyQuote**
 * —— 那三档由各车道 TelegramBehaviorConfig 直接供给, L1 不带默认(replyQuote 勘误)。
 */

import {
  TELEGRAM_PERSONAL_CAPABILITIES,
  type TelegramDriverCapabilities,
} from '@cindy/im';
import type { AgentEvent } from '@cindy/maker-core';
import {
  buildMessageRenderItems,
  type MessageRenderNormalizedMessage,
} from '@cindy/maker-shared/message-render';

import {
  createTurnActivity,
  markActivityWriting,
  pushThinkingStep,
  pushToolStep,
  renderActivity,
  setActivityNotice,
  setInteractionNotice,
  type TurnActivityState,
} from './turnActivity.js';
import { turnRetryNotice } from './turnRetryNotice.js';

/**
 * 进度快照节流(trailing-edge): 事件密集时最多每 1.5s 发一帧, 与 IM 流式卡的
 * chat.update 节流(1300ms)同量级 —— server 侧每帧一次 chat.update(Tier 3
 * ~50/min/频道), 这个间隔留有安全余量。
 */
export const PROGRESS_THROTTLE_MS = 1500;
/** 无新事件时的低频刷新(过程区耗时行"第 N 步 · 42s"不冻结)。 */
export const PROGRESS_TICK_MS = 5000;
/** 单帧快照长度上限: 头部截断 —— server 侧占位消息本就 3900 上限, 中间帧
 *  开头(过程区 + 正文起始)信息量最大, 收口后 turn.end 会带完整文本。 */
export const PROGRESS_SNAPSHOT_MAX_CHARS = 3800;

/**
 * 纯呈现策略(#1855 L1)。无 IO —— 只放 presenter 能自己兑现的项, 两消费方共用
 * **同一规格与同一默认值**(DEFAULT_PRESENTER_POLICY 单一出处): 官方 turnObserver 走
 * 本模块的 trailing-edge 发射器兑现该规格; 个人 turnRunner 的过程区节流(patchMarkdownCard)
 * **保留自己的实现**, 只引用同一默认间隔 —— 是"同一规格/同一数值", 不是"同一份代码"。
 *
 * **不含 replyQuote**: emoji/回复引用三档(emojiReactions / replyQuoteGroup /
 * replyQuoteDm)由各车道的 TelegramBehaviorConfig 直接供给, presenter/L1 既不持有
 * 也不带出厂默认(#1855 replyQuote 勘误)。需要真正出站/渠道能力才能兑现的策略见
 * DriverPresentationCapabilities。
 */
export interface PresenterPolicy {
  /**
   * 过程区快照 trailing-edge 节流间隔(ms)。两侧共用**同一数值规格**(密集事件在一个
   * 窗口内合帧, 窗口末取最新内容发一帧); 官方发射器与个人 patchMarkdownCard 各自实现
   * 这条尾沿语义, 只从这里取同一间隔 —— 统一的是规格与默认值, 不是同一份代码。
   */
  intermediateThrottleMs: number;
  /** 单帧过程快照渲染长度上限; 超限头部截断(收口后由 turn.end 带完整文本)。 */
  intermediateMaxRenderedChars: number;
  /**
   * 惰性占位: true = 无真实正文时不发过程帧(默认, 现有行为)。presenter 侧兑现为
   * "空合成视图不发帧"; driver 侧兑现为"有正文才建消息"(streamingText 现状)。
   */
  lazyPlaceholder: boolean;
}

/** 默认策略 = 现有两侧常量, 保证零行为变化, 且是两消费方引用的**单一出处**。 */
export const DEFAULT_PRESENTER_POLICY: PresenterPolicy = {
  intermediateThrottleMs: PROGRESS_THROTTLE_MS,
  intermediateMaxRenderedChars: PROGRESS_SNAPSHOT_MAX_CHARS,
  lazyPlaceholder: true,
};

/**
 * 需要真正出站 / 渠道能力才能兑现的呈现能力契约(#1855 L1 §B/§D/§E)。
 *
 * **单一真相源在 @cindy/im**(`telegram/presentationCapabilities.ts`),这里只做
 * **re-export**:契约值由同包 driver(index.ts)真正消费(typing 续命间隔/上限、
 * link preview 关闭都直接引用它,不再各写字面量 —— 注意 link preview 的覆盖面是
 * **答案那条路**, 不是全档出站: 卡片、rich 主路径、提示类消息都不带, 详见契约字段
 * 注释);desktop 侧沿用旧名
 * `DriverPresentationCapabilities` / `PERSONAL_DRIVER_CAPABILITIES` 作为 L1 呈现层的
 * 能力声明锚,依赖方向 desktop → @cindy/im 不成环。presenter 本体不做任何 IO。
 *
 * **不含 replyQuote**: 见 PresenterPolicy 注释与契约模块头。
 */
export type DriverPresentationCapabilities = TelegramDriverCapabilities;

/** 个人 IM 车道能力基线(re-export 自 @cindy/im 单一出处)。**不是官方默认**。 */
export const PERSONAL_DRIVER_CAPABILITIES: DriverPresentationCapabilities =
  TELEGRAM_PERSONAL_CAPABILITIES;

/**
 * 进度帧去重基线(#1855 L1, 与 server controller.ts 3423-3461 的三槽语义对齐)。
 * 候选帧要不要真的发出去, 只跟"最近一次已知的帧文本"比 —— 而"最近一次已知"
 * **严格**按 `pending ?? sending ?? lastSent` 取:
 *   - pending: 已排队但尚未起飞的帧(有就是它最新);
 *   - sending: 正在 in-flight 的那一帧;
 *   - lastSent: 已确认送达的上一帧。
 *
 * `createProgressEmitter` 真正维护这三槽:emit 返回 Promise 时,in-flight 期间新帧压
 * pending、settle 后提升(见该函数)。emit 同步返回时 sending/pending 瞬时坍缩,只有
 * lastSent 是活的 —— 这是同步 sink 的真实形态,不伪造额外槽;三槽机制对异步 sink
 * (会 await 出站的三槽拥有者)完整生效。
 */
export interface ProgressDedupeSlots {
  /** 已排队未起飞的帧文本(有 in-flight 发送时,新候选压这里,取最新)。 */
  pending?: string;
  /** 正在 in-flight 的那一帧文本(emit 返回的 Promise 未 settle)。 */
  sending?: string;
  /** 已确认送达的上一帧文本。 */
  lastSent?: string;
}

/** 三槽基线: pending ?? sending ?? lastSent(严格此顺序)。 */
export function progressDedupeBaseline(slots: ProgressDedupeSlots): string | undefined {
  return slots.pending ?? slots.sending ?? slots.lastSent;
}

/**
 * 候选帧与基线**完全相等**才判重复(不发); 其余一律发。
 *
 * **绝不做前缀判据**(候选是基线前缀 / 基线是候选前缀都照发)—— server 侧实踩
 * (controller.ts 3423-3461): 前缀判据会在"流式增量恰好以上一帧开头"时把真实
 * 新内容判成重复吞掉, 用户看到过程区卡死。
 */
export function shouldEmitProgressFrame(candidate: string, slots: ProgressDedupeSlots): boolean {
  return candidate !== progressDedupeBaseline(slots);
}

/** trailing-edge 节流发射器的公开形态。 */
export interface ProgressEmitter {
  schedule(): void;
  ensureTicker(): void;
  stop(): void;
}

/**
 * 进度快照发射器: 合成「过程区时间线 + 部分正文」并按 trailing-edge 节流回调。
 * 纯定时器逻辑, 不做 IO —— 真正的发送(turn.progress 帧)由调用方注入的
 * emit 承担。stop() 后不再发射(收口后的迟到事件被丢弃)。
 *
 * **三槽去重(#1855 L1)**:发射器真正维护 `ProgressDedupeSlots`
 * (pending ?? sending ?? lastSent),候选帧与该基线**完全相等**才丢弃。
 *   - emit 同步返回(observer 的 turn.progress 现状,尽力而为、不 await):send 瞬时
 *     完成,sending→lastSent 立刻坍缩,pending 用不上 —— 时序与旧实现逐字等价
 *     (首帧立即、窗口内 trailing、内容不变不重发)。
 *   - emit 返回 Promise(会 await 出站的三槽拥有者,如带网络回压的卡片编辑):in-flight
 *     期间到来的新帧压 pending 并去重,settle 后提升为下一次 send。这样三槽名副其实,
 *     而非空占位。
 */
export function createProgressEmitter(
  emit: (text: string) => void | Promise<void>,
  compose: () => string,
  policy: PresenterPolicy = DEFAULT_PRESENTER_POLICY,
): ProgressEmitter {
  let lastEmitAt = 0;
  // 三槽真实状态(见 ProgressDedupeSlots):去重基线严格 pending ?? sending ?? lastSent。
  const slots: ProgressDedupeSlots = {};
  let pending: NodeJS.Timeout | null = null;
  let ticker: NodeJS.Timeout | null = null;
  let stopped = false;

  /**
   * 一次出站结束后的状态推进(无论成功/失败都要解除 in-flight, 再冲刷窗口内压入的 pending):
   *   - 成功: sending→lastSent —— 该帧已送达, 成为新的去重基线;
   *   - 失败(async emit reject): **绝不**把没送达的帧记进 lastSent。否则同一快照重试时会被
   *     shouldEmitProgressFrame 判等去重吞掉、永远发不出去。只清 sending 解除 in-flight、
   *     **保留原 lastSent**, 于是相同内容在下一次 schedule / ticker 触发时仍判为"与基线不等"
   *     而重新起飞(重试)。
   * 两种情况都要把 in-flight 期间压入的 pending(更新的一帧)冲刷出去, 否则会残留孤儿帧,
   * 被后续 settle 误当"最新"发出。
   */
  const finishSend = (failed: boolean): void => {
    if (!failed && slots.sending !== undefined) slots.lastSent = slots.sending;
    slots.sending = undefined;
    if (stopped) {
      slots.pending = undefined;
      return;
    }
    if (slots.pending !== undefined) {
      const next = slots.pending;
      slots.pending = undefined;
      // pending 压入时已对当时基线去重; 基线变化(lastSent 可能刚提升)后再核一次, 相等则不重发。
      if (shouldEmitProgressFrame(next, slots)) startSend(next);
    }
  };

  /**
   * 起飞一帧: 标记 sending(in-flight), 记节流基准, 调 emit。同步返回即视为立即送达
   * (observer turn.progress 现状, 逐字等价旧实现); 异步按 resolve/reject 分别推进 ——
   * reject 走失败分支, 不污染 lastSent(见 finishSend)。
   */
  const startSend = (snapshot: string): void => {
    slots.sending = snapshot;
    lastEmitAt = Date.now();
    const result = emit(snapshot);
    if (result && typeof (result as Promise<void>).then === 'function') {
      (result as Promise<void>).then(
        () => finishSend(false),
        () => finishSend(true),
      );
    } else {
      finishSend(false);
    }
  };

  const fire = (): void => {
    if (stopped) return;
    const text = compose();
    // 惰性占位: 空合成视图不发帧(默认)。driver 侧同一策略兑现为"有正文才建消息"。
    if (policy.lazyPlaceholder && text.length === 0) return;
    const max = policy.intermediateMaxRenderedChars;
    const snapshot = text.length > max ? `${text.slice(0, max - 1)}…` : text;
    // The low-frequency activity ticker can fire while the user-visible
    // answer is unchanged. Do not spend provider API calls on identical
    // full snapshots (and, for Telegram, do not re-animate the same draft).
    // 三槽基线去重: 与 pending ?? sending ?? lastSent **完全相等**才不发, 绝无前缀判据。
    if (!shouldEmitProgressFrame(snapshot, slots)) return;
    // 有 in-flight 发送时压 pending(trailing: 保留最新一帧); 否则直接起飞。
    if (slots.sending !== undefined) {
      slots.pending = snapshot;
      return;
    }
    startSend(snapshot);
  };
  const schedule = (): void => {
    if (stopped || pending !== null) return;
    const wait = Math.max(0, lastEmitAt + policy.intermediateThrottleMs - Date.now());
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
      // 收口后丢弃尚未起飞的 pending; in-flight 的 sending 由 finishSend 的 stopped 分支清理。
      slots.pending = undefined;
    },
  };
}

/**
 * 过程区 + 正文的合成骨架: 有过程区时"过程区在上、正文在下", 无过程区时只留
 * 正文。两侧运行中视图共用这一条 —— observer 的进度快照与 turnRunner 的
 * composeStreamingView(非收口态)逐字一致。
 */
export function composeProgressView(activityText: string, body: string): string {
  if (!activityText) return body;
  return body ? `${activityText}\n\n${body}` : activityText;
}

/** 正文累积策略。见模块头。 */
export type TurnPresenterMode = 'finalized-segments' | 'buffer-replace';

export interface TurnPresenterOptions {
  mode: TurnPresenterMode;
  /** 过程区耗时基准(activity.startedAt); 缺省取当前时刻。 */
  startedAt?: number;
  /** 注入后启用 trailing-edge 进度发射器(observer 路径); 省略 = 零开销, 无发射器。 */
  onProgress?: (text: string) => void;
  /** 纯呈现策略(节流/长度上限/惰性占位); 省略 = DEFAULT_PRESENTER_POLICY(两侧同值)。 */
  policy?: PresenterPolicy;
}

export interface TurnPresenter {
  /** 过程区时间线状态(turnActivity), 直接暴露供消费方做既有的直接调用。 */
  readonly activity: TurnActivityState;

  /** 累积一个 text 事件。返回是否真的落了正文(供消费方决定要不要刷新)。 */
  applyText(ev: AgentEvent): boolean;
  /** tool_use 边界: 记一步(+ segments: 封存尾段并投影 tool 消息)。返回是否落了一步。 */
  applyToolUse(ev: AgentEvent): boolean;
  /** thinking 事件: segments 投影 + 记一步; buffer 忽略。返回过程区是否变化。 */
  applyThinking(ev: AgentEvent): boolean;
  /** 非终止重试 error → 单行状态说明。返回状态行是否变化。 */
  applyRetryNotice(ev: AgentEvent): boolean;
  /** done: 封存本轮尾段(segments); buffer 无操作。 */
  seal(): void;
  /** 新交互请求边界(segments); buffer 无操作。 */
  markInteractionBoundary(): void;
  /** 设/清「在等你确认」那一行。返回是否变化。 */
  setInteractionNotice(notice: string | null): boolean;

  /** 运行中快照展示的正文(segments: 仅当前/最后一条消息; buffer: 整段缓冲)。 */
  progressBody(): string;
  /** 整轮累积的助手正文。 */
  wholeText(): string;
  /** 正式答复正文(segments: 桌面消息流折叠; buffer: 整段缓冲)。 */
  finalText(): string;
  /** 整体替换正文(buffer 模式: 本地图片物化后回写 / 收口重置)。segments 无此语义。 */
  replaceBody(text: string): void;

  /** 过程区(renderActivity, 取当前时刻) + 给定正文 的运行中合成。 */
  composeRunning(body: string): string;

  // ── trailing-edge 发射器(仅当注入 onProgress 时有效, 否则均为 no-op) ──
  scheduleProgress(): void;
  ensureProgressTicker(): void;
  stopProgress(): void;
}

/** 正文累积引擎的内部契约(两种 mode 各一份实现)。 */
interface BodyEngine {
  /** 累积一个 text 事件的正文(不碰 activity)。调用前已保证 data.text 是 string。 */
  applyText(ev: AgentEvent): void;
  /** tool_use 边界的正文投影(segments: 封存尾段 + 投影 tool 消息; buffer: 无)。 */
  projectToolUse(toolName: string, input: unknown, toolUseId: string | undefined): void;
  /** thinking 的正文投影(segments: 原位更新 render 消息; buffer: 无)。 */
  projectThinking(ev: AgentEvent): void;
  /** done 封存尾段。 */
  seal(): void;
  /** 新交互请求边界的正文投影。 */
  projectInteractionBoundary(): void;
  progressBody(): string;
  wholeText(): string;
  finalText(): string;
  /** 整体替换正文(buffer 模式)。segments 无单一缓冲, 不支持。 */
  replaceBody(text: string): void;
}

/**
 * buffer-replace 引擎(turnRunner 现有行为): isFinal 用该条全文整体替换累积缓冲,
 * 流式增量追加。刻意保留个人 IM 渠道旧账 —— 不投影 render 消息, 无消息边界切分,
 * finalText 即整段缓冲。
 */
function createBufferEngine(): BodyEngine {
  let buffer = '';
  return {
    applyText(ev: AgentEvent): void {
      const data = ev.data as { text: string; isFinal?: boolean };
      // Final block — replace buffer with canonical text; deltas append.
      if (data.isFinal) buffer = data.text;
      else buffer += data.text;
    },
    projectToolUse(): void {
      // buffer 模式不做消息边界投影。
    },
    projectThinking(): void {
      // 个人 IM 渠道不把 thinking 投到正文(turnRunner 的 case 'thinking' 直接 return)。
    },
    seal(): void {
      // buffer 已是 canonical 全文, 无尾段需要封存。
    },
    projectInteractionBoundary(): void {
      // buffer 模式无 render 投影。
    },
    progressBody(): string {
      return buffer;
    },
    wholeText(): string {
      return buffer;
    },
    finalText(): string {
      return buffer;
    },
    replaceBody(text: string): void {
      buffer = text;
    },
  };
}

/**
 * finalized-segments 引擎(turnObserver 现有行为)。
 *
 * 文本累积语义(2026-07-28 修订): translator 的 isFinal 是**逐条**
 * agent_message 的完成信号(每条完成都携带该条全文), 不是整个 turn 的
 * 终稿 —— 用它整体替换累积文本, 会让"先回一句 → 思考 → 终答"的多消息
 * turn 只剩最后被替换的那条(实踩: Telegram 群里最终答案丢失)。
 * 正确姿势: isFinal 把该条追加进已定稿段, 流式增量走尾部缓冲。
 * 定稿段**按消息切开存**(而不是直接拼成一个串): 完成态需要把消息边界
 * 投影给 buildMessageRenderItems。join('\n\n') 与此前的逐段拼接完全等价
 * (同一条消息的相邻块在入栈时已连拼, 段内不含分隔)。
 */
function createSegmentsEngine(): BodyEngine {
  const finalizedSegments: string[] = [];
  /** finalizedSegments 在共享消息投影里的对应下标(同消息多 block 原位更新)。 */
  const finalizedRenderIndexes: number[] = [];
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
  // 完成态正文不在 hook 自造一套「最后一段」启发式，而是把本轮事件投影成
  // maker-shared 的 normalized messages，交给桌面 / Mobile 共用的
  // buildMessageRenderItems 判定哪些过程文字折叠、哪些交付正文保持展开。
  const renderMessages: MessageRenderNormalizedMessage[] = [];
  const thinkingRenderIndexes = new Map<string, number>();
  const renderClockBase = Date.now();
  let renderSequence = 0;
  let currentTurnRenderStart = 0;
  const nextRenderIdentity = (prefix: string): { key: string; createdAt: string } => {
    const sequence = renderSequence++;
    return {
      key: `hook-${prefix}-${sequence}`,
      // 单个 observer 内只需要稳定顺序；用单调毫秒避免真实长 turn 被历史窗口
      // gap 规则误切成另一轮（这里本来就只观察同一轮及其自动续 turn）。
      createdAt: new Date(renderClockBase + sequence).toISOString(),
    };
  };
  const pushRenderMessage = (
    kind: MessageRenderNormalizedMessage['kind'],
    body: string,
    sourceExtra: Partial<MessageRenderNormalizedMessage['source']> = {},
  ): number => {
    const { key, createdAt } = nextRenderIdentity(kind);
    renderMessages.push({
      key,
      source: {
        id: key,
        clientId: key,
        role: kind === 'tool' ? 'tool_use' : kind,
        createdAt,
        ...sourceExtra,
      },
      kind,
      label: kind,
      body,
      createdAt,
    });
    return renderMessages.length - 1;
  };
  const pushFinalizedSegment = (segment: string, sameMessage: boolean): void => {
    if (sameMessage && finalizedSegments.length > 0) {
      const segmentIndex = finalizedSegments.length - 1;
      finalizedSegments[segmentIndex] += segment;
      const renderIndex = finalizedRenderIndexes[segmentIndex];
      const rendered = renderMessages[renderIndex];
      if (rendered) rendered.body = finalizedSegments[segmentIndex];
      return;
    }
    finalizedSegments.push(segment);
    finalizedRenderIndexes.push(pushRenderMessage('assistant', segment));
  };
  const finalizeStreamTail = (): void => {
    if (streamTail.trim().length === 0) return;
    pushFinalizedSegment(streamTail, false);
    streamTail = '';
    lastFinalUuid = undefined;
    recomputeAssistantText();
  };
  const progressAssistantText = (): string => {
    if (streamTail.trim().length > 0) return streamTail;
    return finalizedSegments[finalizedSegments.length - 1] ?? '';
  };
  const finalAnswerText = (): string => {
    const visible = buildMessageRenderItems(renderMessages, { isSessionStreaming: false })
      .flatMap((item) =>
        item.type === 'message'
        && item.message.kind === 'assistant'
        && item.message.body.trim().length > 0
          ? [item.message.body]
          : [],
      )
      .join('\n\n');
    return visible.trim().length > 0 ? visible : assistantText;
  };

  return {
    applyText(ev: AgentEvent): void {
      const data = ev.data as { text: string; isFinal?: boolean };
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
        // 少了这道回退, 一条含多个 text block 的消息会被拆成多个"消息"。
        // finalText() 会按桌面消息语义识别正式正文; 不能因为某个渠道最终只
        // 允许一条消息, 就在这里把同一条消息的内容拆成「最后一段」。
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
        pushFinalizedSegment(segment, sameMessage);
        lastFinalUuid = messageId;
        streamTail = '';
      } else {
        streamTail += data.text;
      }
      recomputeAssistantText();
    },
    projectToolUse(toolName: string, input: unknown, toolUseId: string | undefined): void {
      // tool_use 是明确的 assistant 消息边界，与桌面
      // messagePersistBroadcaster.flushAssistantBlock 同口径。
      finalizeStreamTail();
      lastFinalUuid = undefined;
      pushRenderMessage('tool', '', {
        toolName,
        toolInput: input,
        ...(toolUseId !== undefined ? { toolUseId } : {}),
      });
    },
    projectThinking(ev: AgentEvent): void {
      // Desktop 不把 thinking 当 assistant block 边界：同一条消息可以在
      // thinking 前后继续输出文字。这里只投影思考活动本身，不能 flush 正文。
      // 同一个 blockId 的 start/delta/final 原位更新，和 renderer 消息模型一致。
      const data = ev.data as {
        stage?: unknown;
        blockId?: unknown;
        text?: unknown;
        durationMs?: unknown;
        startedAt?: unknown;
      } | null;
      const blockId = typeof data?.blockId === 'string'
        ? data.blockId
        : `anonymous-${renderSequence}`;
      const content = data?.stage === 'redacted'
        ? { isRedacted: true }
        : {
            ...(typeof data?.text === 'string' ? { text: data.text } : {}),
            ...(typeof data?.durationMs === 'number' ? { durationMs: data.durationMs } : {}),
          };
      const existingIndex = thinkingRenderIndexes.get(blockId);
      if (existingIndex === undefined) {
        const renderIndex = pushRenderMessage('thinking', '', {
          clientId: blockId,
          content,
          ...(typeof data?.startedAt === 'number'
            ? { createdAt: new Date(data.startedAt).toISOString() }
            : {}),
        });
        thinkingRenderIndexes.set(blockId, renderIndex);
      } else {
        const rendered = renderMessages[existingIndex];
        if (rendered) rendered.source.content = content;
      }
    },
    seal(): void {
      // 极端 adapter 路径可能只有增量没有 isFinal；done 仍是确定边界，此时把尾段
      // 物化成一条 assistant message，和桌面 main 在 done 前落最后正文同口径。
      finalizeStreamTail();
      for (let index = renderMessages.length - 1; index >= currentTurnRenderStart; index--) {
        const message = renderMessages[index];
        if (message.kind !== 'assistant' || message.body.trim().length === 0) continue;
        message.turnCompleted = true;
        break;
      }
      currentTurnRenderStart = renderMessages.length;
      // `turnCompleted` seal 之后，即使 provider 复用同一个上游 message id，
      // 下一 SDK turn 也必须从新的 assistant message 开始。
      lastFinalUuid = undefined;
    },
    projectInteractionBoundary(): void {
      // main 的任一 interaction 请求会先封存 assistant block，再落交互消息。
      // 这只在请求首次出现时调用；剩余等待文案的切换不是新边界。
      finalizeStreamTail();
      lastFinalUuid = undefined;
      pushRenderMessage('system', '', { role: 'system', content: { kind: 'interaction' } });
    },
    progressBody(): string {
      return progressAssistantText();
    },
    wholeText(): string {
      return assistantText;
    },
    finalText(): string {
      return finalAnswerText();
    },
    replaceBody(): void {
      // finalized-segments 没有单一缓冲可整体替换(正文是按消息切开的定稿段 +
      // 流式尾部)。observer 从不调用它; 调到即接线错误, 显式失败而不是静默吞掉。
      throw new Error('finalized-segments presenter does not support replaceBody');
    },
  };
}

export function createTurnPresenter(options: TurnPresenterOptions): TurnPresenter {
  const startedAt = options.startedAt ?? Date.now();
  const policy = options.policy ?? DEFAULT_PRESENTER_POLICY;
  const body: BodyEngine =
    options.mode === 'finalized-segments' ? createSegmentsEngine() : createBufferEngine();
  const activity = createTurnActivity(startedAt);
  const composeRunning = (b: string): string =>
    composeProgressView(renderActivity(activity, Date.now()), b);
  const emitter = options.onProgress
    ? createProgressEmitter(options.onProgress, () => composeRunning(body.progressBody()), policy)
    : null;

  return {
    activity,
    applyText(ev: AgentEvent): boolean {
      const data = ev.data as { text?: string } | null;
      if (!data || typeof data.text !== 'string') return false;
      body.applyText(ev);
      markActivityWriting(activity);
      return true;
    },
    applyToolUse(ev: AgentEvent): boolean {
      const data = ev.data as { toolName?: unknown; toolUseId?: unknown; input?: unknown } | null;
      if (!data || typeof data.toolName !== 'string') return false;
      const toolUseId = typeof data.toolUseId === 'string' ? data.toolUseId : undefined;
      body.projectToolUse(data.toolName, data.input, toolUseId);
      pushToolStep(activity, data.toolName, data.input, toolUseId);
      return true;
    },
    applyThinking(ev: AgentEvent): boolean {
      body.projectThinking(ev);
      return pushThinkingStep(activity, ev.data);
    },
    applyRetryNotice(ev: AgentEvent): boolean {
      const notice = turnRetryNotice(ev.data);
      if (notice === null) return false;
      return setActivityNotice(activity, notice);
    },
    seal(): void {
      body.seal();
    },
    markInteractionBoundary(): void {
      body.projectInteractionBoundary();
    },
    setInteractionNotice(notice: string | null): boolean {
      return setInteractionNotice(activity, notice);
    },
    progressBody(): string {
      return body.progressBody();
    },
    wholeText(): string {
      return body.wholeText();
    },
    finalText(): string {
      return body.finalText();
    },
    replaceBody(text: string): void {
      body.replaceBody(text);
    },
    composeRunning,
    scheduleProgress(): void {
      emitter?.schedule();
    },
    ensureProgressTicker(): void {
      emitter?.ensureTicker();
    },
    stopProgress(): void {
      emitter?.stop();
    },
  };
}
