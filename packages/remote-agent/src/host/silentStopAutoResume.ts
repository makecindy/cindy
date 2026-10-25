/**
 * SilentStopAutoResumeGuard —— silent-stop(上游用空内容 assistant 消息静默收尾
 * "干到一半"的 turn,见 maker-core translator 的 silentStop 标记)的自动续跑决策器。
 *
 * 决策语义(与 lizi 定稿一致):
 *  - 每条**真实用户消息**(renderer 发送 / 耗尽提示上点「继续」)给该 session 充值
 *    RESUME_BUDGET 次自动续跑额度;自动补发的「继续」**不充值** —— 这是防死循环的
 *    硬保证:上游连环出 bug 时,每条人话最多买 RESUME_BUDGET 个自动 turn,连续第
 *    RESUME_BUDGET+1 次中断转为 exhausted(UI 显式提示,停下等人)。
 *  - 会话累计自动续跑 >= SESSION_BREAKER_LIMIT 次 → 本会话内熔断(app 重启前不再
 *    自动续跑),防上游高频抽风期的成本泄漏。
 *  - 同一次 turn 结束只决策一次:发出 resume 后置 pendingResume,直到下一个 turn
 *    真正开始才清 —— 重复投递的 done 事件不会连发两条「继续」。另有 MIN_INTERVAL
 *    短窗兜底极端时序(正常模型 turn 远长于该窗口,不会挡住合法的连续续跑)。
 *  - 陈旧保护:done 之后用户已自己发过消息、或新 turn 已开始 → 放弃本次续跑,
 *    绝不插队。
 *
 * 纯内存状态(app 重启即复位),无 IO;kill switch 由调用方注入(见
 * maker-host/silent-stop-auto-resume-store.ts)。全部依赖可注入,便于单测(规则 14)。
 */

/** 每条真实用户消息背书的自动续跑额度(连续第 3 次中断等人)。 */
export const SILENT_STOP_RESUME_BUDGET = 2;
/** 会话级熔断:累计自动续跑次数上限。 */
export const SILENT_STOP_SESSION_BREAKER_LIMIT = 6;
/** 两次自动续跑的最小间隔(防事件重复/极端时序连发;正常 turn 时长远大于它)。 */
export const SILENT_STOP_RESUME_MIN_INTERVAL_MS = 5_000;
/** 自动补发的续跑消息正文(固定常量;作为普通 user 消息 append,不扰动缓存前缀)。 */
export const SILENT_STOP_RESUME_PROMPT = '继续';

export type SilentStopDecision =
  | { action: 'resume' }
  | { action: 'exhausted' }
  | { action: 'skip'; why: 'disabled' | 'superseded' | 'pending' };

interface GuardLogger {
  debug: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

interface SessionGuardState {
  budgetLeft: number;
  resumeCount: number;
  lastResumeAt: number;
  lastTurnStartAt: number;
  lastUserSendAt: number;
  pendingResume: boolean;
  breakerWarned: boolean;
}

export interface SilentStopAutoResumeGuardDeps {
  /** kill switch(maker-host silent-stop-auto-resume-store,默认开启)。 */
  isEnabled: () => boolean;
  log: GuardLogger;
  /** 可注入时钟,单测用;默认 Date.now。 */
  now?: () => number;
}

export class SilentStopAutoResumeGuard {
  private readonly sessions = new Map<string, SessionGuardState>();

  constructor(private readonly deps: SilentStopAutoResumeGuardDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private state(sessionId: string): SessionGuardState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        budgetLeft: 0,
        resumeCount: 0,
        lastResumeAt: 0,
        lastTurnStartAt: 0,
        lastUserSendAt: 0,
        pendingResume: false,
        breakerWarned: false,
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  /**
   * 真实用户消息发出(renderer send 事务 accepted / 耗尽提示点「继续」)。
   * 充满额度并解除"耗尽"状态;自动补发的消息绝不能调用本方法。
   */
  noteUserSend(sessionId: string): void {
    const s = this.state(sessionId);
    s.budgetLeft = SILENT_STOP_RESUME_BUDGET;
    s.lastUserSendAt = this.now();
  }

  /** 新 turn 开始(status isRunning=true)。清 pendingResume,记录时间做陈旧判定。 */
  noteTurnStarted(sessionId: string): void {
    const s = this.state(sessionId);
    s.lastTurnStartAt = this.now();
    s.pendingResume = false;
  }

  /** 自动补发失败(session.send 抛错)时清 pending,避免卡死后续决策。额度不退(安全方向)。 */
  noteResumeSendFailed(sessionId: string): void {
    this.state(sessionId).pendingResume = false;
  }

  /**
   * 会话被重置(/clear)或中止(abort)时调用。清 pendingResume 并记录时刻,
   * 使 1.5s 窗口内已排期的自动续跑判为 superseded,避免往清空的会话里注入消息。
   */
  noteSessionReset(sessionId: string): void {
    const s = this.state(sessionId);
    s.pendingResume = false;
    s.lastUserSendAt = this.now();
  }

  /**
   * 对一次 silent-stop turn 结束做决策。`doneAt` 是该 done 事件的观察时刻,用于
   * 陈旧判定(其后用户已发消息 / 新 turn 已开始 → superseded)。
   * 返回 resume 时已内部扣减额度并置 pendingResume,调用方负责实际补发。
   */
  onSilentStop(sessionId: string, doneAt: number): SilentStopDecision {
    const s = this.state(sessionId);
    const now = this.now();
    if (!this.deps.isEnabled()) {
      this.deps.log.debug('silent-stop auto-resume disabled by kill switch', { sessionId });
      return { action: 'skip', why: 'disabled' };
    }
    if (s.pendingResume) {
      // 已为上一次决策补发过、其 turn 还没开始 —— 重复投递的 done,忽略。
      this.deps.log.debug('silent-stop duplicate done while resume pending', { sessionId });
      return { action: 'skip', why: 'pending' };
    }
    if (s.lastUserSendAt > doneAt || s.lastTurnStartAt > doneAt) {
      // done 之后用户已介入 / 新 turn 已开始,自动续跑作废,绝不插队。
      this.deps.log.debug('silent-stop resume superseded by newer activity', {
        sessionId,
        doneAt,
        lastUserSendAt: s.lastUserSendAt,
        lastTurnStartAt: s.lastTurnStartAt,
      });
      return { action: 'skip', why: 'superseded' };
    }
    if (s.resumeCount >= SILENT_STOP_SESSION_BREAKER_LIMIT) {
      if (!s.breakerWarned) {
        s.breakerWarned = true;
        this.deps.log.warn('silent-stop session breaker tripped — auto-resume disabled for this session', {
          sessionId,
          resumeCount: s.resumeCount,
        });
      }
      return { action: 'exhausted' };
    }
    if (s.lastResumeAt > 0 && now - s.lastResumeAt < SILENT_STOP_RESUME_MIN_INTERVAL_MS) {
      this.deps.log.warn('silent-stop resume burst-guarded (too soon after previous resume)', {
        sessionId,
        sinceLastResumeMs: now - s.lastResumeAt,
      });
      return { action: 'exhausted' };
    }
    if (s.budgetLeft <= 0) {
      this.deps.log.debug('silent-stop resume budget exhausted — waiting for user', {
        sessionId,
        resumeCount: s.resumeCount,
      });
      return { action: 'exhausted' };
    }
    s.budgetLeft -= 1;
    s.resumeCount += 1;
    s.lastResumeAt = now;
    s.pendingResume = true;
    this.deps.log.debug('silent-stop auto-resume granted', {
      sessionId,
      budgetLeft: s.budgetLeft,
      resumeCount: s.resumeCount,
    });
    return { action: 'resume' };
  }
}
