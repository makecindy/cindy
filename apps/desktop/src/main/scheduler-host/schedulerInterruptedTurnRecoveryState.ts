import type {
  InterruptedTurnAutoResumeScope,
  InterruptedTurnResumeDecision,
} from '../maker-ipc/interruptedTurnAutoResume.js';

/**
 * Schedule interrupted-turn recovery 的唯一状态 owner。
 *
 * 外层 runner 负责 IO；本对象只定义一次恢复 attempt 从退避到 vendor dispatch 的状态
 * 转换，并持有能够同步撤销该 attempt 的 AbortSignal。这样 timer、terminal event、
 * Session.send 回调和用户/会话取消只共同依赖 phase + generation，不再各自维护布尔判据。
 */
export class SchedulerInterruptedTurnRecoveryState {
  private phase: 'idle' | 'backoff' | 'dispatching' | 'running' | 'settled' = 'idle';
  private generation = 0;
  private recoveryChainEstablished = false;
  private currentTurnHasProgress = false;
  private attemptAbortController: AbortController | null = null;

  constructor(private readonly resumeScope: InterruptedTurnAutoResumeScope) {}

  get isPending(): boolean {
    return this.phase === 'backoff' || this.phase === 'dispatching';
  }

  get hasActiveRecovery(): boolean {
    return this.phase === 'backoff' || this.phase === 'dispatching' || this.phase === 'running';
  }

  /** 初始 turn 的 running 信号只负责开启一轮新的进展窗口。 */
  noteRunningStatus(): boolean {
    if (this.phase !== 'idle') return false;
    this.currentTurnHasProgress = false;
    this.resumeScope.noteTurnStarted();
    return true;
  }

  noteProgress(): void {
    if (this.phase === 'settled') return;
    this.currentTurnHasProgress = true;
    this.resumeScope.noteProgress();
  }

  onInterruptedTurn(erroredAt: number): InterruptedTurnResumeDecision {
    return this.resumeScope.onInterruptedTurn(erroredAt);
  }

  noteResumeSendFailed(): void {
    this.resumeScope.noteResumeSendFailed();
  }

  /**
   * terminal event 的恢复资格。backoff/dispatching 时只能是旧 turn 的重复终态；真正的
   * 新 vendor turn 会先同步经过 onDispatching，把 phase 切到 running。
   */
  classifyTerminal(): 'duplicate' | 'eligible' | 'ineligible' {
    if (this.phase === 'backoff' || this.phase === 'dispatching') return 'duplicate';
    if (this.phase === 'settled') return 'ineligible';
    if (!this.currentTurnHasProgress && !this.recoveryChainEstablished) return 'ineligible';
    return 'eligible';
  }

  scheduleRecovery(): number {
    this.attemptAbortController = null;
    this.phase = 'backoff';
    this.currentTurnHasProgress = false;
    this.generation += 1;
    return this.generation;
  }

  /** timer 赢得当前 generation 后建立本次 attempt 的可撤销派发信号。 */
  beginDispatch(generation: number): AbortSignal | null {
    if (this.phase !== 'backoff' || this.generation !== generation) return null;
    this.phase = 'dispatching';
    this.attemptAbortController = new AbortController();
    return this.attemptAbortController.signal;
  }

  /**
   * Session.send 在调用 vendor handle 前的最后一个同步边界。越过这里才算恢复链建立；
   * 此前到达的重复 error 不能冒充新 attempt 的失败。
   */
  noteVendorDispatching(generation: number): boolean {
    if (this.phase !== 'dispatching' || this.generation !== generation) return false;
    this.phase = 'running';
    this.recoveryChainEstablished = true;
    this.currentTurnHasProgress = false;
    this.resumeScope.noteTurnStarted();
    return true;
  }

  isCurrentAttempt(generation: number): boolean {
    return (
      this.generation === generation
      && (this.phase === 'dispatching' || this.phase === 'running')
    );
  }

  /**
   * 新用户消息只撤销尚未越过 vendor 边界的隐藏补发；已 running 的 turn 保持普通队列
   * 语义自然结束，但 bridge owner 会由调用方撤掉，之后不得再排另一条隐藏“继续”。
   */
  userInterventionDisposition(): 'cancel-pending' | 'detach' {
    return this.isPending ? 'cancel-pending' : 'detach';
  }

  /** Stop/clear/close/Fire abort：同步让 signal 失效，覆盖 pre-vendor 与 vendor-await。 */
  cancel(): boolean {
    const hadActiveRecovery = this.hasActiveRecovery;
    this.generation += 1;
    this.attemptAbortController?.abort();
    this.attemptAbortController = null;
    this.phase = 'settled';
    this.recoveryChainEstablished = false;
    this.currentTurnHasProgress = false;
    this.resumeScope.noteSessionReset();
    this.resumeScope.dispose();
    return hadActiveRecovery;
  }

  settle(): void {
    if (this.phase === 'settled') {
      this.resumeScope.dispose();
      return;
    }
    this.generation += 1;
    this.attemptAbortController = null;
    this.phase = 'settled';
    this.recoveryChainEstablished = false;
    this.currentTurnHasProgress = false;
    this.resumeScope.dispose();
  }
}
