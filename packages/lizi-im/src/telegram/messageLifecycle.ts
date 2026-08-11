/**
 * telegram/messageLifecycle.ts
 * ---------------------------------------------------------------------------
 * 纯 Telegram 消息生命周期内核。
 *
 * 这里不做 Telegram API I/O，也不持有 bot 身份。个人 Bot API 和官方
 * legacy/msg.op adapter 只消费这份状态边界：过程帧在终稿栅栏后失效，终稿
 * 使用稳定 delivery key，重复终态不会再铸造第二条答案。
 *
 * `final` 的“已送达”语义由 adapter 定义：个人 adapter 在 Bot API send 成功
 * 后标记；官方 legacy adapter 在终态帧交给其可靠发布边界后标记。它不是对
 * Telegram 用户已经看到消息的虚假保证。
 */

export type TelegramMessageLifecyclePhase =
  | 'created'
  | 'running'
  | 'final-pending'
  | 'final-failed'
  | 'final-sent'
  | 'cleanup-pending'
  | 'complete'
  | 'cancelled';

export interface TelegramFinalIntent {
  /** 同一轮同一终稿的重试必须保持不变。 */
  readonly deliveryKey: string;
  /** 生命周期内单调递增的终稿序号。 */
  readonly sequence: number;
  /** 当前是第几次尝试；不参与 delivery key。 */
  readonly attempt: number;
}

export interface TelegramMessageLifecycle {
  readonly roundId: string;
  readonly phase: TelegramMessageLifecyclePhase;
  /** 过程载体仍可接受更新吗？终稿栅栏一打开就永久为 false。 */
  readonly progressOpen: boolean;
  /** 接受一帧过程事件；迟到帧返回 false。 */
  acceptProgress(): boolean;
  /** 打开终稿栅栏并取得稳定终稿意图；同一在途终稿重复调用返回同一尝试。 */
  beginFinal(): TelegramFinalIntent | null;
  /** 终稿已交给 adapter 的可靠边界。 */
  markFinalSent(intent: TelegramFinalIntent): boolean;
  /** 终稿尝试失败；允许同一 key 后续重试，但不重新打开过程帧。 */
  markFinalFailed(intent: TelegramFinalIntent): boolean;
  /** 终稿确认后开始清理过程载体。 */
  beginCleanup(): boolean;
  /** 清理完成；删除失败也可由 adapter 选择直接完成。 */
  finishCleanup(): boolean;
  /** 取消尚未送达的终稿；已送达答案不会被取消抹掉。 */
  cancel(): boolean;
}

let nextRoundNumber = 0;

function defaultRoundId(): string {
  nextRoundNumber += 1;
  return `telegram-round-${nextRoundNumber}`;
}

/** 创建一个不做 I/O 的 Telegram 消息生命周期。 */
export function createTelegramMessageLifecycle(roundId = defaultRoundId()): TelegramMessageLifecycle {
  let currentPhase: TelegramMessageLifecyclePhase = 'created';
  let progressOpen = true;
  let sequence = 0;
  let finalIntent: TelegramFinalIntent | null = null;

  const sameIntent = (intent: TelegramFinalIntent): boolean =>
    finalIntent !== null && intent.deliveryKey === finalIntent.deliveryKey;

  return {
    roundId,
    get phase() {
      return currentPhase;
    },
    get progressOpen() {
      return progressOpen;
    },
    acceptProgress(): boolean {
      if (!progressOpen || currentPhase === 'cancelled' || currentPhase === 'complete') {
        return false;
      }
      if (currentPhase === 'created') currentPhase = 'running';
      return true;
    },
    beginFinal(): TelegramFinalIntent | null {
      if (
        currentPhase === 'cancelled' ||
        currentPhase === 'complete' ||
        currentPhase === 'cleanup-pending' ||
        currentPhase === 'final-sent'
      ) {
        return null;
      }
      progressOpen = false;
      if (finalIntent === null) {
        sequence += 1;
        finalIntent = {
          deliveryKey: `${roundId}:final`,
          sequence,
          attempt: 1,
        };
        currentPhase = 'final-pending';
        return finalIntent;
      }
      // A duplicate terminal event while the adapter is still sending must not
      // mint a second attempt. The adapter can use the same intent as its
      // idempotency anchor.
      if (currentPhase === 'final-pending') return finalIntent;
      // A failed final attempt may be retried with the same delivery key. Keep
      // the token immutable and only advance the diagnostic attempt counter.
      if (currentPhase === 'final-failed') {
        finalIntent = { ...finalIntent, attempt: finalIntent.attempt + 1 };
        currentPhase = 'final-pending';
        return finalIntent;
      }
      return null;
    },
    markFinalSent(intent: TelegramFinalIntent): boolean {
      if (
        !sameIntent(intent) ||
        finalIntent?.attempt !== intent.attempt ||
        currentPhase !== 'final-pending'
      ) {
        return false;
      }
      currentPhase = 'final-sent';
      return true;
    },
    markFinalFailed(intent: TelegramFinalIntent): boolean {
      if (
        !sameIntent(intent) ||
        finalIntent?.attempt !== intent.attempt ||
        currentPhase !== 'final-pending'
      ) {
        return false;
      }
      currentPhase = 'final-failed';
      return true;
    },
    beginCleanup(): boolean {
      if (currentPhase !== 'final-sent') return false;
      currentPhase = 'cleanup-pending';
      return true;
    },
    finishCleanup(): boolean {
      // Cleanup is deliberately idempotent. A delete failure can still call
      // this method so the answer remains the authoritative visible result.
      if (currentPhase === 'complete') return true;
      if (currentPhase !== 'cleanup-pending') return false;
      currentPhase = 'complete';
      return true;
    },
    cancel(): boolean {
      if (currentPhase === 'final-sent' || currentPhase === 'complete') return false;
      progressOpen = false;
      currentPhase = 'cancelled';
      return true;
    },
  };
}
