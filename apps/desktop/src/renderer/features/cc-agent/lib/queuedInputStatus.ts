/**
 * queuedInputStatus —— 会话「还在等队列里的消息」这一条判定。
 * ---------------------------------------------------------------------------
 * 队列里的消息在真正派发出去之前只存在于主进程内存态(设计见 #761),气泡上标
 * 「排队中」。会话级状态(侧栏行、底部状态栏)必须用同一份事实：排队中的会话
 * 不是空闲，否则「气泡说排队、会话说空闲」两边矛盾，用户只能猜这条消息还会不会
 * 被执行(#11299)。
 *
 * 三条输入各自的含义：
 * - `queuedCount` 队列里还没派发的条数。
 * - `queuePaused` 用户按过 Stop、队列被暂停 —— 那是有意搁置，不是「还在等」。
 *   状态可以解释，不需要额外的等待提示。
 */

/** 队列中是否有输入，且队列和任务执行均未暂停。 */
export function hasUnpausedQueuedInput(input: {
  queuedCount: number;
  queuePaused: boolean;
  queueInteractionLocks?: readonly string[];
}): boolean {
  return input.queuedCount > 0
    && !input.queuePaused
    && !input.queueInteractionLocks?.includes('execution-pause');
}

/**
 * 底部状态栏是否常驻。
 *
 * 除了「在跑 / 在准备 / 后台任务 / workflow」，还有一种：队列里还有没派发的
 * 消息。会话在等，状态栏要说明在等什么，不能按空闲收起(#11299)。
 * 计划审阅有自己的接管界面，这时状态栏整体让位。
 */
type ComposerRuntimeInput = {
  pendingPlanReview: boolean;
  isRunning: boolean;
  waitingRemoteStart: boolean;
  backgroundTasksActive: boolean;
  hasRunningWorkflow: boolean;
  hasQueuedInput: boolean;
};

export function resolveComposerRuntimeStatus(input: ComposerRuntimeInput) {
  const runtimeActive = input.isRunning
    || input.waitingRemoteStart
    || input.backgroundTasksActive
    || input.hasRunningWorkflow;
  const queuedWaiting = !runtimeActive && !input.pendingPlanReview && input.hasQueuedInput;
  return {
    queuedWaiting,
    visible: !input.pendingPlanReview && (runtimeActive || queuedWaiting),
  };
}
