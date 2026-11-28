import { describe, expect, it } from 'vitest';
import { INDEFINITE_SNOOZE_UNTIL, taskInboxSection, taskSnoozeUntil } from '../liveTaskPriority.js';
import {
  captureSessionActivityAnchor,
  createOfflineCompleteIntent,
  evaluateOfflineInboxIntentReplay,
  normalizeOfflineInboxIntents,
  projectSessionWithOfflineInboxIntent,
  projectTeammateSnoozeWithOfflineInboxIntent,
  resolveOfflineSnoozeIntent,
} from '../offlineInboxIntent.js';

/**
 * 测试价值
 * - 生产入口与可观察结果：@cindy/maker-shared/offline-inbox-intent 的离线意图投影、归一与上线重放判据；
 *   决定收件箱离线点「完成 / 稍后处理」时的分区迁移及电脑重连后的重放/撤销结果。
 * - Bug／规则依据：docs/product-rules/task-inbox.md 离线电脑任务在收件箱无法完成或稍后处理，
 *   且上线重放不得在有新活动、运行中或时钟偏移时误归档或提前唤醒。
 * - 现有覆盖缺口：liveTaskPriority.test.ts 仅覆盖在线会话字段分类，不涉及离线意图投影与重放前置条件。
 * - 最小失败输入：宿主机时钟领先控制端 5 分钟导致离线 snooze 投影被 userSendAt > snoozedAt 立刻唤醒；
 *   或离线期间宿主机产生新消息后重放仍强行归档。
 * - tier：unit（纯函数、无 I/O，node 环境毫秒级完成）。
 */
describe('offlineInboxIntent', () => {
  const baseSession = {
    id: 'sess-1',
    status: 'active',
    pinnedAt: null as string | null,
    snoozedUntil: null as string | null,
    snoozedAt: null as string | null,
    userSendAt: '2026-11-26T10:00:00.000Z',
    lastActivityAt: '2026-11-26T10:05:00.000Z',
    updatedAt: '2026-11-26T10:05:00.000Z',
    title: 'Fix release notes',
    deviceLinkDeviceName: 'Office Mac',
  };

  it('projects offline snooze safely even when host clock leads controller clock', () => {
    const controllerNow = '2026-11-26T09:55:00.000Z';
    const snoozedUntil = '2026-11-26T18:00:00.000Z';
    const intent = resolveOfflineSnoozeIntent('dev-1', 'sess-1', baseSession, snoozedUntil, controllerNow);
    expect(intent).not.toBeNull();
    const projected = projectSessionWithOfflineInboxIntent(baseSession, intent!);
    expect(projected.snoozedUntil).toBe(snoozedUntil);
    expect(projected.snoozedAt).toBe(baseSession.userSendAt);
    expect(taskSnoozeUntil(projected)).toBe(Date.parse(snoozedUntil));
    expect(
      taskInboxSection(projected, { waiting: false, running: false }, Date.parse('2026-11-26T11:00:00.000Z')),
    ).toBe('snoozed');
  });

  it('returns null instead of queueing a no-op wake when cached host session was not snoozed', () => {
    expect(resolveOfflineSnoozeIntent('dev-1', 'sess-1', baseSession, null, '2026-11-26T10:10:00.000Z')).toBeNull();

    const hostSnoozed = {
      ...baseSession,
      snoozedUntil: '2026-11-27T09:00:00.000Z',
      snoozedAt: '2026-11-26T10:06:00.000Z',
    };
    const wakeIntent = resolveOfflineSnoozeIntent('dev-1', 'sess-1', hostSnoozed, null, '2026-11-26T10:10:00.000Z');
    expect(wakeIntent?.snoozedUntil).toBeNull();
    const projected = projectSessionWithOfflineInboxIntent(hostSnoozed, wakeIntent!);
    expect(projected.snoozedUntil).toBeNull();
    expect(projected.snoozedAt).toBeNull();
  });

  it('projects offline complete to archived and clears pin and snooze', () => {
    const pinnedSnoozed = {
      ...baseSession,
      pinnedAt: '2026-11-26T09:00:00.000Z',
      snoozedUntil: '2026-11-27T09:00:00.000Z',
      snoozedAt: '2026-11-26T10:06:00.000Z',
    };
    const intent = createOfflineCompleteIntent('dev-1', 'sess-1', pinnedSnoozed, '2026-11-26T10:10:00.000Z');
    const projected = projectSessionWithOfflineInboxIntent(pinnedSnoozed, intent);
    expect(projected.status).toBe('archived');
    expect(projected.archivedAt).toBe('2026-11-26T10:10:00.000Z');
    expect(projected.pinnedAt).toBeNull();
    expect(projected.snoozedUntil).toBeNull();
    expect(projected.snoozedAt).toBeNull();
    const alreadyArchived = projectSessionWithOfflineInboxIntent(
      { ...pinnedSnoozed, status: 'archived', archivedAt: '2026-11-26T08:00:00.000Z' },
      intent,
    );
    expect(alreadyArchived.archivedAt).toBe('2026-11-26T08:00:00.000Z');
  });

  it('projects teammate snooze with host clock skew protection', () => {
    const snooze = { snoozedUntil: null, snoozedAt: null, userSendAt: '2026-11-26T10:05:00.000Z' };
    const intent = resolveOfflineSnoozeIntent(
      'dev-1',
      'bot-sess-1',
      { userSendAt: snooze.userSendAt, snoozedUntil: null, snoozedAt: null },
      INDEFINITE_SNOOZE_UNTIL,
      '2026-11-26T10:00:00.000Z',
    )!;
    const projected = projectTeammateSnoozeWithOfflineInboxIntent(snooze, intent);
    expect(projected?.snoozedUntil).toBe(INDEFINITE_SNOOZE_UNTIL);
    expect(projected?.snoozedAt).toBe('2026-11-26T10:05:00.000Z');
    expect(taskSnoozeUntil(projected!)).toBe(Infinity);
  });

  it.each([
    {
      name: 'applies snooze when fresh session is unchanged and future',
      intent: resolveOfflineSnoozeIntent('dev-1', 'sess-1', baseSession, '2026-11-26T18:00:00.000Z', '2026-11-26T10:10:00.000Z')!,
      fresh: baseSession,
      live: { nowMs: Date.parse('2026-11-26T12:00:00.000Z') },
      expected: { action: 'apply-snooze', snoozedUntil: '2026-11-26T18:00:00.000Z' },
    },
    {
      name: 'drops snooze when wake time already expired while offline',
      intent: resolveOfflineSnoozeIntent('dev-1', 'sess-1', baseSession, '2026-11-26T12:00:00.000Z', '2026-11-26T10:10:00.000Z')!,
      fresh: baseSession,
      live: { nowMs: Date.parse('2026-11-26T12:01:00.000Z') },
      expected: { action: 'drop', reason: 'expired' },
    },
    {
      name: 'keeps indefinite snooze regardless of elapsed time',
      intent: resolveOfflineSnoozeIntent('dev-1', 'sess-1', baseSession, INDEFINITE_SNOOZE_UNTIL, '2026-11-26T10:10:00.000Z')!,
      fresh: baseSession,
      live: { nowMs: Date.parse('2027-01-01T00:00:00.000Z') },
      expected: { action: 'apply-snooze', snoozedUntil: INDEFINITE_SNOOZE_UNTIL },
    },
    {
      name: 'drops snooze when host received newer user/automation input',
      intent: resolveOfflineSnoozeIntent('dev-1', 'sess-1', baseSession, '2026-11-26T18:00:00.000Z', '2026-11-26T10:10:00.000Z')!,
      fresh: { ...baseSession, userSendAt: '2026-11-26T10:20:00.000Z' },
      live: { nowMs: Date.parse('2026-11-26T12:00:00.000Z') },
      expected: { action: 'drop', reason: 'superseded-by-activity' },
    },
    {
      name: 'drops snooze when host already archived the task',
      intent: resolveOfflineSnoozeIntent('dev-1', 'sess-1', baseSession, '2026-11-26T18:00:00.000Z', '2026-11-26T10:10:00.000Z')!,
      fresh: { ...baseSession, status: 'archived' },
      live: { nowMs: Date.parse('2026-11-26T12:00:00.000Z') },
      expected: { action: 'drop', reason: 'session-archived' },
    },
    {
      name: 'applies complete when host task has no new activity, is idle, and is confirmed unattached',
      intent: createOfflineCompleteIntent('dev-1', 'sess-1', baseSession, '2026-11-26T10:10:00.000Z'),
      fresh: { ...baseSession, imAttached: false },
      live: {},
      expected: { action: 'apply-complete' },
    },
    {
      name: 'drops complete when host task is already archived',
      intent: createOfflineCompleteIntent('dev-1', 'sess-1', baseSession, '2026-11-26T10:10:00.000Z'),
      fresh: { ...baseSession, status: 'archived', imAttached: false },
      live: {},
      expected: { action: 'drop', reason: 'already-applied' },
    },
    {
      name: 'rejects complete when host task received new activity while offline',
      intent: createOfflineCompleteIntent('dev-1', 'sess-1', baseSession, '2026-11-26T10:10:00.000Z'),
      fresh: { ...baseSession, lastActivityAt: '2026-11-26T10:30:00.000Z', imAttached: false },
      live: {},
      expected: { action: 'reject', reason: 'new-activity' },
    },
    {
      name: 'rejects complete when host task is running on reconnect',
      intent: createOfflineCompleteIntent('dev-1', 'sess-1', baseSession, '2026-11-26T10:10:00.000Z'),
      fresh: { ...baseSession, imAttached: false },
      live: { isRunning: true },
      expected: { action: 'reject', reason: 'running' },
    },
    {
      name: 'rejects complete when host reports task is IM-attached on reconnect',
      intent: createOfflineCompleteIntent('dev-1', 'sess-1', baseSession, '2026-11-26T10:10:00.000Z'),
      fresh: { ...baseSession, imAttached: true },
      live: {},
      expected: { action: 'reject', reason: 'attached' },
    },
    {
      name: 'fails closed when host cannot confirm IM attachment status on reconnect',
      intent: createOfflineCompleteIntent('dev-1', 'sess-1', baseSession, '2026-11-26T10:10:00.000Z'),
      fresh: baseSession,
      live: {},
      expected: { action: 'reject', reason: 'preflight-unknown' },
    },
    {
      name: 'drops intent when session is confirmed missing',
      intent: createOfflineCompleteIntent('dev-1', 'sess-1', baseSession, '2026-11-26T10:10:00.000Z'),
      fresh: null,
      live: {},
      expected: { action: 'drop', reason: 'session-missing' },
    },
  ])('$name', ({ intent, fresh, live, expected }) => {
    expect(evaluateOfflineInboxIntentReplay(intent, fresh, live)).toEqual(expected);
  });

  it('normalizes, deduplicates by latest createdAt, and drops malformed records', () => {
    const older = resolveOfflineSnoozeIntent('dev-1', 'sess-1', baseSession, '2026-11-26T15:00:00.000Z', '2026-11-26T10:00:00.000Z')!;
    const newer = createOfflineCompleteIntent('dev-1', 'sess-1', baseSession, '2026-11-26T10:05:00.000Z');
    const result = normalizeOfflineInboxIntents([
      null,
      { deviceId: '', sessionId: 'sess-2', kind: 'complete', createdAt: '2026-11-26T10:00:00.000Z' },
      { deviceId: 'dev-1', sessionId: 'sess-3', kind: 'snooze', snoozedUntil: 'not-a-date', createdAt: '2026-11-26T10:00:00.000Z' },
      older,
      newer,
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ deviceId: 'dev-1', sessionId: 'sess-1', kind: 'complete' });
    expect(captureSessionActivityAnchor(baseSession)).toEqual({
      basedOnActivityAt: '2026-11-26T10:05:00.000Z',
      basedOnUserSendAt: '2026-11-26T10:00:00.000Z',
    });
  });
});
