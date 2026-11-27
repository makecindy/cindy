import { describe, expect, it, vi } from 'vitest';

import {
  SILENT_STOP_RESUME_BUDGET,
  SILENT_STOP_RESUME_MIN_INTERVAL_MS,
  SILENT_STOP_SESSION_BREAKER_LIMIT,
  SilentStopAutoResumeGuard,
} from '../silentStopAutoResume.js';

// 守卫状态机单测:核心不变量是"自动消息不充值额度"——每条真实用户消息最多买
// SILENT_STOP_RESUME_BUDGET 个自动 turn,死循环在机制上不可能。

function createGuard(opts?: { enabled?: boolean }) {
  let nowMs = 1_000_000;
  const guard = new SilentStopAutoResumeGuard({
    isEnabled: () => opts?.enabled ?? true,
    log: { debug: vi.fn(), warn: vi.fn() },
    now: () => nowMs,
  });
  const tick = (ms: number) => {
    nowMs += ms;
  };
  const now = () => nowMs;
  return { guard, tick, now };
}

const SID = 'session-1';
/** 一个完整的"turn 开始 → silent-stop 结束"周期,返回 done 时刻。 */
function runSilentStopTurn(g: ReturnType<typeof createGuard>): number {
  g.guard.noteTurnStarted(SID);
  g.tick(60_000); // 正常 turn 时长,远大于 burst 窗口
  return g.now();
}

describe('SilentStopAutoResumeGuard', () => {
  it('grants at most BUDGET resumes per real user send, then exhausts (连续第 3 次中断等人)', () => {
    const g = createGuard();
    g.guard.noteUserSend(SID);

    // 第 1、2 次 silent stop → 自动续跑。
    for (let i = 0; i < SILENT_STOP_RESUME_BUDGET; i++) {
      const doneAt = runSilentStopTurn(g);
      expect(g.guard.onSilentStop(SID, doneAt)).toEqual({ action: 'resume' });
    }
    // 第 3 次 → 耗尽等人。
    const doneAt = runSilentStopTurn(g);
    expect(g.guard.onSilentStop(SID, doneAt)).toEqual({ action: 'exhausted', cause: 'budget' });
  });

  it('auto-resume does NOT recharge the budget (the anti-loop hard guarantee)', () => {
    const g = createGuard();
    g.guard.noteUserSend(SID);
    // 耗光额度的过程中从不调用 noteUserSend —— 额度只减不增。
    let doneAt = runSilentStopTurn(g);
    expect(g.guard.onSilentStop(SID, doneAt).action).toBe('resume');
    doneAt = runSilentStopTurn(g);
    expect(g.guard.onSilentStop(SID, doneAt).action).toBe('resume');
    // 之后无论多少次 silent stop 都只会 exhausted,不再 resume。
    for (let i = 0; i < 5; i++) {
      doneAt = runSilentStopTurn(g);
      expect(g.guard.onSilentStop(SID, doneAt).action).toBe('exhausted');
    }
  });

  it('a new real user send recharges the budget', () => {
    const g = createGuard();
    g.guard.noteUserSend(SID);
    let doneAt = runSilentStopTurn(g);
    expect(g.guard.onSilentStop(SID, doneAt).action).toBe('resume');
    doneAt = runSilentStopTurn(g);
    expect(g.guard.onSilentStop(SID, doneAt).action).toBe('resume');
    doneAt = runSilentStopTurn(g);
    expect(g.guard.onSilentStop(SID, doneAt).action).toBe('exhausted');

    g.guard.noteUserSend(SID); // 用户点「继续」/ 发新消息
    doneAt = runSilentStopTurn(g);
    expect(g.guard.onSilentStop(SID, doneAt).action).toBe('resume');
  });

  it('session breaker trips after SESSION_BREAKER_LIMIT total resumes', () => {
    const g = createGuard();
    let resumes = 0;
    while (resumes < SILENT_STOP_SESSION_BREAKER_LIMIT) {
      g.guard.noteUserSend(SID);
      for (let i = 0; i < SILENT_STOP_RESUME_BUDGET && resumes < SILENT_STOP_SESSION_BREAKER_LIMIT; i++) {
        const doneAt = runSilentStopTurn(g);
        expect(g.guard.onSilentStop(SID, doneAt).action).toBe('resume');
        resumes += 1;
      }
    }
    // 熔断后即使额度充满也返回 exhausted(surface UI),不再自动续跑。
    g.guard.noteUserSend(SID);
    const doneAt = runSilentStopTurn(g);
    expect(g.guard.onSilentStop(SID, doneAt)).toEqual({ action: 'exhausted', cause: 'session-breaker' });
  });

  it('kill switch short-circuits everything', () => {
    const g = createGuard({ enabled: false });
    g.guard.noteUserSend(SID);
    const doneAt = runSilentStopTurn(g);
    expect(g.guard.onSilentStop(SID, doneAt)).toEqual({ action: 'skip', why: 'disabled' });
  });

  it('duplicate done while a resume is pending is ignored (no double 「继续」)', () => {
    const g = createGuard();
    g.guard.noteUserSend(SID);
    const doneAt = runSilentStopTurn(g);
    expect(g.guard.onSilentStop(SID, doneAt).action).toBe('resume');
    // 补发的 turn 还没开始,重复投递同一个 done:
    expect(g.guard.onSilentStop(SID, doneAt)).toEqual({ action: 'skip', why: 'pending' });
    // 新 turn 开始后 pending 解除,后续 silent stop 正常决策。
    const doneAt2 = runSilentStopTurn(g);
    expect(g.guard.onSilentStop(SID, doneAt2).action).toBe('resume');
  });

  it('resume send failure clears pending without refunding budget', () => {
    const g = createGuard();
    g.guard.noteUserSend(SID);
    const doneAt = runSilentStopTurn(g);
    expect(g.guard.onSilentStop(SID, doneAt).action).toBe('resume');
    g.guard.noteResumeSendFailed(SID);
    // pending 已清,可继续决策;额度不退(2-1=1 → 还能续 1 次)。
    const doneAt2 = runSilentStopTurn(g);
    expect(g.guard.onSilentStop(SID, doneAt2).action).toBe('resume');
    const doneAt3 = runSilentStopTurn(g);
    expect(g.guard.onSilentStop(SID, doneAt3).action).toBe('exhausted');
  });

  it('is superseded when the user already sent after the done (never cut in line)', () => {
    const g = createGuard();
    g.guard.noteUserSend(SID);
    const doneAt = runSilentStopTurn(g);
    g.tick(1_000);
    g.guard.noteUserSend(SID); // 用户抢先自己发了
    expect(g.guard.onSilentStop(SID, doneAt)).toEqual({ action: 'skip', why: 'superseded' });
  });

  it('is superseded when a newer turn already started after the done', () => {
    const g = createGuard();
    g.guard.noteUserSend(SID);
    const doneAt = runSilentStopTurn(g);
    g.tick(1_000);
    g.guard.noteTurnStarted(SID); // 新 turn 已接管
    expect(g.guard.onSilentStop(SID, doneAt)).toEqual({ action: 'skip', why: 'superseded' });
  });

  it('burst-guards resumes that come impossibly fast after the previous one', () => {
    const g = createGuard();
    g.guard.noteUserSend(SID);
    let doneAt = runSilentStopTurn(g);
    expect(g.guard.onSilentStop(SID, doneAt).action).toBe('resume');
    // turn 异常地在 burst 窗口内结束(极端时序/重放),不连发。
    g.guard.noteTurnStarted(SID);
    g.tick(SILENT_STOP_RESUME_MIN_INTERVAL_MS - 1);
    doneAt = g.now();
    expect(g.guard.onSilentStop(SID, doneAt)).toEqual({ action: 'exhausted', cause: 'rate-limit' });
  });

  it('tracks sessions independently', () => {
    const g = createGuard();
    g.guard.noteUserSend('a');
    g.guard.noteTurnStarted('a');
    g.tick(60_000);
    expect(g.guard.onSilentStop('a', g.now()).action).toBe('resume');
    // session b 从未有用户消息 → 无额度。
    g.guard.noteTurnStarted('b');
    g.tick(60_000);
    expect(g.guard.onSilentStop('b', g.now()).action).toBe('exhausted');
  });

  it('noteSessionReset cancels a pending resume (/clear during 1.5s window)', () => {
    const g = createGuard();
    g.guard.noteUserSend(SID);
    const doneAt = runSilentStopTurn(g);
    expect(g.guard.onSilentStop(SID, doneAt).action).toBe('resume');
    // 1.5s 窗口内用户 /clear → noteSessionReset
    g.tick(500);
    g.guard.noteSessionReset(SID);
    // 再来一个 done(stale 重播)→ superseded,不会注入清空的会话。
    expect(g.guard.onSilentStop(SID, doneAt)).toEqual({ action: 'skip', why: 'superseded' });
  });

  // #12759: 熔断后会话仍在正常工作(迟到汇报触发的空响应续跑把计数打满,
  // 真人/自动任务的正常轮次此后一直弹横幅)。正常完成可见回复时清零，
  // 具体判定由生产事件管线测试覆盖；这里验证守卫的重置语义。
  it('noteProgress resets the session breaker after a productive turn', () => {
    const g = createGuard();
    g.guard.noteUserSend(SID);
    // 打满 session breaker。
    while (true) {
      const doneAt = runSilentStopTurn(g);
      const decision = g.guard.onSilentStop(SID, doneAt);
      if (decision.action === 'exhausted') {
        expect(decision).toEqual({ action: 'exhausted', cause: 'session-breaker' });
        break;
      }
      if (decision.action === 'resume') g.guard.noteUserSend(SID);
    }
    // 后续任意一轮有产出 → 熔断解除,下一轮 silent-stop 可以续跑。
    g.guard.noteUserSend(SID);
    g.guard.noteTurnStarted(SID);
    g.guard.noteProgress(SID);
    const doneAt = runSilentStopTurn(g);
    expect(g.guard.onSilentStop(SID, doneAt).action).toBe('resume');
  });

  it('a completed reply does not recharge the per-input budget', () => {
    const g = createGuard();
    g.guard.noteUserSend(SID);
    for (let i = 0; i < SILENT_STOP_RESUME_BUDGET; i++) {
      expect(g.guard.onSilentStop(SID, runSilentStopTurn(g)).action).toBe('resume');
    }
    g.guard.noteProgress(SID);
    expect(g.guard.onSilentStop(SID, runSilentStopTurn(g))).toEqual({ action: 'exhausted', cause: 'budget' });
  });

  it('noteProgress also re-arms the banner (breakerWarned cleared)', () => {
    const g = createGuard();
    g.guard.noteUserSend(SID);
    while (true) {
      const doneAt = runSilentStopTurn(g);
      if (g.guard.onSilentStop(SID, doneAt).action === 'exhausted') break;
      g.guard.noteUserSend(SID);
    }
    // breakerWarned 已置位;产出后再 tripped 时应重新 warn。
    g.guard.noteTurnStarted(SID);
    g.guard.noteProgress(SID);
    g.guard.noteUserSend(SID);
    while (true) {
      const doneAt = runSilentStopTurn(g);
      if (g.guard.onSilentStop(SID, doneAt).action === 'exhausted') break;
      g.guard.noteUserSend(SID);
    }
    // warn 应在两轮 tripped 各调用一次(而不是只在第一轮 warn)。
    const warns = (g.guard as unknown as { deps: { log: { warn: ReturnType<typeof vi.fn> } } }).deps.log.warn;
    expect(warns).toHaveBeenCalledTimes(2);
  });
});
