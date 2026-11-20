/**
 * 测试价值：生产 archiveQuietScheduledTarget 写入入口；安静轮次不得覆盖本轮用户延期或新运行。
 * 规则：archive-pauses-automations.md；此前只有 runner wrapper 测试，未覆盖持锁后的变化。
 * 最小失败输入：查询期间另一轮开始，或 snoozedAt >= sinceMs；unit，内存 DB/runtime 替身，无 I/O。
 */
import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  busy: false, pending: false, action: 0,
  row: {} as Record<string, unknown>, query: vi.fn(), patch: vi.fn(),
}));
vi.mock('../../localDb/client/current', () => ({ getDbClient: () => ({ queryOne: h.query }) }));
vi.mock('../../localDb/ipc/sessions', () => ({ patchSessionMetaInDb: h.patch }));
vi.mock('../../localDb/sessionRouteLock', () => ({ withSessionRouteLock: async (_id: string, fn: () => unknown) => fn() }));
vi.mock('../../maker-ipc/register.js', () => ({
  getSessionLastUserActionAt: () => h.action,
  hasPendingSchedulerTargetInput: () => h.pending,
  isSchedulerTargetSessionBusy: () => h.busy,
}));
import { archiveQuietScheduledTarget } from '../quietRunArchive.desktop';
beforeEach(() => {
  h.busy = false; h.pending = false; h.action = 0;
  h.row = { status: 'active', pinnedAt: null, queued: 0, snoozedAt: null };
  h.query.mockReset().mockImplementation(async (sql: string) => sql.includes('FROM sessions s') ? h.row : null);
  h.patch.mockReset().mockImplementation(async (_id, _patch, options) => options.beforeWrite());
});
it('archives an untouched task but preserves explicit snooze, pins and queued input', async () => {
  await archiveQuietScheduledTarget('task', 1000);
  expect(h.patch).toHaveBeenCalledOnce();
  for (const row of [{ snoozedAt: 1000 }, { pinnedAt: 1001 }, { queued: 1 }]) {
    h.patch.mockClear(); Object.assign(h.row, { snoozedAt: null, pinnedAt: null, queued: 0 }, row);
    await archiveQuietScheduledTarget('task', 1000);
    expect(h.patch).not.toHaveBeenCalled();
  }
});
it.each(['busy', 'pending', 'action'] as const)('rejects a new %s after asynchronous preparation', async key => {
  let wrote = false;
  h.patch.mockImplementationOnce(async (_id, _patch, options) => {
    if (key === 'action') h.action = 1001; else h[key] = true;
    options.beforeWrite(); wrote = true;
  });
  await archiveQuietScheduledTarget('task', 1000);
  expect(wrote).toBe(false);
});
