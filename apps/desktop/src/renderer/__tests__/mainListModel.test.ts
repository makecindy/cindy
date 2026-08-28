/**
 * mainListModel — 主列表混排模型单测(sidebar-redesign D 期)。
 * 覆盖:混排口径(项目行与散排对话平级竞争位置)、任务排序、对话组开关、
 * flat 平铺、自定义项目顺序只管项目行的收窄语义。
 */

import { describe, expect, it } from 'vitest';

import { LIVE_TASK_PRIORITY } from '../../shared/liveTaskPriority';
import type { Session } from '@/lib/ccAgent.types';
import type { ProjectNode } from '../features/cc-agent/lib/projectGrouping';
import {
  advanceViewedPriorityHold,
  buildMainListEntries,
  getMainListEntrySessions,
  holdViewedPriorityRank,
  sessionPriorityRank,
  splitEntriesByDevice,
  type MainListEntry,
} from '../features/cc-agent/lib/mainListModel';

let seq = 0;
function session(overrides: Partial<Session> & { updatedAt: string }): Session {
  seq += 1;
  return {
    id: `s${seq}`,
    userId: 'u',
    title: `session ${seq}`,
    workingDir: null,
    workspaceKind: 'dialogue',
    model: 'm',
    effort: 'high',
    permissionMode: 'ask',
    providerId: null,
    sdkSessionId: null,
    totalTokenUsage: 0,
    totalCostUsd: 0,
    contextTokens: 0,
    contextWindow: 0,
    fastMode: false,
    clearedAt: null,
    pinnedAt: null,
    userSendAt: null,
    status: 'active',
    agentKind: 'cc',
    createdAt: overrides.updatedAt,
    ...overrides,
  } as Session;
}

function project(key: string, sessions: Session[]): ProjectNode {
  return {
    projectKey: `local:${key}`,
    workingDir: key,
    displayName: key,
    scope: 'local',
    sessions,
    latestActivityAt: sessions[0]?.updatedAt ?? null,
  } as unknown as ProjectNode;
}

function labels(entries: MainListEntry[]): string[] {
  return entries.map((entry) =>
    entry.kind === 'project'
      ? `p:${entry.project.displayName}`
      : entry.kind === 'dialogue-group'
        ? 'dlg-group'
        : entry.kind === 'automation-group'
          ? `auto:${entry.group.title}`
          : `s:${entry.session.title}`,
  );
}

const NO_PRIORITY = {
  runningSessionIds: new Set<string>(),
  attentionSessionIds: new Set<string>(),
};

describe('buildMainListEntries — 混排(recency)', () => {
  it('interleaves project rows and stray dialogues by latest activity', () => {
    const projNew = project('alpha', [session({ updatedAt: '2026-08-12T10:00:00Z' })]);
    const projOld = project('beta', [session({ updatedAt: '2026-08-10T10:00:00Z' })]);
    const dlgMid = session({ updatedAt: '2026-08-11T10:00:00Z', title: 'mid-dlg' });
    const entries = buildMainListEntries({
      projects: [projOld, projNew],
      dialogues: [dlgMid],
      groupBy: 'project',
      groupDialogue: false,
      sortBy: 'recency',
      manualProjectOrder: [],
    });
    // 两分钟前活跃的对话排在昨天的项目上面——项目不是特权层级。
    expect(labels(entries)).toEqual(['p:alpha', 's:mid-dlg', 'p:beta']);
  });

  it('collects dialogues into one group entry when groupDialogue is on', () => {
    const proj = project('alpha', [session({ updatedAt: '2026-08-12T10:00:00Z' })]);
    const dlgA = session({ updatedAt: '2026-08-12T12:00:00Z', title: 'a' });
    const dlgB = session({ updatedAt: '2026-08-01T00:00:00Z', title: 'b' });
    const entries = buildMainListEntries({
      projects: [proj],
      dialogues: [dlgA, dlgB],
      groupBy: 'project',
      groupDialogue: true,
      sortBy: 'recency',
      manualProjectOrder: [],
    });
    // 对话组按组内最新活动(dlgA)参与排序 → 排在项目前。
    expect(labels(entries)).toEqual(['dlg-group', 'p:alpha']);
    const group = entries[0];
    expect(group.kind === 'dialogue-group' && group.sessions).toHaveLength(2);
  });

  it('flattens project sessions to top level when groupBy is flat', () => {
    const proj = project('alpha', [
      session({ updatedAt: '2026-08-12T10:00:00Z', title: 'in-proj' }),
    ]);
    const dlg = session({ updatedAt: '2026-08-12T11:00:00Z', title: 'dlg' });
    const entries = buildMainListEntries({
      projects: [proj],
      dialogues: [dlg],
      groupBy: 'flat',
      groupDialogue: false,
      sortBy: 'recency',
      manualProjectOrder: [],
    });
    expect(labels(entries)).toEqual(['s:dlg', 's:in-proj']);
  });

  it('keeps repeated automation runs grouped when project grouping is flat', () => {
    const olderRun = session({
      updatedAt: '2026-08-10T10:00:00Z',
      title: 'automation run 1',
      source: 'scheduler',
      workspaceKind: 'project',
      workingDir: '/repo',
    });
    const newerRun = session({
      updatedAt: '2026-08-12T10:00:00Z',
      title: 'automation run 2',
      source: 'scheduler',
      workspaceKind: 'project',
      workingDir: '/repo',
    });
    const manual = session({
      updatedAt: '2026-08-11T10:00:00Z',
      title: 'manual',
      workspaceKind: 'project',
      workingDir: '/repo',
    });
    const scheduleInfo = {
      scheduleId: 'schedule-cindy-check',
      scheduleName: '自动检查 Cindy',
      unreadRunIds: [],
      hasUnreadRun: false,
      hasUnreadFailedRun: false,
    };

    const entries = buildMainListEntries({
      projects: [project('/repo', [olderRun, manual, newerRun])],
      dialogues: [],
      groupBy: 'flat',
      groupDialogue: false,
      sortBy: 'recency',
      manualProjectOrder: [],
      notifications: new Set(),
      scheduleSessionIndex: new Map([
        [olderRun.id, scheduleInfo],
        [newerRun.id, scheduleInfo],
      ]),
    });

    expect(labels(entries)).toEqual(['auto:自动检查 Cindy', 's:manual']);
    const automationGroup = entries[0];
    expect(automationGroup.kind).toBe('automation-group');
    if (automationGroup.kind !== 'automation-group') throw new Error('expected automation group');
    expect(automationGroup.group.sessions.map((item) => item.id)).toEqual([
      newerRun.id,
      olderRun.id,
    ]);
  });

  it('keeps one schedule grouped after its working directory changes', () => {
    const olderRun = session({
      updatedAt: '2026-08-10T10:00:00Z',
      title: 'automation run 1',
      source: 'scheduler',
      workspaceKind: 'project',
      workingDir: '/old-repo',
    });
    const newerRun = session({
      updatedAt: '2026-08-12T10:00:00Z',
      title: 'automation run 2',
      source: 'scheduler',
      workspaceKind: 'project',
      workingDir: '/new-repo',
    });
    const scheduleInfo = {
      scheduleId: 'schedule-cindy-check',
      scheduleName: '自动检查 Cindy',
      unreadRunIds: [],
      hasUnreadRun: false,
      hasUnreadFailedRun: false,
    };

    const entries = buildMainListEntries({
      projects: [
        project('/old-repo', [olderRun]),
        project('/new-repo', [newerRun]),
      ],
      dialogues: [],
      groupBy: 'flat',
      groupDialogue: false,
      sortBy: 'recency',
      manualProjectOrder: [],
      scheduleSessionIndex: new Map([
        [olderRun.id, scheduleInfo],
        [newerRun.id, scheduleInfo],
      ]),
    });

    expect(labels(entries)).toEqual(['auto:自动检查 Cindy']);
    const automationGroup = entries[0];
    expect(automationGroup.kind).toBe('automation-group');
    if (automationGroup.kind !== 'automation-group') throw new Error('expected automation group');
    expect(automationGroup.group.sessions.map((item) => item.id)).toEqual([
      newerRun.id,
      olderRun.id,
    ]);
  });

  it('groups one schedule across project and dialogue destinations before grouping dialogues', () => {
    const olderProjectRun = session({
      updatedAt: '2026-08-10T10:00:00Z',
      title: 'project run',
      source: 'scheduler',
      workspaceKind: 'project',
      workingDir: '/repo',
    });
    const newerDialogueRun = session({
      updatedAt: '2026-08-12T10:00:00Z',
      title: 'dialogue run',
      source: 'scheduler',
      workspaceKind: 'dialogue',
      workingDir: null,
    });
    const manualDialogue = session({
      updatedAt: '2026-08-11T10:00:00Z',
      title: 'manual dialogue',
    });
    const scheduleInfo = {
      scheduleId: 'schedule-cindy-check',
      scheduleName: '自动检查 Cindy',
      unreadRunIds: [],
      hasUnreadRun: false,
      hasUnreadFailedRun: false,
    };

    const entries = buildMainListEntries({
      projects: [project('/repo', [olderProjectRun])],
      dialogues: [manualDialogue, newerDialogueRun],
      groupBy: 'flat',
      groupDialogue: true,
      sortBy: 'recency',
      manualProjectOrder: [],
      scheduleSessionIndex: new Map([
        [olderProjectRun.id, scheduleInfo],
        [newerDialogueRun.id, scheduleInfo],
      ]),
    });

    expect(labels(entries)).toEqual(['auto:自动检查 Cindy', 'dlg-group']);
    const automationGroup = entries[0];
    expect(automationGroup.kind).toBe('automation-group');
    if (automationGroup.kind !== 'automation-group') throw new Error('expected automation group');
    expect(automationGroup.group.sessions.map((item) => item.id)).toEqual([
      newerDialogueRun.id,
      olderProjectRun.id,
    ]);
    const dialogueGroup = entries[1];
    expect(dialogueGroup.kind).toBe('dialogue-group');
    if (dialogueGroup.kind !== 'dialogue-group') throw new Error('expected dialogue group');
    expect(dialogueGroup.sessions.map((item) => item.id)).toEqual([manualDialogue.id]);
  });

  it('keeps matching schedule ids isolated by remote device', () => {
    const runs = ['dev-a', 'dev-b'].flatMap((deviceLinkDeviceId, deviceIndex) =>
      [1, 2].map((runIndex) =>
        session({
          updatedAt: `2026-08-${10 + deviceIndex + runIndex}T10:00:00Z`,
          title: `${deviceLinkDeviceId} run ${runIndex}`,
          source: 'scheduler',
          workspaceKind: 'project',
          workingDir: '/repo',
          deviceLinkDeviceId,
        }),
      ),
    );
    const scheduleSessionIndex = new Map(
      runs.map((run) => [
        run.id,
        {
          scheduleId: 'shared-schedule-id',
          scheduleName: '远程自动检查',
          unreadRunIds: [],
          hasUnreadRun: false,
          hasUnreadFailedRun: false,
        },
      ]),
    );

    const entries = buildMainListEntries({
      projects: [project('/repo-a', runs.slice(0, 2)), project('/repo-b', runs.slice(2))],
      dialogues: [],
      groupBy: 'flat',
      groupDialogue: false,
      sortBy: 'recency',
      manualProjectOrder: [],
      scheduleSessionIndex,
    });
    const groups = entries.filter(
      (entry): entry is Extract<MainListEntry, { kind: 'automation-group' }> =>
        entry.kind === 'automation-group',
    );
    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((entry) => entry.group.id)).size).toBe(2);
    expect(groups.map((entry) => entry.group.legacyId)).toEqual([
      'schedule:shared-schedule-id',
      'schedule:shared-schedule-id',
    ]);
    expect(
      groups.map((entry) => new Set(entry.group.sessions.map((item) => item.deviceLinkDeviceId))),
    ).toEqual([new Set(['dev-b']), new Set(['dev-a'])]);

    const sections = splitEntriesByDevice(entries, ['dev-a', 'dev-b'], { sortBy: 'recency' });
    expect(sections.map((section) => section.deviceId)).toEqual(['dev-a', 'dev-b']);
    expect(
      sections.map((section) =>
        section.entries.flatMap((entry) => getMainListEntrySessions(entry).map((item) => item.id)),
      ),
    ).toEqual([
      runs.slice(0, 2).map((run) => run.id).reverse(),
      runs.slice(2).map((run) => run.id).reverse(),
    ]);
  });
});

describe('buildMainListEntries — 排序口径', () => {
  // 2026-08-12 用户裁决:「最早优先」(旧 sortBy 'time')删除,时间排序只保留
  // 最近活动在前一档(recency,菜单文案「按时间排序」)。
  it("sorts newest-first under 'recency'", () => {
    const projNew = project('alpha', [session({ updatedAt: '2026-08-12T10:00:00Z' })]);
    const dlgOld = session({ updatedAt: '2026-08-01T10:00:00Z', title: 'old' });
    const entries = buildMainListEntries({
      projects: [projNew],
      dialogues: [dlgOld],
      groupBy: 'project',
      groupDialogue: false,
      sortBy: 'recency',
      manualProjectOrder: [],
    });
    expect(labels(entries)).toEqual(['p:alpha', 's:old']);
  });

  it("floats waiting > unread > running > rest under 'priority', recency within tiers", () => {
    // 四档对齐 Codex(waiting:0 / unread:1 / active:2 / idle:3,2026-08-13 裁决)。
    const waiting = session({ updatedAt: '2026-07-20T00:00:00Z', title: 'needs-input' });
    const unread = session({ updatedAt: '2026-08-01T00:00:00Z', title: 'done-unread' });
    const running = session({ updatedAt: '2026-08-05T00:00:00Z', title: 'running' });
    const idleNewest = session({ updatedAt: '2026-08-12T00:00:00Z', title: 'idle' });
    const ctx = {
      runningSessionIds: new Set([running.id]),
      attentionSessionIds: new Set([waiting.id, unread.id]),
      waitingSessionIds: new Set([waiting.id]),
    };
    expect(sessionPriorityRank(waiting, ctx)).toBe(LIVE_TASK_PRIORITY.waiting);
    expect(sessionPriorityRank(unread, ctx)).toBe(LIVE_TASK_PRIORITY.unread);
    expect(sessionPriorityRank(running, ctx)).toBe(LIVE_TASK_PRIORITY.running);
    expect(sessionPriorityRank(idleNewest, ctx)).toBe(LIVE_TASK_PRIORITY.rest);
    const entries = buildMainListEntries({
      projects: [],
      dialogues: [idleNewest, running, unread, waiting],
      groupBy: 'project',
      groupDialogue: false,
      sortBy: 'priority',
      manualProjectOrder: [],
      priorityContext: ctx,
    });
    expect(labels(entries)).toEqual(['s:needs-input', 's:done-unread', 's:running', 's:idle']);
  });

  it('keeps the open unread task in place, then parks it at the top of the rest tier after leave', () => {
    const unread = session({ updatedAt: '2026-07-01T00:00:00Z', title: 'just-read' });
    const olderRest = session({ updatedAt: '2026-08-12T00:00:00Z', title: 'older-rest' });
    const waiting = session({ updatedAt: '2026-07-20T00:00:00Z', title: 'needs-input' });
    const hold = {
      heldPriorityRanks: new Map<string, number>(),
      recentlyViewedAtMs: new Map<string, number>(),
    };
    const opened = advanceViewedPriorityHold(
      hold,
      unread.id,
      {
        runningSessionIds: new Set<string>(),
        attentionSessionIds: new Set([unread.id, waiting.id]),
        waitingSessionIds: new Set([waiting.id]),
      },
      1_000,
    );
    expect(opened.heldPriorityRanks.get(unread.id)).toBe(1);
    const stillOpen = buildMainListEntries({
      projects: [],
      dialogues: [olderRest, unread, waiting],
      groupBy: 'project',
      groupDialogue: false,
      sortBy: 'priority',
      manualProjectOrder: [],
      priorityContext: {
        runningSessionIds: new Set<string>(),
        attentionSessionIds: new Set([waiting.id]),
        waitingSessionIds: new Set([waiting.id]),
        heldPriorityRanks: opened.heldPriorityRanks,
        recentlyViewedAtMs: opened.recentlyViewedAtMs,
      },
    });
    expect(labels(stillOpen)).toEqual(['s:needs-input', 's:just-read', 's:older-rest']);

    const leaveAt = Date.parse('2026-08-13T00:00:00Z');
    const left = advanceViewedPriorityHold(
      opened,
      olderRest.id,
      {
        runningSessionIds: new Set<string>(),
        attentionSessionIds: new Set([waiting.id]),
        waitingSessionIds: new Set([waiting.id]),
      },
      leaveAt,
    );
    expect(left.heldPriorityRanks.has(unread.id)).toBe(false);
    expect(left.recentlyViewedAtMs.get(unread.id)).toBe(leaveAt);
    const afterLeave = buildMainListEntries({
      projects: [],
      dialogues: [olderRest, unread, waiting],
      groupBy: 'project',
      groupDialogue: false,
      sortBy: 'priority',
      manualProjectOrder: [],
      priorityContext: {
        runningSessionIds: new Set<string>(),
        attentionSessionIds: new Set([waiting.id]),
        waitingSessionIds: new Set([waiting.id]),
        heldPriorityRanks: left.heldPriorityRanks,
        recentlyViewedAtMs: left.recentlyViewedAtMs,
      },
    });
    expect(labels(afterLeave)).toEqual(['s:needs-input', 's:just-read', 's:older-rest']);
    expect(sessionPriorityRank(unread, {
      runningSessionIds: new Set<string>(),
      attentionSessionIds: new Set([waiting.id]),
      waitingSessionIds: new Set([waiting.id]),
      recentlyViewedAtMs: left.recentlyViewedAtMs,
    })).toBe(LIVE_TASK_PRIORITY.rest);

    const sunkWithoutViewedAt = buildMainListEntries({
      projects: [],
      dialogues: [olderRest, unread, waiting],
      groupBy: 'project',
      groupDialogue: false,
      sortBy: 'priority',
      manualProjectOrder: [],
      priorityContext: {
        runningSessionIds: new Set<string>(),
        attentionSessionIds: new Set([waiting.id]),
        waitingSessionIds: new Set([waiting.id]),
      },
    });
    expect(labels(sunkWithoutViewedAt)).toEqual(['s:needs-input', 's:older-rest', 's:just-read']);

    const recencyIgnoresLeave = buildMainListEntries({
      projects: [],
      dialogues: [olderRest, unread],
      groupBy: 'project',
      groupDialogue: false,
      sortBy: 'recency',
      manualProjectOrder: [],
      priorityContext: {
        runningSessionIds: new Set<string>(),
        attentionSessionIds: new Set<string>(),
        recentlyViewedAtMs: left.recentlyViewedAtMs,
      },
    });
    expect(labels(recencyIgnoresLeave)).toEqual(['s:older-rest', 's:just-read']);
  });

  it('does not reorder already-read rest tasks when browsing among them', () => {
    const olderRest = session({ updatedAt: '2026-07-01T00:00:00Z', title: 'older-rest' });
    const newerRest = session({ updatedAt: '2026-08-12T00:00:00Z', title: 'newer-rest' });
    const hold = {
      heldPriorityRanks: new Map<string, number>(),
      recentlyViewedAtMs: new Map<string, number>(),
    };
    const restCtx = {
      runningSessionIds: new Set<string>(),
      attentionSessionIds: new Set<string>(),
      waitingSessionIds: new Set<string>(),
    };
    const openedOlder = advanceViewedPriorityHold(hold, olderRest.id, restCtx, 1_000);
    expect(openedOlder.heldPriorityRanks.get(olderRest.id)).toBe(LIVE_TASK_PRIORITY.rest);
    const leftOlder = advanceViewedPriorityHold(
      openedOlder,
      newerRest.id,
      restCtx,
      Date.parse('2026-08-13T00:00:00Z'),
    );
    expect(leftOlder.recentlyViewedAtMs.has(olderRest.id)).toBe(false);
    const afterBrowse = buildMainListEntries({
      projects: [],
      dialogues: [olderRest, newerRest],
      groupBy: 'project',
      groupDialogue: false,
      sortBy: 'priority',
      manualProjectOrder: [],
      priorityContext: {
        ...restCtx,
        heldPriorityRanks: leftOlder.heldPriorityRanks,
        recentlyViewedAtMs: leftOlder.recentlyViewedAtMs,
      },
    });
    expect(labels(afterBrowse)).toEqual(['s:newer-rest', 's:older-rest']);
    const recency = buildMainListEntries({
      projects: [],
      dialogues: [olderRest, newerRest],
      groupBy: 'project',
      groupDialogue: false,
      sortBy: 'recency',
      manualProjectOrder: [],
    });
    expect(labels(afterBrowse)).toEqual(labels(recency));
  });

  it('holds the unread rank even if attention is cleared before the first viewed render', () => {
    const unread = session({ updatedAt: '2026-07-01T00:00:00Z', title: 'just-read' });
    const olderRest = session({ updatedAt: '2026-08-12T00:00:00Z', title: 'older-rest' });
    const waiting = session({ updatedAt: '2026-07-20T00:00:00Z', title: 'needs-input' });
    const hold = {
      heldPriorityRanks: new Map<string, number>(),
      recentlyViewedAtMs: new Map<string, number>(),
    };
    holdViewedPriorityRank(hold, unread.id, {
      runningSessionIds: new Set<string>(),
      attentionSessionIds: new Set([unread.id, waiting.id]),
      waitingSessionIds: new Set([waiting.id]),
    });
    const afterClear = advanceViewedPriorityHold(
      hold,
      unread.id,
      {
        runningSessionIds: new Set<string>(),
        attentionSessionIds: new Set([waiting.id]),
        waitingSessionIds: new Set([waiting.id]),
      },
      1_000,
    );
    expect(afterClear.heldPriorityRanks.get(unread.id)).toBe(LIVE_TASK_PRIORITY.unread);
    const entries = buildMainListEntries({
      projects: [],
      dialogues: [olderRest, unread, waiting],
      groupBy: 'project',
      groupDialogue: false,
      sortBy: 'priority',
      manualProjectOrder: [],
      priorityContext: {
        runningSessionIds: new Set<string>(),
        attentionSessionIds: new Set([waiting.id]),
        waitingSessionIds: new Set([waiting.id]),
        heldPriorityRanks: afterClear.heldPriorityRanks,
      },
    });
    expect(labels(entries)).toEqual(['s:needs-input', 's:just-read', 's:older-rest']);
  });

  it('does not let leave time promote a still-waiting or running task', () => {
    const waitingOld = session({ updatedAt: '2026-07-01T00:00:00Z', title: 'waiting-old' });
    const waitingNew = session({ updatedAt: '2026-08-12T00:00:00Z', title: 'waiting-new' });
    const leaveAt = Date.parse('2026-08-13T00:00:00Z');
    const entries = buildMainListEntries({
      projects: [],
      dialogues: [waitingOld, waitingNew],
      groupBy: 'project',
      groupDialogue: false,
      sortBy: 'priority',
      manualProjectOrder: [],
      priorityContext: {
        runningSessionIds: new Set<string>(),
        attentionSessionIds: new Set([waitingOld.id, waitingNew.id]),
        waitingSessionIds: new Set([waitingOld.id, waitingNew.id]),
        recentlyViewedAtMs: new Map([[waitingOld.id, leaveAt]]),
      },
    });
    expect(labels(entries)).toEqual(['s:waiting-new', 's:waiting-old']);
  });

  it('waitingSessionIds 缺省时全部 attention 落 unread 档(老调用方零迁移)', () => {
    const attention = session({ updatedAt: '2026-08-01T00:00:00Z', title: 'attn' });
    const running = session({ updatedAt: '2026-08-05T00:00:00Z', title: 'running' });
    const ctx = {
      runningSessionIds: new Set([running.id]),
      attentionSessionIds: new Set([attention.id]),
    };
    expect(sessionPriorityRank(attention, ctx)).toBe(LIVE_TASK_PRIORITY.unread);
    expect(sessionPriorityRank(running, ctx)).toBe(LIVE_TASK_PRIORITY.running);
  });

  it('a project inherits its best session priority (group floats with its members)', () => {
    const attention = session({ updatedAt: '2026-08-01T00:00:00Z', title: 'attn-in-proj' });
    const proj = project('alpha', [attention]);
    const idleDlg = session({ updatedAt: '2026-08-12T00:00:00Z', title: 'idle-dlg' });
    const entries = buildMainListEntries({
      projects: [proj],
      dialogues: [idleDlg],
      groupBy: 'project',
      groupDialogue: false,
      sortBy: 'priority',
      manualProjectOrder: [],
      priorityContext: {
        runningSessionIds: new Set<string>(),
        attentionSessionIds: new Set([attention.id]),
      },
    });
    expect(labels(entries)).toEqual(['p:alpha', 's:idle-dlg']);
  });

  it('re-sorts project and dialogue groups by recency even when input is active-first', () => {
    // groupSessions 会先把 active 排在 archived 前。状态=全部时若组内沿用该序,
    // 刚归档的任务会沉到陈旧活跃任务下面,项目组和对话组都不符合「按时间」。
    const archivedNew = session({
      updatedAt: '2026-08-13T00:00:00Z',
      title: 'archived-new',
      status: 'archived',
      workingDir: '/alpha',
      workspaceKind: 'project',
    });
    const activeOld = session({
      updatedAt: '2026-08-01T00:00:00Z',
      title: 'active-old',
      status: 'active',
      workingDir: '/alpha',
      workspaceKind: 'project',
    });
    const dlgArchivedNew = session({
      updatedAt: '2026-08-13T00:00:00Z',
      title: 'dlg-archived-new',
      status: 'archived',
    });
    const dlgActiveOld = session({
      updatedAt: '2026-08-01T00:00:00Z',
      title: 'dlg-active-old',
      status: 'active',
    });
    const entries = buildMainListEntries({
      projects: [project('alpha', [activeOld, archivedNew])],
      dialogues: [dlgActiveOld, dlgArchivedNew],
      groupBy: 'project',
      groupDialogue: true,
      sortBy: 'recency',
      manualProjectOrder: [],
    });
    const projectEntry = entries.find((entry) => entry.kind === 'project');
    const dialogueEntry = entries.find((entry) => entry.kind === 'dialogue-group');
    expect(
      projectEntry?.kind === 'project' && projectEntry.project.sessions.map((item) => item.title),
    ).toEqual(['archived-new', 'active-old']);
    expect(
      dialogueEntry?.kind === 'dialogue-group' && dialogueEntry.sessions.map((item) => item.title),
    ).toEqual(['dlg-archived-new', 'dlg-active-old']);
  });

  it('keeps manual project-row order but still recency-sorts inside each group', () => {
    const archivedNew = session({
      updatedAt: '2026-08-13T00:00:00Z',
      title: 'archived-new',
      status: 'archived',
      workingDir: '/alpha',
      workspaceKind: 'project',
    });
    const activeOld = session({
      updatedAt: '2026-08-01T00:00:00Z',
      title: 'active-old',
      status: 'active',
      workingDir: '/alpha',
      workspaceKind: 'project',
    });
    const dlgArchivedNew = session({
      updatedAt: '2026-08-13T00:00:00Z',
      title: 'dlg-archived-new',
      status: 'archived',
    });
    const dlgActiveOld = session({
      updatedAt: '2026-08-01T00:00:00Z',
      title: 'dlg-active-old',
      status: 'active',
    });
    const entries = buildMainListEntries({
      projects: [project('alpha', [activeOld, archivedNew])],
      dialogues: [dlgActiveOld, dlgArchivedNew],
      groupBy: 'project',
      groupDialogue: true,
      sortBy: 'recency',
      projectOrder: 'custom',
      manualProjectOrder: ['local:alpha'],
    });
    const projectEntry = entries.find((entry) => entry.kind === 'project');
    const dialogueEntry = entries.find((entry) => entry.kind === 'dialogue-group');
    expect(
      projectEntry?.kind === 'project' && projectEntry.project.sessions.map((item) => item.title),
    ).toEqual(['archived-new', 'active-old']);
    expect(
      dialogueEntry?.kind === 'dialogue-group' && dialogueEntry.sessions.map((item) => item.title),
    ).toEqual(['dlg-archived-new', 'dlg-active-old']);
  });

  it('keeps manual sort scoped to project rows; dialogues follow by recency (§9.3)', () => {
    const projA = project('alpha', [session({ updatedAt: '2026-08-01T00:00:00Z' })]);
    const projB = project('beta', [session({ updatedAt: '2026-08-12T00:00:00Z' })]);
    const dlg = session({ updatedAt: '2026-08-13T00:00:00Z', title: 'newest-dlg' });
    const entries = buildMainListEntries({
      projects: [projA, projB],
      dialogues: [dlg],
      groupBy: 'project',
      groupDialogue: false,
      sortBy: 'recency',
      projectOrder: 'custom',
      manualProjectOrder: ['local:beta', 'local:alpha'],
      priorityContext: NO_PRIORITY,
    });
    // 项目按自定义顺序;最新的散排对话也排在项目之后(自定义只管项目行)。
    expect(labels(entries)).toEqual(['p:beta', 'p:alpha', 's:newest-dlg']);
  });

  it('stacks custom project order with priority sort for tasks after the project block', () => {
    const waitingDlg = session({ id: 'wait', updatedAt: '2026-08-01T00:00:00Z', title: 'wait' });
    const idleDlg = session({ id: 'idle', updatedAt: '2026-08-13T00:00:00Z', title: 'idle' });
    const projA = project('alpha', [session({ updatedAt: '2026-08-12T00:00:00Z' })]);
    const projB = project('beta', [session({ updatedAt: '2026-08-10T00:00:00Z' })]);
    const entries = buildMainListEntries({
      projects: [projA, projB],
      dialogues: [idleDlg, waitingDlg],
      groupBy: 'project',
      groupDialogue: false,
      sortBy: 'priority',
      projectOrder: 'custom',
      manualProjectOrder: ['local:beta', 'local:alpha'],
      priorityContext: {
        runningSessionIds: new Set<string>(),
        attentionSessionIds: new Set([waitingDlg.id]),
        waitingSessionIds: new Set([waitingDlg.id]),
      },
    });
    expect(labels(entries)).toEqual(['p:beta', 'p:alpha', 's:wait', 's:idle']);
  });
});

describe('splitEntriesByDevice — 拆段后按本段重排', () => {
  it('re-sorts each device section by its own activity after splitting a dialogue group', () => {
    const localOld = session({
      updatedAt: '2026-08-01T00:00:00Z',
      title: 'local-old',
    });
    const remoteNew = session({
      updatedAt: '2026-08-13T00:00:00Z',
      title: 'remote-new',
      deviceLinkDeviceId: 'dev-a',
    });
    const localProject = project('local-proj', [
      session({
        updatedAt: '2026-08-10T00:00:00Z',
        title: 'local-proj',
        workingDir: '/local',
        workspaceKind: 'project',
      }),
    ]);
    const entries = buildMainListEntries({
      projects: [localProject],
      dialogues: [localOld, remoteNew],
      groupBy: 'project',
      groupDialogue: true,
      sortBy: 'recency',
      manualProjectOrder: [],
    });
    const sections = splitEntriesByDevice(entries, ['dev-a'], { sortBy: 'recency' });
    const local = sections.find((section) => section.deviceId === null);
    expect(local && labels(local.entries)).toEqual(['p:local-proj', 'dlg-group']);
  });

  it('places unclassified drafts into the owning device section', () => {
    const remoteDraft = session({
      updatedAt: '2026-08-13T00:00:00Z',
      title: 'remote-draft',
      deviceLinkDeviceId: 'dev-a',
    });
    const entries = buildMainListEntries({
      projects: [],
      dialogues: [],
      unclassified: [remoteDraft],
      groupBy: 'project',
      groupDialogue: true,
      sortBy: 'recency',
      manualProjectOrder: [],
    });
    const sections = splitEntriesByDevice(entries, ['dev-a'], { sortBy: 'recency' });
    expect(sections.map((section) => section.deviceId)).toEqual(['dev-a']);
    expect(labels(sections[0].entries)).toEqual(['s:remote-draft']);
  });
});
