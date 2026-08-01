import { describe, expect, it } from 'vitest';
import {
  buildMobileDirectoryEntries,
  normalizeRemoteDirectoryListResult,
  normalizeRemotePathStatResults,
} from '../fileBrowser.js';
import { SHARED_REMOTE_CONTROL_FIXTURE } from '../fixtures.js';
import {
  permissionRiskSummary,
  selectActivePendingInteraction,
} from '../interaction.js';
import { buildMessageRenderItems } from '../messageRender.js';
import { buildQueuePanelSummary, isOrcaQueueItem } from '../queue.js';
import {
  displayRunsForMobile,
  normalizeScheduleList,
  normalizeScheduleRuns,
  summarizeRun,
  summarizeSchedule,
} from '../scheduleModel.js';
import {
  buildMobileScheduleInput,
  createMobileScheduleDraft,
} from '../scheduleForm.js';

describe('shared remote-control fixture baseline', () => {
  it('drives message render, queue, interaction, schedule and file models from one fixture', () => {
    const fixture = SHARED_REMOTE_CONTROL_FIXTURE;

    expect(fixture.rawMessages.map((message) => message.id)).toContain('raw-final');

    // 桌面共享实现把 plan/todo 卡渲染成顶层独立项(work_group 之后、收尾 message 之前)。
    expect(buildMessageRenderItems(fixture.messages).map((item) => item.type)).toEqual([
      'message',
      'work_group',
      'todo',
      'message',
    ]);

    const active = selectActivePendingInteraction(fixture.pendingInteractions);
    expect(active?.request.kind).toBe('plan_review');
    expect(permissionRiskSummary(fixture.pendingInteractions[0].request)).toContain('修改系统');

    expect(buildQueuePanelSummary(fixture.queue)).toMatchObject({
      title: '待发送队列',
      visibleCount: 2,
    });
    expect(isOrcaQueueItem(fixture.queue.pendingQueue[1] as { origin?: unknown })).toBe(true);

    expect(summarizeSchedule(
      fixture.schedules[0],
      fixture.scheduleRuns,
      Date.parse('2026-06-17T08:00:00.000Z'),
    )).toMatchObject({
      title: '每日移动端远控巡检',
      detail: 'cron 0 9 * * * · 新任务 · Claude · xdt-maker',
      runSessionDetail: null,
      runSessionLabel: '新任务',
      unreadCount: 1,
    });

    expect(buildMobileDirectoryEntries(
      fixture.files.directories,
      fixture.files.stats,
    ).map((entry) => [entry.kind, entry.name, entry.subtitle])).toEqual([
      ['symlink', 'current', '目录链接'],
      ['dir', 'apps', '目录'],
      ['file', 'fixture.drawio', 'Draw.io'],
      ['file', 'mobile-v1-source-plan.md', '文本预览'],
      ['file', 'README.md', '文本预览'],
    ]);
  });

  it('normalizes raw schedule and file payloads before any UI renders them', () => {
    const fixture = SHARED_REMOTE_CONTROL_FIXTURE;
    const schedules = normalizeScheduleList(fixture.rawSchedulePayloads.list);
    const runs = normalizeScheduleRuns(fixture.rawSchedulePayloads.runs);

    expect(schedules.map((schedule) => [schedule.id, schedule.name, schedule.status])).toEqual([
      ['schedule-bound-session', '绑定会话巡检', 'active'],
      ['schedule-paused', '暂停的项目自动化', 'paused'],
      ['schedule-unknown-status', 'schedule-unknown-status', 'active'],
    ]);
    expect(runs.map((run) => [run.id, run.status])).toEqual([
      ['run-bound-old', 'success'],
      ['run-bound-new', 'failed'],
      ['run-bound-running', 'running'],
      ['run-bad-status', 'failed'],
    ]);
    expect(displayRunsForMobile(runs).map((run) => run.id)).toEqual([
      'run-bad-status',
      'run-bound-running',
      'run-bound-new',
    ]);
    expect(summarizeRun(runs[1], Date.parse('2026-06-17T08:00:00.000Z'))).toMatchObject({
      title: '失败',
      detail: 'mobile parity failed',
      canOpenSession: true,
      unread: true,
    });

    const draft = createMobileScheduleDraft(fixture.rawSchedulePayloads.boundSessionSchedule);
    const input = buildMobileScheduleInput(draft);
    expect(input).toMatchObject({
      targetSessionId: 'session-primary',
      persistentSession: false,
      silentWhenIdle: true,
      useWorktree: false,
    });
    expect(hasOwn(input, 'workingDir')).toBe(false);
    expect(hasOwn(input, 'model')).toBe(true);
    expect(hasOwn(input, 'effort')).toBe(true);
    expect(input.model).toBeUndefined();
    expect(input.effort).toBeUndefined();
    expect(hasOwn(input, 'fastMode')).toBe(false);

    const listDir = normalizeRemoteDirectoryListResult(fixture.rawFilePayloads.listDir);
    const stats = normalizeRemotePathStatResults(fixture.rawFilePayloads.stats);
    expect(listDir).toMatchObject({ resolvedPath: '/repo/xdt-maker', parent: '/repo' });
    expect(stats.map((stat) => [stat.kind, stat.resolvedPath])).toEqual([
      ['file', '/repo/xdt-maker/README.md'],
      ['file', '/repo/xdt-maker/spec.pdf'],
      ['file', '/repo/xdt-maker/sheet.xlsx'],
      ['dir', '/repo/xdt-maker/packages'],
      ['missing', '/repo/xdt-maker/missing.txt'],
    ]);
    expect(buildMobileDirectoryEntries(listDir.entries, stats).map((entry) => [
      entry.kind,
      entry.name,
      entry.subtitle,
    ])).toEqual([
      ['symlink', 'current', '目录链接'],
      ['dir', 'apps', '目录'],
      ['file', 'demo.mp4', '二进制文件'],
      ['file', 'README.md', '文本预览'],
      ['file', 'sheet.xlsx', 'Office'],
      ['file', 'spec.pdf', 'PDF'],
      ['file', 'zeta.log', '文本预览'],
    ]);
  });
});

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
