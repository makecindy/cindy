/**
 * 流式正文匀速放出（DESIGN.md §14.4「Stream pacing」）。
 *
 * 网络与 IPC 送来的文本是成块到达的：模型、中转与 renderer 批处理会把几十到
 * 几百个字合成一批。直接按批渲染，整段会同帧出现，看起来一顿一顿。这里在
 * 「已收到的原文」和「已显示的前缀」之间放一个自适应缓冲：
 *
 * - **速度跟积压走**：目标延迟随到达间隔与积压量自适应（匀速小块≈120ms，
 *   突发大块≈到达间隔，单次大段至少按约 600 字/秒摊开，持续高速输出时按实测
 *   到达速度摊开，最长 600ms），
 *   速度 = 积压 / 目标延迟，平滑后按帧放出；
 * - **按词边界放出**：只在空白、标点或 CJK 字之后截断，表格行整行出现，
 *   不是逐字打字机；
 * - **按真实渲染耗时退避**：发布间隔 = 渲染耗时 × 倍数（下限 33ms，上限 400ms），
 *   长文档自动降频，不再按字符长度猜；输入框打字时至少 50ms 一次，给打字让路；
 * - **永不丢字**：流式结束时剩余积压在 150ms 内快速放完（窗口隐藏、关闭动效时
 *   立即显示）；正文被改写（非追加）时立即显示全文；挂载时已有的正文直接显示，
 *   不重播。
 *
 * 纯算法在 `StreamingRevealBuffer`，与时钟无关，便于确定性测试；React 接线在
 * `useStreamingReveal`。复制、搜索、导航仍使用完整原文，不读这里的前缀。
 */
import { useLayoutEffect, useRef, useState } from 'react';

import { isComposerTypingRecently } from '@/lib/composerTypingActivity';

export const STREAM_REVEAL = {
  /** 目标显示延迟的上下限。下限决定匀速流的「跟手」程度，上限决定突发能摊多平。 */
  minLagMs: 120,
  maxLagMs: 600,
  /** 目标延迟 = 平滑后的到达间隔 × 该系数，让一批文字恰好在下一批到达前放完。 */
  lagPerArrivalGap: 1.25,
  /**
   * 单次积压至少按这个速度摊开（再受 maxLagMs 封顶）。没有它，首个大块会在
   * minLagMs 内三四次就放完，仍像成块跳出。持续高速输出时摊开速度改跟实测
   * 到达速度 × arrivalRateHeadroom，显示延迟不会因为模型快而被拉到上限。
   */
  comfortCharsPerSecond: 600,
  arrivalRateHeadroom: 1.25,
  /** 到达间隔 EMA 系数。 */
  arrivalGapSmoothing: 0.3,
  /** 速度追随目标的时间常数；越小越跟手，越大越平。 */
  rateSmoothingMs: 80,
  /** 尾部最低速度，保证最后几个字不会爬行。 */
  minCharsPerSecond: 40,
  /** 单帧最多按这么长的时间推进，后台恢复或长任务后不突然倾倒。 */
  maxStepMs: 100,
  /** 找词边界最多向后看这么多字；超长 token（URL、长代码）直接截断。 */
  boundaryLookahead: 24,
  /** 发布间隔：渲染耗时 × costFactor，夹在 [minPublishMs, maxPublishMs]。 */
  costFactor: 4,
  minPublishMs: 33,
  maxPublishMs: 400,
  /** 输入框打字窗口内的最小发布间隔（typing-first，见 composerTypingActivity）。 */
  typingPublishMs: 50,
  /** 渲染耗时 EMA 系数。 */
  costSmoothing: 0.3,
  /** 请求动画帧后超过这么久才执行，视为主线程繁忙。 */
  frameBudgetMs: 20,
  /** 繁忙时发布间隔 = 超出部分 × 该倍数。 */
  busyFactor: 4,
} as const;

const WIDE_CHAR = /[⺀-鿿가-힯豈-﫿＀-￯　-〿]/;
const BREAK_AFTER = /[\s.,;:!?)\]}>，。；：！？、）】」』》…—-]/;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isCutPoint(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return true;
  const before = text[index - 1];
  const after = text[index];
  return (
    /\s/.test(after) ||
    BREAK_AFTER.test(before) ||
    WIDE_CHAR.test(before) ||
    WIDE_CHAR.test(after)
  );
}

function lineStartOf(text: string, index: number): number {
  return text.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
}

/**
 * 把候选截断点推到最近的可读边界：词尾、标点、CJK 字之间；表格行推到行尾。
 * 永远返回 [index, text.length] 内的位置，且不切开代理对。
 */
export function alignRevealBoundary(text: string, index: number): number {
  if (index >= text.length) return text.length;
  if (index <= 0) return 0;
  const lineStart = lineStartOf(text, index);
  if (/^ {0,3}\|/.test(text.slice(lineStart, lineStart + 5))) {
    const lineEnd = text.indexOf('\n', index);
    return lineEnd === -1 ? text.length : lineEnd + 1;
  }
  const limit = Math.min(text.length, index + STREAM_REVEAL.boundaryLookahead);
  for (let cursor = index; cursor <= limit; cursor++) {
    if (isCutPoint(text, cursor)) {
      return isHighSurrogate(text.charCodeAt(cursor - 1)) ? cursor + 1 : cursor;
    }
  }
  return isHighSurrogate(text.charCodeAt(index - 1)) ? index + 1 : index;
}

/** 纯算法：不持有时钟，所有时刻由调用方传入（ms）。 */
export class StreamingRevealBuffer {
  private source = '';
  private shown = 0;
  private rate = 0;
  private carry = 0;
  private lastTickAt: number | null = null;
  private lastArrivalAt: number | null = null;
  private arrivalGapMs: number = STREAM_REVEAL.minLagMs / STREAM_REVEAL.lagPerArrivalGap;
  /** 平滑后的到达速度（字/秒）；0 = 还没有两次到达可供估计。 */
  private arrivalCharsPerSecond = 0;

  /** 初始正文直接可见：挂载、remount 或切回任务时不重播已有内容。 */
  constructor(initial = '') {
    this.source = initial;
    this.shown = initial.length;
  }

  get text(): string {
    return this.shown >= this.source.length ? this.source : this.source.slice(0, this.shown);
  }

  get pending(): boolean {
    return this.shown < this.source.length;
  }

  get backlog(): number {
    return this.source.length - this.shown;
  }

  /** 收到新的完整原文。非追加的改写（重试、替换、截断）立即整段显示。 */
  update(source: string, now: number): void {
    if (source === this.source) return;
    const appended = source.length > this.source.length && source.startsWith(this.source);
    if (!appended) {
      this.source = source;
      this.flush();
      return;
    }
    if (this.lastArrivalAt !== null) {
      const gap = Math.max(0, now - this.lastArrivalAt);
      this.arrivalGapMs += (gap - this.arrivalGapMs) * STREAM_REVEAL.arrivalGapSmoothing;
      const instant = ((source.length - this.source.length) * 1000) / Math.max(gap, 16);
      this.arrivalCharsPerSecond =
        this.arrivalCharsPerSecond === 0
          ? instant
          : this.arrivalCharsPerSecond +
            (instant - this.arrivalCharsPerSecond) * STREAM_REVEAL.arrivalGapSmoothing;
    }
    this.lastArrivalAt = now;
    if (!this.pending) this.lastTickAt = now;
    this.source = source;
  }

  /** 立即显示全部已收到的原文。 */
  flush(): void {
    this.shown = this.source.length;
    this.rate = 0;
    this.carry = 0;
    this.lastTickAt = null;
  }

  /** 当前目标显示延迟（ms）：取到达节奏与积压量要求的较大者，夹在上下限之间。 */
  get targetLagMs(): number {
    const byArrival = this.arrivalGapMs * STREAM_REVEAL.lagPerArrivalGap;
    const spreadRate = Math.max(
      STREAM_REVEAL.comfortCharsPerSecond,
      this.arrivalCharsPerSecond * STREAM_REVEAL.arrivalRateHeadroom,
    );
    const byBacklog = (this.backlog * 1000) / spreadRate;
    return Math.min(
      STREAM_REVEAL.maxLagMs,
      Math.max(STREAM_REVEAL.minLagMs, byArrival, byBacklog),
    );
  }

  /**
   * 推进到 `now`；返回可见前缀是否变化。`maxLagMs` 用于收尾：流式结束后把剩余
   * 积压压缩到这么长时间内放完。
   */
  tick(now: number, maxLagMs?: number): boolean {
    if (!this.pending) {
      this.lastTickAt = now;
      return false;
    }
    const previousTick = this.lastTickAt ?? now - 16;
    const dt = Math.min(STREAM_REVEAL.maxStepMs, Math.max(0, now - previousTick));
    this.lastTickAt = now;
    if (dt === 0) return false;
    const backlog = this.backlog;
    const targetRate = Math.max(
      STREAM_REVEAL.minCharsPerSecond,
      (backlog * 1000) /
        (maxLagMs === undefined ? this.targetLagMs : Math.max(16, Math.min(maxLagMs, this.targetLagMs))),
    );
    this.rate =
      this.rate === 0
        ? targetRate
        : this.rate + (targetRate - this.rate) * Math.min(1, dt / STREAM_REVEAL.rateSmoothingMs);
    const advance = (this.rate * dt) / 1000 + this.carry;
    const whole = Math.floor(advance);
    if (whole < 1) {
      this.carry = advance;
      return false;
    }
    const target = Math.min(this.source.length, this.shown + whole);
    const aligned = alignRevealBoundary(this.source, target);
    // 对齐多放出的几个字不记成欠账：欠账会让后面几帧停住（实测 100~250ms 停顿）；
    // 平均速度的偏差由「速度跟积压走」的反馈自然抵消。
    this.carry = aligned > target ? 0 : advance - whole;
    if (aligned <= this.shown) return false;
    this.shown = aligned;
    if (!this.pending) {
      this.rate = 0;
      this.carry = 0;
    }
    return true;
  }
}

/**
 * 发布间隔：按测得的渲染耗时与主线程繁忙程度退避。纯函数，供测试与 hook 共用。
 * `frameDelayMs` 是请求动画帧到回调执行的平滑延迟：超过一帧说明主线程已被其它
 * 工作（消息列表、侧栏等的高频刷新）占满，此时继续逐帧发布只会叠出长任务。
 */
export function streamingRevealPublishInterval(
  renderCostMs: number,
  typing: boolean,
  frameDelayMs = 0,
): number {
  const busy = Math.max(0, frameDelayMs - STREAM_REVEAL.frameBudgetMs) * STREAM_REVEAL.busyFactor;
  const byCost = Math.min(
    STREAM_REVEAL.maxPublishMs,
    Math.max(STREAM_REVEAL.minPublishMs, renderCostMs * STREAM_REVEAL.costFactor, busy),
  );
  return typing ? Math.max(byCost, STREAM_REVEAL.typingPublishMs) : byCost;
}

interface RevealController {
  buffer: StreamingRevealBuffer;
  frame: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  lastPublishAt: number;
  costMs: number;
  /** 一次发布到它的 render 开始之间为 true；render 开始时刻记在 renderStartedAt。 */
  renderPending: boolean;
  renderStartedAt: number | null;
  /** 请求动画帧到回调执行的平滑延迟（主线程繁忙信号）。 */
  frameDelayMs: number;
  frameRequestedAt: number;
  pace: boolean;
  /** 收尾截止时刻（performance.now 基准）；null = 不在收尾。 */
  drainUntil: number | null;
  publish: (text: string, draining: boolean) => void;
}

function cancelScheduled(controller: RevealController): void {
  if (controller.frame !== null) cancelAnimationFrame(controller.frame);
  if (controller.timer !== null) clearTimeout(controller.timer);
  controller.frame = null;
  controller.timer = null;
}

function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/** 流式结束后剩余积压最多用这么久放完，再切到终版渲染。 */
export const STREAM_REVEAL_END_DRAIN_MS = 150;
/** rAF 时刻有抖动：差几毫秒不该整整多等一帧。 */
const FRAME_SLACK_MS = 6;
/** 超过这个等待才改用定时器（约两帧）。 */
const LONG_WAIT_MS = 34;
/** 隐藏窗口不做动画，也不按帧刷新：沿用旧的 100ms 级节奏，只保证不丢字。 */
const HIDDEN_PUBLISH_MS = 100;

function runFrame(controller: RevealController, viaFrame = false): void {
  controller.frame = null;
  controller.timer = null;
  const now = performance.now();
  if (viaFrame) {
    const delay = now - controller.frameRequestedAt;
    controller.frameDelayMs += (delay - controller.frameDelayMs) * STREAM_REVEAL.costSmoothing;
  }
  const hidden = isDocumentHidden();
  const draining = controller.drainUntil !== null;
  const interval = draining
    ? 0
    : Math.max(
        streamingRevealPublishInterval(controller.costMs, isComposerTypingRecently(), controller.frameDelayMs),
        hidden ? HIDDEN_PUBLISH_MS : 0,
      );
  const wait = controller.lastPublishAt + interval - now;
  if (wait > FRAME_SLACK_MS) {
    if (hidden || wait > LONG_WAIT_MS) {
      // 长退避用定时器等到快到期，再回到 rAF 对齐那一帧。
      controller.timer = setTimeout(() => {
        controller.timer = null;
        scheduleReveal(controller, true);
      }, hidden ? wait : wait - LONG_WAIT_MS / 2);
    } else {
      // 不到两帧的等待直接跳过本帧：经定时器再排 rAF 会多丢一整帧。
      controller.frameRequestedAt = performance.now();
      controller.frame = requestAnimationFrame(() => runFrame(controller, true));
    }
    return;
  }
  const before = controller.buffer.text;
  if (!controller.pace || hidden) controller.buffer.flush();
  else if (draining) controller.buffer.tick(now, controller.drainUntil! - now);
  else controller.buffer.tick(now);
  if (draining && now >= controller.drainUntil!) controller.buffer.flush();
  const next = controller.buffer.text;
  const finished = draining && !controller.buffer.pending;
  if (finished) controller.drainUntil = null;
  controller.lastPublishAt = now;
  if (next !== before) {
    // 不在动画帧里 flushSync：同步提交会把这棵子树的 render 叠进本帧的布局与绘制，
    // 以及同帧的其它刷新，合成一个更长的长任务（2026-11-25 合并 main 后黑盒实测
    // 最长单个长任务 +40~70ms）。交给 React 作为独立任务渲染，最多晚一帧可见；
    // 退避用的耗时由 hook 在 render 开始到 layout effect 之间测量。收尾的最后一批
    // 仍按流式渲染。
    controller.publish(next, draining);
  }
  if (finished) {
    // 切到终版要整篇解析并替换流式 DOM，是整条流里最重的一次提交，同样作为独立任务。
    controller.publish(next, false);
  }
  if (controller.buffer.pending) scheduleReveal(controller);
}

function scheduleReveal(controller: RevealController, fromTimer = false): void {
  if (controller.frame !== null || (controller.timer !== null && !fromTimer)) return;
  if (isDocumentHidden() || typeof requestAnimationFrame !== 'function') {
    controller.timer = setTimeout(() => runFrame(controller), STREAM_REVEAL.minPublishMs);
  } else {
    controller.frameRequestedAt = performance.now();
    controller.frame = requestAnimationFrame(() => runFrame(controller, true));
  }
}

export interface StreamingRevealState {
  /** 应显示的正文（流式期间是已收到原文的前缀）。 */
  text: string;
  /**
   * 流式已结束、但剩余积压仍在 STREAM_REVEAL_END_DRAIN_MS 内放出。调用方应继续
   * 按流式渲染（淡入、分片），放完后自动转为 false，再切终版。
   */
  draining: boolean;
}

/**
 * 流式期间返回应显示的前缀。
 *
 * - 流式结束：仍有积压且在做匀速放出时，用 ≤150ms 收尾放完（draining=true），
 *   否则立即返回全文；
 * - `pace=false`（关闭回复动效 / 系统减弱动态效果）：不缓冲，只保留按渲染耗时
 *   退避的发布节奏，结束时立即全文；
 * - 发布只重渲染调用方子树，不经过 store，不惊动消息列表等重子树。
 */
export function useStreamingReveal(content: string, streaming: boolean, pace: boolean): StreamingRevealState {
  const [state, setState] = useState<StreamingRevealState>({ text: content, draining: false });
  const controllerRef = useRef<RevealController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = {
      buffer: new StreamingRevealBuffer(content),
      frame: null,
      timer: null,
      lastPublishAt: 0,
      costMs: 0,
      renderPending: false,
      renderStartedAt: null,
      frameDelayMs: 0,
      frameRequestedAt: 0,
      pace,
      drainUntil: null,
      publish: (text, draining) => {
        controllerRef.current!.renderPending = true;
        setState({ text, draining });
      },
    };
  }
  const controller = controllerRef.current;
  // 发布引起的这次 render 从这里开始计时，到下面的 layout effect（子树已提交）结束。
  if (controller.renderPending && controller.renderStartedAt === null) {
    controller.renderStartedAt = performance.now();
  }
  const wasStreamingRef = useRef(streaming);

  useLayoutEffect(() => {
    const wasStreaming = wasStreamingRef.current;
    wasStreamingRef.current = streaming;
    controller.pace = pace;
    const now = performance.now();
    if (streaming) {
      controller.drainUntil = null;
      controller.buffer.update(content, now);
      if (controller.buffer.text !== state.text || controller.buffer.pending) scheduleReveal(controller);
      return;
    }
    // 流式刚结束：有积压且能按帧放出时收尾，否则立即全文。
    if (wasStreaming && pace && !isDocumentHidden() && typeof requestAnimationFrame === 'function') {
      controller.buffer.update(content, now);
      if (controller.buffer.pending) {
        controller.drainUntil = now + STREAM_REVEAL_END_DRAIN_MS;
        setState({ text: controller.buffer.text, draining: true });
        scheduleReveal(controller);
        return;
      }
    }
    if (controller.drainUntil !== null && controller.buffer.pending) {
      // 收尾中原文又变了：继续收尾到同一截止时刻。
      controller.buffer.update(content, now);
      scheduleReveal(controller);
      return;
    }
    cancelScheduled(controller);
    controller.drainUntil = null;
    controller.buffer = new StreamingRevealBuffer(content);
    controller.lastPublishAt = 0;
    if (state.text !== content || state.draining) setState({ text: content, draining: false });
    // `state` 只用来判断是否已同步；把它放进依赖会让每次发布再排一帧。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, streaming, pace, controller]);

  useLayoutEffect(() => {
    if (controller.renderStartedAt === null) return;
    const cost = performance.now() - controller.renderStartedAt;
    controller.renderStartedAt = null;
    controller.renderPending = false;
    controller.costMs += (cost - controller.costMs) * STREAM_REVEAL.costSmoothing;
  }, [state, controller]);

  useLayoutEffect(() => () => cancelScheduled(controller), [controller]);

  // 流刚结束的这次渲染就要判定是否收尾：先按终版渲染、到 layout effect 里再切回
  // 流式，会在同一任务里把整篇 DOM 来回替换两次（黑盒 fast/turbo 测到 ~230ms 长任务）。
  const endingWithBacklog =
    !streaming &&
    wasStreamingRef.current &&
    pace &&
    !isDocumentHidden() &&
    typeof requestAnimationFrame === 'function' &&
    (controller.buffer.pending || content !== state.text);
  const live = streaming || state.draining || endingWithBacklog;
  if (!live) return { text: content, draining: false };
  // 原文被改写成不再以已发布前缀开头时，不渲染过期前缀（下一帧会整段同步）。
  return {
    text: content.startsWith(state.text) ? state.text : content,
    draining: !streaming && (state.draining || endingWithBacklog),
  };
}
