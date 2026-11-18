/**
 * 测试价值
 * - 生产入口与可观察结果：withQuietRunArchive（index.desktop.ts 包在 runner 外面）。归档的目标任务被
 *   某一轮自动化恢复后，这一轮被前置检查跳过或静默完成时重新归档；每轮新建任务的自动化，安静的一轮
 *   归档这次新建的任务（2026-11-18）；提醒、失败、顺延、中止与续跑不动。
 * - 规则依据：archive-pauses-automations.md「安静的一轮不唤回已归档任务」（2026-11-17 用户决定）。
 * - 现有覆盖缺口：此前恢复后一律保持激活，每小时跳过的巡检也会把已归档任务翻回收件箱。
 * - 最小失败输入：目标已归档、前置检查返回 skipped 的一轮。
 * - tier：unit（fake runner，无调度器与数据库；用户活动与运行中判定在 desktop 写入口内重查）。
 */
import { expect, it, vi } from 'vitest';
import type { FireContext, FireResult, Schedule } from '@cindy/maker-scheduler';

import { withQuietRunArchive } from '../quietRunArchive.js';

const schedule = { id: 's1', targetSessionId: 'task' } as unknown as Schedule;
const ctx = (patch: Partial<FireContext> = {}) =>
  ({ runId: 'r1', firedAt: 1000, signal: new AbortController().signal, ...patch }) as unknown as FireContext;

function setup(status: string | null, result: FireResult, silenced = false) {
  const archiveIfUntouched = vi.fn(async () => {});
  const warn = vi.fn();
  const wrapped = withQuietRunArchive({ fire: vi.fn(async () => result) }, {
    targetStatus: async () => status,
    isRunSilenced: () => silenced,
    archiveIfUntouched,
    warn,
  });
  return { wrapped, archiveIfUntouched, warn };
}

it('returns an archived target to archived only after a skipped or silenced round', async () => {
  const skipped = setup('archived', { sessionId: '', skipped: true });
  expect(await skipped.wrapped.fire(schedule, ctx())).toEqual({ sessionId: '', skipped: true });
  expect(skipped.archiveIfUntouched).toHaveBeenCalledWith('task', 1000);

  const silenced = setup('archived', { sessionId: 'task' }, true);
  await silenced.wrapped.fire(schedule, ctx());
  expect(silenced.archiveIfUntouched).toHaveBeenCalledWith('task', 1000);

  for (const [status, result, quiet, runCtx] of [
    ['archived', { sessionId: 'task' }, false, ctx()], // notified the user
    ['active', { sessionId: '', skipped: true }, false, ctx()], // was never archived
    ['archived', { sessionId: '', deferred: true, deferRetryMs: 1 }, true, ctx()],
    ['archived', { sessionId: 'task' }, true, ctx({ resumeSessionId: 'task' })],
    ['archived', { sessionId: 'task' }, true, ctx({ signal: AbortSignal.abort() })],
    [null, { sessionId: '', skipped: true }, false, ctx()], // status unreadable
  ] as const) {
    const s = setup(status, result as FireResult, quiet);
    await s.wrapped.fire(schedule, runCtx);
    expect(s.archiveIfUntouched).not.toHaveBeenCalled();
  }
});

it('keeps the round result when re-archiving fails, and lets runner failures propagate', async () => {
  const s = setup('archived', { sessionId: '', skipped: true });
  s.archiveIfUntouched.mockRejectedValueOnce(new Error('locked'));
  expect(await s.wrapped.fire(schedule, ctx())).toEqual({ sessionId: '', skipped: true });
  expect(s.warn).toHaveBeenCalledOnce();

  const archiveIfUntouched = vi.fn();
  const failing = withQuietRunArchive({ fire: async () => { throw new Error('agent failed'); } }, {
    targetStatus: async () => 'archived', isRunSilenced: () => true, archiveIfUntouched, warn: vi.fn(),
  });
  await expect(failing.fire(schedule, ctx())).rejects.toThrow('agent failed');
  expect(archiveIfUntouched).not.toHaveBeenCalled();
});

// Bug 2026-11-18: each silent round of a per-round automation left an open task in the inbox.
it('archives the task a quiet round of an unbound automation created, but keeps notified rounds', async () => {
  const unbound = { id: 's2' } as unknown as Schedule;
  const silent = setup(null, { sessionId: 'run-task' }, true);
  await silent.wrapped.fire(unbound, ctx());
  expect(silent.archiveIfUntouched).toHaveBeenCalledWith('run-task', 1000);

  const notified = setup(null, { sessionId: 'run-task' }, false);
  await notified.wrapped.fire(unbound, ctx());
  const persistent = setup(null, { sessionId: 'home' }, true);
  await persistent.wrapped.fire({ id: 's3', persistentSession: true } as unknown as Schedule, ctx());
  const noTask = setup(null, { sessionId: '', skipped: true });
  await noTask.wrapped.fire(unbound, ctx());
  for (const s of [notified, persistent, noTask]) expect(s.archiveIfUntouched).not.toHaveBeenCalled();
});
