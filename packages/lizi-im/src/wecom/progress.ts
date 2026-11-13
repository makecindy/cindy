/**
 * 企业微信一轮任务的真正流式过程反馈。
 * ---------------------------------------------------------------------------
 * 企业微信智能机器人长连接支持**原地刷新的流式消息**: 收到消息后先用同一个
 * `stream.id` 回一帧(可以只有占位), 之后用同一个 id 不断刷新内容, 最后一帧
 * `finish=true` 收敛成终稿。旧实现只在开始时空占位、结束时才写内容 —— 中间
 * 整轮沉默。这里把中间过程真的写进同一条流式消息:
 *
 *  - 只发**公开进度**: 阶段摘要 + 已产出的正文; 思考内容/工具名/工具参数不进来;
 *  - 节流:`PROGRESS_INTERVAL_MS` 之内最多刷一帧(尾沿取最新内容, 节流按**尝试**
 *    计, 失败也占窗口), 并用 SDK 的非阻塞发送(上一帧未 ack 时跳过, 避免中间帧
 *    排队堆积);
 *  - 终稿优先:`close()` 先关闸再**串行等**已发出的帧落地(底层自带超时, 不靠
 *    轮询), 返回之后不可能再有进度帧晚到; 终稿由 `commitFinal` 收口。
 *
 * 失败不抛给调用方: 过程面是可选增强, 它坏掉不能影响终稿交付。
 */
import type { ImProgressHandle, ImProgressView } from '../channelIM.js';
import { DELIVERY_FAILURE } from '../safeLog.js';
import { tt } from '../transportText.js';

/** 过程帧最小间隔。企业微信没有公开的流式频率上限, 与飞书/Telegram 卡片的节流同量级。 */
export const WECOM_PROGRESS_INTERVAL_MS = 1_500;
/** 平台在 10 分钟后拒绝更新; 提前收起旧流, 后续以一分钟一条的状态继续。 */
export const WECOM_STREAM_PROGRESS_WINDOW_MS = 9 * 60_000 + 30_000;
export const WECOM_STATUS_INTERVAL_MS = 60_000;
/** 流式消息 content 上限 20480 字节, 留出换行与截断省略号的余量。 */
export const WECOM_STREAM_MAX_BYTES = 20_000;

export interface WecomProgressDeps {
  userId: string;
  turnId?: string;
  streamId: string;
  streamStartedAt?: number;
  finishStream?: (streamId: string, content: string) => Promise<unknown>;
  /** 主动状态消息只包含公开阶段, 不重复发送未完成的正文。 */
  sendStatus?: (content: string) => Promise<unknown>;
  now?: () => number;
  /** 连接/账号代次仍属于本轮时返回 true。 */
  shouldContinue?: () => boolean;
  /**
   * 用同一个 streamId 刷新流式消息内容。实现必须是非阻塞版本(SDK 在上一帧
   * 未 ack 时跳过), 失败由这里统一记脱敏日志。
   */
  replyStream: (streamId: string, content: string) => Promise<unknown>;
  log?: { warn(message: string): void };
}

export function composeWecomProgressContent(view: ImProgressView): string {
  const stage = view.stage.trim();
  const body = view.body.trim();
  const content = [stage, body].filter(Boolean).join('\n\n');
  return truncateUtf8(content, WECOM_STREAM_MAX_BYTES);
}

export function createWecomProgress(deps: WecomProgressDeps): ImProgressHandle {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? { warn: () => {} };
  const streamStartedAt = deps.streamStartedAt ?? now();
  let statusMode = false;
  let lastStatusAttemptAt: number | null = null;
  let closed = false;
  /**
   * 本轮已经失效(连接/账号代次不再属于本轮)。失效后**立即闭闸**:
   * 不再排帧、不再重试 —— 旧实现在失效时直接从 flush 返回却不记账, 尾沿调度会
   * 每轮重新排队同一帧, 形成无上限的微任务自旋。
   */
  let dead = false;
  let latest: ImProgressView | null = null;
  let lastAttemptAt: number | null = null;
  /** 最近一次**成功**发出的内容。 */
  let lastContent = '';
  /** 最近一次**失败**的内容: 同一帧失败后不再无限重试, 等新内容或本轮收口。 */
  let failedContent = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<void> | null = null;
  /**
   * 连续"立即重排"的次数。只有在我们持续排帧却一帧都没成功时才会增长; 一旦
   * 超过上限就闭闸 —— 任何 unforeseen 的循环(比如状态来回抖动)都不能变成
   * 无上限的微任务自旋。
   */
  let scheduleBurst = 0;
  const MAX_SCHEDULE_BURST = 8;

  function stopTimer(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /** 本轮是否还能继续推帧; 不能则闭闸(只做一次)。 */
  function alive(): boolean {
    if (closed || dead) return false;
    if (deps.shouldContinue && !deps.shouldContinue()) {
      dead = true;
      stopTimer();
      return false;
    }
    return true;
  }

  const windowExpired = () => Boolean(deps.sendStatus) && now() - streamStartedAt >= WECOM_STREAM_PROGRESS_WINDOW_MS;
  const visibleContent = (view: ImProgressView) => statusMode
    ? truncateUtf8(`${view.stage.trim() || tt('imBot.text.transport.wecom.progressWorking', '任务仍在处理中。')}\n\n${tt('imBot.text.transport.wecom.progressContinuing', '任务仍在继续，完成后会发送结果。可发送 !stop 终止任务。')}`, 2_000)
    : composeWecomProgressContent(view);

  function schedule(): void {
    if (!alive() || timer || inflight) return;
    // 第一帧立即发(用户刚发完消息就该看到反馈); 之后按窗口节流(按尝试计)。
    const useStatus = statusMode || windowExpired();
    const previousAttempt = useStatus ? lastStatusAttemptAt : lastAttemptAt;
    const interval = useStatus ? WECOM_STATUS_INTERVAL_MS : WECOM_PROGRESS_INTERVAL_MS;
    const wait = previousAttempt === null ? 0 : Math.max(0, interval - (now() - previousAttempt));
    if (wait === 0) {
      scheduleBurst += 1;
      if (scheduleBurst > MAX_SCHEDULE_BURST) {
        dead = true;
        stopTimer();
        return;
      }
      start();
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      start();
    }, wait);
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  function start(): void {
    if (!alive()) return;
    const running = flush().finally(() => {
      if (inflight === running) inflight = null;
      if (!alive()) return;
      // 只有出现**新的、既没成功也没失败过**的内容时才排下一帧。
      const content = latest ? visibleContent(latest) : '';
      if (content && content !== lastContent && content !== failedContent) schedule();
    });
    inflight = running;
  }

  async function flush(): Promise<void> {
    if (!alive()) return;
    const view = latest;
    if (!view) return;
    if (!statusMode && windowExpired()) {
      statusMode = true;
      lastContent = '';
      failedContent = '';
      try {
        await deps.finishStream?.(deps.streamId, truncateUtf8(`${composeWecomProgressContent(view)}\n\n${tt('imBot.text.transport.wecom.progressHandoff', '任务仍在继续，后续进度将以新消息发送。')}`, WECOM_STREAM_MAX_BYTES));
      } catch {
        // 窗口可能已经过期; 不再尝试这个 stream, 主动状态仍然继续。
      }
      if (!alive()) return;
    }
    const content = visibleContent(view);
    // 真正有内容才发: 阶段行为空时不要把空占位当成进度帧; 内容相同不重复刷。
    if (!content.trim() || content === lastContent || content === failedContent) return;
    // 节流按尝试计: 失败也占窗口, 密集事件不会变成请求风暴。
    if (statusMode) lastStatusAttemptAt = now();
    else lastAttemptAt = now();
    try {
      if (statusMode) await deps.sendStatus!(content);
      else await deps.replyStream(deps.streamId, content);
      lastContent = content;
      failedContent = '';
      scheduleBurst = 0;
    } catch (error) {
      if (!statusMode && deps.sendStatus && isExpiredStreamError(error)) {
        statusMode = true;
        lastContent = '';
        failedContent = '';
        // SDK 已明确拒绝旧窗口; 后续永不再重试这个 stream。
        await flush();
        return;
      }
      failedContent = content;
      log.warn(`wecom progress ${DELIVERY_FAILURE.progress}: frame failed`);
    }
  }

  return {
    ...(deps.turnId ? { turnId: deps.turnId } : {}),
    replace(view: ImProgressView): void {
      if (!alive()) return;
      if (!view.stage.trim() && !view.body.trim()) return;
      latest = view;
      schedule();
    },
    async close(): Promise<void> {
      closed = true;
      stopTimer();
      // 串行收口: 等已经发出的那一帧落地(它自带底层超时), 之后不可能再有帧晚到。
      await inflight?.catch(() => undefined);
    },
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let result = '';
  for (const char of value) {
    if (Buffer.byteLength(result + char, 'utf8') > maxBytes - 3) break;
    result += char;
  }
  return `${result}…`;
}

function isExpiredStreamError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { errcode?: unknown; code?: unknown; message?: unknown };
  return Number(value.errcode ?? value.code) === 846608
    || (typeof value.message === 'string' && /846608|stream.*(?:expired|cannot update)/i.test(value.message));
}
