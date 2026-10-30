/**
 * session 双时间戳「疑似中断」横幅的决策模型(桌面端 session 分支,#4513)。
 * ---------------------------------------------------------------------------
 * 数据源是 session 行的 activeTurnStartedAt / lastTurnEndedAt / clearedAt
 * (见 main 侧 localDb/sessionActiveTurn.ts 文件头):`started > max(ended, cleared)`
 * 对**任何在飞 turn** 都天然成立 —— 「正在跑」与「跑了一半退出」在时间戳上不可区分,
 * 必须靠运行态信号反驳。
 *
 * 既有反驳信号:agentStatus.isRunning(一次性 ack latch)与 remoteTurnActive
 * (device-link 活动镜像)。两者都由 status(isRunning) 事件驱动,而消息流与状态流
 * 是两条独立通道:协同 worker 会话实测出现过「消息持续输出、status 事件未生效」,
 * 双时间戳候选便在整轮期间误渲染「任务执行到一半时应用退出,已被中断」。
 *
 * 修复原则:**未确认 ≠ 已确认空闲**。新增 main 真值回填(main 侧
 * SessionTurnActivityTracker + live isTurnRunning,进程内存态重启后自然清空,
 * 不会把真中断误报成在飞):mainTurnActive 为 null(查询在途/失败/不适用)时
 * 不把候选当中断证据,只有 main 明确回答「不在 turn 中」才允许渲染横幅。
 * 真中断场景不受影响:重启后 main 无在飞 turn,回填返回 false,横幅照常出现。
 */

/** main 真值:null = 未确认(查询在途 / 失败 / 不适用),不是 false。 */
export type SessionInterruptTruth = boolean | null;

export interface SessionInterruptDecisionInput {
  /** 一次性 ack latch:本窗口观察到运行态,或用户已操作(继续/忽略)后永久熄灭。 */
  acked: boolean;
  /** device-link 远程活动镜像:turn 执行 / 等待交互时压过时间戳启发式。 */
  remoteTurnActive: boolean;
  /** main 侧权威运行态回填(maker:session:turn-active)。 */
  mainTurnActive: SessionInterruptTruth;
  activeTurnStartedAt: number | null;
  lastTurnEndedAt: number | null;
  /** session.clearedAt 的 epoch ms;/clear 之前的中断不算数。 */
  clearedAtMs: number | null;
}

export function resolveSessionInterruptCandidate(
  input: SessionInterruptDecisionInput,
): boolean {
  if (input.acked || input.remoteTurnActive) return false;
  // 未确认(null)不当中断证据:横幅只在 main 明确回答「不在 turn 中」后允许渲染。
  if (input.mainTurnActive !== false) return false;
  const started = input.activeTurnStartedAt;
  if (!started) return false;
  const ended = input.lastTurnEndedAt ?? 0;
  const cleared = input.clearedAtMs ?? 0;
  return started > ended && started > cleared;
}
