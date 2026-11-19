import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import {
  buildGroupedHomeRows,
  buildHomeSections,
  buildInboxHomeSections,
  buildMixedHomeRows,
  HOME_MAIN_SECTION_KEY,
  homeFolderRowsShareRenderData,
  homeRowsShareRenderData,
  homeRowBefore,
  mergeAutomationItems,
  withMergedAutomationPriority,
} from '@/session/homeSections';
import type { MobileHomePresentation, MobileHomeProjectGroup } from '@/session/mobileHome';
import type { RemoteSessionListItem } from '@/session/sessionList';
import { collectHomePriorityContext, collectInboxHomePriorityContext } from '@/session/homeListPriority';
import { groupAutomationListItems } from '@cindy/maker-shared/session-list';

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

// 最小 fixture:buildHomeSections / rows 只读取下面这几个字段,其余字段对本测试无关,
// 用 cast 避免构造完整 RemoteSessionListItem / MobileHomeProjectGroup。
function listItem(id: string, lastActivityAt: string): RemoteSessionListItem {
  return { session: { id }, lastActivityAt, pendingInteractionCount: 0 } as unknown as RemoteSessionListItem;
}

function projectGroup(
  key: string,
  latestActivityAt: string,
  sessions: RemoteSessionListItem[],
): MobileHomeProjectGroup {
  return { key, latestActivityAt, sessions, sessionCount: sessions.length } as unknown as MobileHomeProjectGroup;
}

function presentation(over: Partial<MobileHomePresentation>): MobileHomePresentation {
  return { pinned: [], chats: [], projects: [], ...over } as unknown as MobileHomePresentation;
}

describe('buildHomeSections', () => {
  it('置顶收起时保留分区但清空 data(表头照常渲染,只折叠下属会话)', () => {
    const home = presentation({
      pinned: [listItem('p1', '2026-06-02T00:00:00Z'), listItem('p2', '2026-06-01T00:00:00Z')],
      chats: [listItem('c1', '2026-06-03T00:00:00Z')],
    });

    const expanded = buildHomeSections(home, false, false);
    const pinnedExpanded = expanded.find((s) => s.key === 'pinned');
    expect(pinnedExpanded?.title).toBe('置顶');
    expect(pinnedExpanded?.data).toHaveLength(2);

    const collapsed = buildHomeSections(home, false, true);
    const pinnedCollapsed = collapsed.find((s) => s.key === 'pinned');
    expect(pinnedCollapsed).toBeDefined();
    expect(pinnedCollapsed?.title).toBe('置顶'); // 表头仍在
    expect(pinnedCollapsed?.data).toHaveLength(0); // 只清空下属会话
  });

  it('仅置顶且收起时,只有一个空 data 的置顶分区(对应 Home 的空态守卫)', () => {
    const home = presentation({ pinned: [listItem('p1', '2026-06-01T00:00:00Z')] });
    const sections = buildHomeSections(home, false, true);
    expect(sections).toHaveLength(1);
    expect(sections[0].key).toBe('pinned');
    expect(sections[0].data).toHaveLength(0);
  });

  it('无置顶时不产生置顶分区', () => {
    const home = presentation({ chats: [listItem('c1', '2026-06-01T00:00:00Z')] });
    const sections = buildHomeSections(home, false, false);
    expect(sections.find((s) => s.key === 'pinned')).toBeUndefined();
  });

  it('分组模式把项目与普通对话放在同一分区,不渲染项目 / 对话汇总表头', () => {
    const home = presentation({
      chats: [listItem('c1', '2026-06-01T00:00:00Z')],
      projects: [projectGroup('proj-a', '2026-06-02T00:00:00Z', [listItem('s1', '2026-06-02T00:00:00Z')])],
    });
    expect(buildHomeSections(home, false, false).find((s) => s.title === null)?.key).toBe(HOME_MAIN_SECTION_KEY);
    expect(buildHomeSections(home, true, false).map((s) => [s.key, s.title])).toEqual([
      [HOME_MAIN_SECTION_KEY, null],
    ]);
  });

  it('recognizes a rebuilt large folder backed by the same session items', () => {
    const home = presentation({
      chats: Array.from({ length: 112 }, (_, index) => (
        listItem(`chat-${index}`, `2026-06-${String((index % 28) + 1).padStart(2, '0')}T00:00:00Z`)
      )),
    });
    const previous = buildGroupedHomeRows(home, { groupDialogue: true })
      .find((row) => row.kind === 'dialogue');
    const next = buildMixedHomeRows(home, { groupDialogue: true })
      .find((row) => row.kind === 'dialogue');

    expect(previous).toBeDefined();
    expect(next).toBeDefined();
    expect(previous).not.toBe(next);
    expect(homeFolderRowsShareRenderData(previous!, next!)).toBe(true);
    if (!next || next.kind !== 'dialogue') throw new Error('expected dialogue row');
    const changed = {
      ...next,
      project: {
        ...next.project,
        sessions: [{ ...next.project.sessions[0] }, ...next.project.sessions.slice(1)],
      },
    };
    expect(homeFolderRowsShareRenderData(previous!, changed)).toBe(false);
  });

  it('recognizes rebuilt session row wrappers backed by the same list item', () => {
    const item = listItem('chat-1', '2026-06-01T00:00:00Z');
    const home = presentation({ chats: [item] });
    const previous = buildGroupedHomeRows(home)[0];
    const next = buildGroupedHomeRows(home)[0];

    if (previous.kind !== 'session' || next.kind !== 'session') {
      throw new Error('expected session rows');
    }
    expect(previous).not.toBe(next);
    expect(homeRowsShareRenderData(previous, next)).toBe(true);
    expect(homeRowsShareRenderData(previous, {
      ...next,
      sourceLabel: 'Chat',
    })).toBe(false);
  });
});

describe('自动化归组', () => {
  function run(id: string, lastActivityAt: string, source?: string): RemoteSessionListItem {
    return { session: { id, title: id, source }, title: id, lastActivityAt, pendingInteractionCount: 0 } as unknown as RemoteSessionListItem;
  }

  it('把项目和对话里的自动化运行收进一个目录,只剩自动化的项目随之消失', () => {
    const home = presentation({
      chats: [run('digest', '2026-11-14T00:00:00Z', 'scheduler'), run('chat', '2026-11-13T00:00:00Z')],
      projects: [
        projectGroup('buddy', '2026-11-17T03:30:00Z', [run('review', '2026-11-17T03:30:00Z', 'scheduler')]),
        projectGroup('repo', '2026-11-16T00:00:00Z', [
          run('report', '2026-11-16T00:00:00Z', 'scheduler'),
          run('work', '2026-11-15T00:00:00Z'),
        ]),
      ],
    });
    const rows = buildHomeSections(home, true, false, { groupAutomation: true, automationTitle: '自动化' })
      .find((section) => section.key === HOME_MAIN_SECTION_KEY)?.data ?? [];
    expect(rows.map((row) => row.kind === 'session' ? row.item.session.id : `${row.kind}:${row.project.key}`)).toEqual([
      'automation:automation',
      'project:repo',
      'chat',
    ]);
    const folder = rows[0];
    expect(folder.kind === 'automation' && folder.project.sessions.map((item) => item.session.id))
      .toEqual(['review', 'report', 'digest']);
    expect(rows[1].kind === 'project' && rows[1].project.sessionCount).toBe(1);
  });

  it('改过项目目录的同一自动化:各项目里已折叠的运行收进目录后合成一个文件夹', () => {
    const nightly = (id: string, workingDir: string, at: string) => ({
      session: { id, title: 'Nightly', source: 'scheduler', workingDir, status: 'idle', agentKind: 'codex', deviceLinkDeviceId: 'mac' },
      scheduleInfo: { scheduleId: 'nightly', scheduleName: 'Nightly', running: false, unreadCount: 0 },
      title: 'Nightly',
      lastActivityAt: at,
      pendingInteractionCount: 0,
    }) as unknown as RemoteSessionListItem;
    // 上游(buildMobileHomePresentation)按项目分别折叠。
    const perProject = (dir: string, runs: RemoteSessionListItem[]) =>
      groupAutomationListItems(runs, Date.parse('2026-11-17T00:00:00Z'), true, () => dir);
    const home = presentation({
      projects: [
        projectGroup('old', '2026-11-10T00:00:00Z', perProject('old', [
          nightly('r1', '/old', '2026-11-09T00:00:00Z'),
          nightly('r2', '/old', '2026-11-10T00:00:00Z'),
        ])),
        projectGroup('new', '2026-11-16T00:00:00Z', perProject('new', [
          nightly('r3', '/new', '2026-11-15T00:00:00Z'),
          nightly('r4', '/new', '2026-11-16T00:00:00Z'),
        ])),
      ],
    });
    const rows = buildHomeSections(home, true, false, { groupAutomation: true, automationTitle: '自动化' })
      .find((section) => section.key === HOME_MAIN_SECTION_KEY)?.data ?? [];
    expect(rows).toHaveLength(1);
    const folder = rows[0];
    expect(folder.kind).toBe('automation');
    if (folder.kind !== 'automation') return;
    expect(folder.project.sessions).toHaveLength(1);
    expect([...(folder.project.sessions[0].automationGroup?.sessionIds ?? [])].sort()).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(folder.project.sessionCount).toBe(4);
  });

  it('跨项目合并按全局最近活动排列成员,较新的运行不会被折到后面', () => {
    const nightly = (id: string, workingDir: string, at: string) => ({
      session: { id, title: 'Nightly', source: 'scheduler', workingDir, updatedAt: at, status: 'active', agentKind: 'codex', deviceLinkDeviceId: 'mac' },
      scheduleInfo: { scheduleId: 'nightly', scheduleName: 'Nightly', running: false, unreadCount: 0 },
      title: 'Nightly',
      lastActivityAt: at,
      pendingInteractionCount: 0,
    }) as unknown as RemoteSessionListItem;
    const now = Date.parse('2026-11-20T00:00:00Z');
    const a = groupAutomationListItems([
      nightly('a17', '/a', '2026-11-17T00:00:00Z'),
      nightly('a06', '/a', '2026-11-06T00:00:00Z'),
    ], now, true, () => 'a');
    const b = groupAutomationListItems([
      nightly('b16', '/b', '2026-11-16T00:00:00Z'),
      nightly('b15', '/b', '2026-11-15T00:00:00Z'),
    ], now, true, () => 'b');
    const [merged] = mergeAutomationItems([...a, ...b], now);
    expect(merged.automationGroup?.items.map((item) => item.session.id)).toEqual(['a17', 'b16', 'b15', 'a06']);
  });

  it('旧伙伴例行任务专线随「自动化」收进目录;没有 routineId 的旧主机任务留在原位', () => {
    const routine = (id: string, routineId?: string) => ({
      session: { id, title: id, source: 'bot', companion: { id: 'cindy', role: 'routine', ...(routineId ? { routineId } : {}) } },
      title: id,
      lastActivityAt: '2026-11-16T00:00:00Z',
      pendingInteractionCount: 0,
    }) as unknown as RemoteSessionListItem;
    const home = presentation({
      projects: [projectGroup('buddy', '2026-11-16T00:00:00Z', [routine('review', 'memory'), routine('legacy')])],
    });
    const rows = buildHomeSections(home, true, false, { groupAutomation: true, automationTitle: '自动化' })
      .find((section) => section.key === HOME_MAIN_SECTION_KEY)?.data ?? [];
    const folder = rows.find((row) => row.kind === 'automation');
    expect(folder?.kind === 'automation' && folder.project.sessions.map((item) => item.session.id)).toEqual(['review']);
    const project = rows.find((row) => row.kind === 'project');
    expect(project?.kind === 'project' && project.project.sessions.map((item) => item.session.id)).toEqual(['legacy']);
  });

  it('同一伙伴同一 routineId 的旧例行运行折成一个子组', () => {
    const routineRun = (id: string, at: string) => ({
      session: { id, title: 'Review memory', source: 'bot', updatedAt: at, status: 'active', agentKind: 'codex', companion: { id: 'cindy', role: 'routine', routineId: 'memory' } },
      title: 'Review memory',
      lastActivityAt: at,
      pendingInteractionCount: 0,
    }) as unknown as RemoteSessionListItem;
    const grouped = groupAutomationListItems(
      [routineRun('m2', '2026-11-16T00:00:00Z'), routineRun('m1', '2026-11-15T00:00:00Z')],
      Date.parse('2026-11-17T00:00:00Z'),
    );
    expect(grouped).toHaveLength(1);
    expect(grouped[0].automationGroup?.baseKey).toBe('routine:cindy:memory');
    expect(grouped[0].automationGroup?.sessionIds).toEqual(['m2', 'm1']);
  });

  it('跨项目合并后换了代表运行,旧目录里等待确认的档位仍归到合并后的组', () => {
    const nightly = (id: string, workingDir: string, at: string, pending = 0) => ({
      session: { id, title: 'Nightly', source: 'scheduler', workingDir, updatedAt: at, status: 'idle', agentKind: 'codex', deviceLinkDeviceId: 'mac' },
      scheduleInfo: { scheduleId: 'nightly', scheduleName: 'Nightly', running: false, unreadCount: 0 },
      title: 'Nightly',
      lastActivityAt: at,
      pendingInteractionCount: pending,
    }) as unknown as RemoteSessionListItem;
    const now = Date.parse('2026-11-17T00:00:00Z');
    const oldGroup = groupAutomationListItems([
      nightly('r1', '/old', '2026-11-09T00:00:00Z', 1),
      nightly('r2', '/old', '2026-11-10T00:00:00Z'),
    ], now, true, () => 'old');
    const newGroup = groupAutomationListItems([
      nightly('r3', '/new', '2026-11-15T00:00:00Z'),
      nightly('r4', '/new', '2026-11-16T00:00:00Z'),
    ], now, true, () => 'new');
    const before = [...oldGroup, ...newGroup];
    // 合并前的上下文:只有旧目录组的代表在等待档。
    const ctx = {
      runningSessionIds: new Set<string>(),
      unreadSessionIds: new Set<string>(),
      waitingSessionIds: new Set(before.filter((item) => item.pendingInteractionCount > 0).map((item) => item.session.id)),
    };
    const [merged] = mergeAutomationItems(before, now);
    expect(ctx.waitingSessionIds.has(merged.session.id)).toBe(false);
    expect(withMergedAutomationPriority(ctx, [merged]).waitingSessionIds.has(merged.session.id)).toBe(true);
  });

  it('跨项目合并按成员各自档位取最优:旧目录完成未读 + 新目录运行中,整组仍在未读档', () => {
    const nightly = (id: string, workingDir: string, at: string) => ({
      session: { id, title: 'Nightly', source: 'scheduler', workingDir, updatedAt: at, status: 'idle', agentKind: 'codex', deviceLinkDeviceId: 'mac' },
      scheduleInfo: { scheduleId: 'nightly', scheduleName: 'Nightly', running: false, unreadCount: 0 },
      title: 'Nightly',
      lastActivityAt: at,
      pendingInteractionCount: 0,
    }) as unknown as RemoteSessionListItem;
    const now = Date.parse('2026-11-17T00:00:00Z');
    const runs = [nightly('r1', '/old', '2026-11-09T00:00:00Z'), nightly('r4', '/new', '2026-11-16T00:00:00Z')];
    const ctx = {
      runningSessionIds: new Set(['r4']),
      unreadSessionIds: new Set(['r1']),
      waitingSessionIds: new Set<string>(),
    };
    const [merged] = mergeAutomationItems(runs, now);
    expect(merged.session.id).toBe('r4');
    const next = withMergedAutomationPriority(ctx, [merged]);
    expect(next.unreadSessionIds.has('r4')).toBe(true);
    expect(next.runningSessionIds.has('r4')).toBe(false);
  });
});

describe('homeRowBefore(跨 section 邻接:分割线唯一化的 prevIsBlock 依据)', () => {
  // 分组模式:置顶区 + 按活动时间混排的主列表(首行是自动化组会话 —— 首页里以块呈现,自画顶线)。
  const automationChat = {
    session: { id: 'auto-1' },
    lastActivityAt: '2026-06-06T00:00:00Z',
    automationGroup: { key: 'grp-a' },
  } as unknown as RemoteSessionListItem;
  const home = presentation({
    pinned: [listItem('pin-1', '2026-06-03T00:00:00Z')],
    chats: [automationChat, listItem('c1', '2026-06-01T00:00:00Z')],
    projects: [
      projectGroup('proj-a', '2026-06-05T00:00:00Z', [listItem('s1', '2026-06-05T00:00:00Z')]),
      projectGroup('proj-b', '2026-06-04T00:00:00Z', [listItem('s2', '2026-06-04T00:00:00Z')]),
    ],
  });

  it('置顶区 → 主列表首行:跨区取到末位置顶会话', () => {
    const sections = buildHomeSections(home, true, false);
    const prev = homeRowBefore(sections, HOME_MAIN_SECTION_KEY, 0);
    expect(prev?.kind).toBe('session');
    expect(prev && prev.kind === 'session' ? prev.item.session.id : null).toBe('pin-1');
  });

  it('同区内仍取 index-1,不受跨区逻辑影响', () => {
    const sections = buildHomeSections(home, true, false);
    const prev = homeRowBefore(sections, HOME_MAIN_SECTION_KEY, 1);
    expect(prev?.kind).toBe('session');
    expect(prev && prev.kind === 'session' ? prev.item.session.id : null).toBe('auto-1');
  });

  it('置顶收起时 pinned 区 data 为空:跨区回溯要跳过空区', () => {
    const sections = buildHomeSections(home, true, true);
    const prev = homeRowBefore(sections, HOME_MAIN_SECTION_KEY, 0);
    expect(prev).toBeUndefined();
  });

  it('全列表首行与未知 section key 都返回 undefined', () => {
    const sections = buildHomeSections(home, true, false);
    expect(homeRowBefore(sections, 'pinned', 0)).toBeUndefined();
    expect(homeRowBefore(sections, 'nope', 0)).toBeUndefined();
  });
});

describe('buildMixedHomeRows / buildGroupedHomeRows', () => {
  const home = presentation({
    chats: [
      listItem('chat-new', '2026-06-06T00:00:00Z'),
      listItem('chat-old', '2026-06-01T00:00:00Z'),
    ],
    projects: [
      projectGroup('proj-new', '2026-06-05T00:00:00Z', [
        listItem('s1', '2026-06-05T00:00:00Z'),
        listItem('s2', '2026-06-04T00:00:00Z'),
      ]),
    ],
  });

  it('混排:项目下属会话展平为 session 行,按活动时间倒序', () => {
    const rows = buildMixedHomeRows(home);
    expect(rows.every((r) => r.kind === 'session')).toBe(true);
    expect(rows.map((r) => (r.kind === 'session' ? r.item.session.id : 'project'))).toEqual([
      'chat-new',
      's1',
      's2',
      'chat-old',
    ]);
  });

  it('分组:项目保留 folder 行,与普通对话按活动时间倒序混排', () => {
    const rows = buildGroupedHomeRows(home);
    expect(rows.map((row) => row.kind === 'session' ? row.item.session.id : row.project.key)).toEqual([
      'chat-new',
      'proj-new',
      'chat-old',
    ]);
  });

  it('对话归组:分组模式下对话收成 folder,平铺时项目会话仍展平', () => {
    const grouped = buildGroupedHomeRows(home, { groupDialogue: true, dialogueTitle: '对话' });
    expect(grouped.map((row) => row.kind === 'session' ? row.item.session.id : row.kind)).toEqual([
      'dialogue',
      'project',
    ]);
    const mixed = buildMixedHomeRows(home, { groupDialogue: true, dialogueTitle: '对话' });
    expect(mixed.map((row) => row.kind === 'session' ? row.item.session.id : row.kind)).toEqual([
      'dialogue',
      's1',
      's2',
    ]);
    expect(mixed.find((row) => row.kind === 'dialogue')?.project.title).toBe('对话');
  });

  it('手动项目顺序:项目行按存档序排在前面,对话仍按任务排序跟在后面', () => {
    const twoProjects = presentation({
      chats: [listItem('chat-new', '2026-06-09T00:00:00Z')],
      projects: [
        projectGroup('proj-old', '2026-06-01T00:00:00Z', [listItem('old', '2026-06-01T00:00:00Z')]),
        projectGroup('proj-new', '2026-06-08T00:00:00Z', [listItem('fresh', '2026-06-08T00:00:00Z')]),
      ],
    });
    const rows = buildGroupedHomeRows(twoProjects, {
      projectOrder: 'custom',
      manualProjectOrder: ['proj-old', 'proj-new'],
    });
    expect(rows.map((row) => row.kind === 'session' ? row.item.session.id : row.project.key)).toEqual([
      'proj-old',
      'proj-new',
      'chat-new',
    ]);
  });

  it('平铺时给项目会话和对话会话带来源标签,分组模式不带', () => {
    const mixed = buildMixedHomeRows(home, { dialogueTitle: '对话' });
    expect(mixed.filter((row): row is Extract<typeof row, { kind: 'session' }> => row.kind === 'session')
      .map((row) => [row.item.session.id, row.sourceLabel])).toEqual([
      ['chat-new', '对话'],
      ['s1', undefined],
      ['s2', undefined],
      ['chat-old', '对话'],
    ]);
    // project.title 来自 fixture 里缺省的 undefined —— 上面只断言对话标签。补一个带 title 的项目。
    const named = presentation({
      chats: [listItem('chat-new', '2026-06-06T00:00:00Z')],
      projects: [{
        ...projectGroup('proj-new', '2026-06-05T00:00:00Z', [listItem('s1', '2026-06-05T00:00:00Z')]),
        title: 'Cindy',
      }],
    });
    const namedMixed = buildMixedHomeRows(named, { dialogueTitle: '对话' });
    expect(namedMixed.map((row) => row.kind === 'session' ? [row.item.session.id, row.sourceLabel] : row.kind)).toEqual([
      ['chat-new', '对话'],
      ['s1', 'Cindy'],
    ]);
    const grouped = buildGroupedHomeRows(named, { dialogueTitle: '对话' });
    expect(grouped.filter((row) => row.kind === 'session').map((row) => row.kind === 'session' ? row.sourceLabel : null))
      .toEqual([undefined]);
  });

  it('优先级:等你处理 > 完成未读 > 运行中 > 其余,同档按时间', () => {
    const waiting = listItem('wait', '2026-06-01T00:00:00Z');
    const unread = listItem('unread', '2026-06-04T00:00:00Z');
    const running = listItem('run', '2026-06-03T00:00:00Z');
    const rest = listItem('rest', '2026-06-05T00:00:00Z');
    const ranked = presentation({
      chats: [rest, unread],
      projects: [projectGroup('proj', '2026-06-03T00:00:00Z', [waiting, running])],
    });
    const rows = buildMixedHomeRows(ranked, {
      sortBy: 'priority',
      priorityContext: {
        runningSessionIds: new Set(['run']),
        unreadSessionIds: new Set(['unread']),
        waitingSessionIds: new Set(['wait']),
      },
    });
    expect(rows.map((row) => row.kind === 'session' ? row.item.session.id : row.kind)).toEqual([
      'wait',
      'unread',
      'run',
      'rest',
    ]);
  });

  it('活动时间相同时按 row key 稳定排序,不受上游输入顺序影响', () => {
    const activityAt = '2026-06-07T00:00:00Z';
    const forward = presentation({
      chats: [listItem('chat-z', activityAt), listItem('chat-a', activityAt)],
      projects: [
        projectGroup('project-z', activityAt, [listItem('session-z', activityAt)]),
        projectGroup('project-a', activityAt, [listItem('session-a', activityAt)]),
      ],
    });
    const reversed = presentation({
      chats: [...forward.chats].reverse(),
      projects: [...forward.projects].reverse(),
    });

    for (const buildRows of [buildMixedHomeRows, buildGroupedHomeRows]) {
      const forwardKeys = buildRows(forward).map((row) => row.key);
      const reversedKeys = buildRows(reversed).map((row) => row.key);
      expect(forwardKeys).toEqual([...forwardKeys].sort((a, b) => a.localeCompare(b)));
      expect(reversedKeys).toEqual(forwardKeys);
    }
  });
});

// Unit: real home projection must retain pins/Make tasks and split active runs from waiting work.
it('builds inbox sections and recomputes snooze expiry without losing collapsed counts', () => {
  const now = Date.parse('2026-11-12T08:00:00Z');
  const idle = listItem('idle', new Date(now).toISOString());
  const running = listItem('run', new Date(now).toISOString());
  const waiting = listItem('wait', new Date(now).toISOString());
  waiting.pendingInteractionCount = 1;
  const later = listItem('later', new Date(now).toISOString());
  later.session.snoozedUntil = new Date(now + 3600000).toISOString();
  const done = listItem('done', new Date(now).toISOString());
  done.session.status = 'archived';
  const home = presentation({ pinned: [listItem('pin', '')], chats: [idle, running, waiting, later, done], projects: [
    { ...projectGroup('make', '', [listItem('make-task', '')]), kind: 'cindy-make' },
  ] });
  const signals = { runningSessionIds: new Set(['run', 'wait']), waitingSessionIds: new Set(['wait']), unreadSessionIds: new Set<string>() };
  const sections = buildInboxHomeSections(home, new Set(['inbox-working']), signals, now);
  expect(sections.map(s => s.key)).toEqual(['inbox-inbox', 'inbox-working', 'inbox-snoozed', 'inbox-archived']);
  const combined = [...buildHomeSections(home, true, false), ...sections];
  expect(combined.map(s => s.key)).toEqual(['pinned', 'main', 'inbox-inbox', 'inbox-working', 'inbox-snoozed', 'inbox-archived']);
  expect(combined.find(s => s.key === 'pinned')?.data).toHaveLength(1);
  expect(sections.find(s => s.key === 'inbox-inbox')?.count).toBe(3);
  expect(sections.find(s => s.key === 'inbox-working')).toMatchObject({ count: 1, data: [] });
  expect(sections.find(s => s.key === 'inbox-snoozed')?.count).toBe(1);
  expect(sections.find(s => s.key === 'inbox-archived')?.count).toBe(1);
  expect(buildInboxHomeSections(home, new Set(), signals, now + 3600000).find(s => s.key === 'inbox-inbox')?.count).toBe(4);
});

// 2026-11-18 user decision: teammates' routine results filled the phone's inbox. Teammate tasks
// (by the teammate filter's test) are listed only while they need the user or run.
it('leaves idle teammate tasks out of the inbox until they need the user or run', () => {
  const routine = listItem('routine', '2026-11-18T08:00:00Z');
  (routine.session as { source?: string; companion?: object }).source = 'bot';
  (routine.session as { companion?: object }).companion = { id: 'bot-1', role: 'routine' };
  const opened = listItem('opened', '2026-11-18T08:00:00Z');
  (opened.session as { taskTeammate?: object }).taskTeammate = { id: 'bot-1', name: 'Mate' };
  const mine = listItem('mine', '2026-11-18T08:00:00Z');
  const home = presentation({ chats: [routine, opened, mine] });
  const signals = { runningSessionIds: new Set<string>(), waitingSessionIds: new Set<string>(),
    unreadSessionIds: new Set(['routine', 'opened', 'mine']) };
  const ids = (key: string) => buildInboxHomeSections(home, new Set(), signals, Date.now())
    .find(s => s.key === key)!.data.flatMap(row => row.kind === 'session' ? [row.item.session.id] : []);
  expect(ids('inbox-inbox')).toEqual(['mine']);
  expect(ids('inbox-working')).toEqual([]);
  routine.pendingInteractionCount = 1;
  signals.runningSessionIds.add('opened');
  expect(ids('inbox-inbox').sort()).toEqual(['mine', 'routine']);
  expect(ids('inbox-working')).toEqual(['opened']);
});

it('puts a quiet followed task in working and returns it to inbox for results, waiting or pause', () => {
  const item = listItem('followed', '2026-11-13T08:00:00Z');
  item.scheduleInfo = { scheduleId: 'schedule', scheduleName: 'Follow', hasActiveFollowUp: true,
    running: false, latestRunAt: 0, unreadRunIds: [], unreadCount: 0 };
  const home = presentation({ chats: [item] });
  const signals = { runningSessionIds: new Set<string>(), waitingSessionIds: new Set<string>(), unreadSessionIds: new Set<string>() };
  const workingCount = () => buildInboxHomeSections(home, new Set(), signals, Date.now()).find(s => s.key === 'inbox-working')?.count;
  expect(workingCount()).toBe(1);
  item.pendingInteractionCount = 1;
  expect(workingCount()).toBe(0);
  item.pendingInteractionCount = 0;
  // A finished round with a result for the user goes back to inbox even while followed.
  item.scheduleInfo.unreadRunIds = ['run-1'];
  item.scheduleInfo.unreadCount = 1;
  signals.unreadSessionIds.add('followed');
  expect(workingCount()).toBe(0);
  // Opening it clears unread, but the viewed task keeps its section until the user leaves.
  signals.unreadSessionIds.clear();
  item.scheduleInfo.unreadRunIds = [];
  item.scheduleInfo.unreadCount = 0;
  expect(buildInboxHomeSections(home, new Set(), { ...signals, heldPriorityRanks: new Map([['followed', 1]]) },
    Date.now()).find(s => s.key === 'inbox-working')?.count).toBe(0);
  expect(workingCount()).toBe(1);
  item.scheduleInfo.hasActiveFollowUp = false;
  expect(workingCount()).toBe(0);
});

// Bug 2026-11-18: a task that finished while open kept its held running rank and stayed in
// working until another task was opened.
it('moves a task that finished while open to inbox right away, keeping held unread in place', () => {
  const item = listItem('open', '2026-11-18T08:00:00Z');
  const home = presentation({ chats: [item] });
  const section = (ctx: Parameters<typeof buildInboxHomeSections>[2]) =>
    buildInboxHomeSections(home, new Set(), ctx, Date.now()).find(s => s.count === 1)?.key;
  const idle = { runningSessionIds: new Set<string>(), waitingSessionIds: new Set<string>(), unreadSessionIds: new Set<string>() };
  expect(section({ ...idle, runningSessionIds: new Set(['open']), heldPriorityRanks: new Map([['open', 2]]) })).toBe('inbox-working');
  expect(section({ ...idle, heldPriorityRanks: new Map([['open', 2]]) })).toBe('inbox-inbox');
});

// PR #10685, unit: production collector and inbox builder must unpack automation
// members before deciding each run's section. Earlier tests never mixed a waiting
// old run with an idle/running/followed representative, so group signals leaked.
it.each(['chat', 'project'] as const)('keeps each %s automation run independent of aggregate signals', source => {
  const now = Date.parse('2026-11-18T09:00:00Z');
  const make = (id: string, at: string) => ({
    ...listItem(id, at),
    session: { id, source: 'scheduler', status: 'active', updatedAt: at,
      taskTeammate: { id: 'mate', name: 'Mate' } },
    scheduleInfo: { scheduleId: 's', scheduleName: 'Routine', running: false,
      latestRunAt: 0, unreadCount: 0, unreadRunIds: [] },
  }) as unknown as RemoteSessionListItem;
  for (const mode of ['idle', 'running', 'followed', 'unread'] as const) {
    const latest = make('latest', '2026-11-18T08:00:00Z');
    const older = make('older', '2026-11-18T07:00:00Z');
    older.pendingInteractionCount = mode === 'unread' ? 0 : 1;
    if (mode === 'unread') {
      older.scheduleInfo!.unreadRunIds = ['old-run'];
      older.scheduleInfo!.unreadCount = 1;
    }
    if (mode === 'followed' || mode === 'unread') {
      latest.scheduleInfo!.hasActiveFollowUp = true;
      delete (latest.session as { taskTeammate?: unknown }).taskTeammate;
    }
    const grouped = groupAutomationListItems([latest, older], now, true, () => 'mac');
    expect(grouped).toHaveLength(1);
    expect(grouped[0].session.id).toBe('latest');
    const home = source === 'chat' ? presentation({ chats: grouped })
      : presentation({ projects: [projectGroup('p', latest.lastActivityAt, grouped)] });
    const running = new Set(mode === 'running' ? ['latest'] : []);
    const hold = { heldPriorityRanks: new Map<string, number>(), recentlyViewedAtMs: new Map<string, number>() };
    // Pass the ordinary list's aggregate context too: inbox must not trust its sets.
    const aggregate = collectHomePriorityContext(grouped, running, hold);
    const own = collectInboxHomePriorityContext(grouped, running, hold);
    expect(own.waitingSessionIds.has('latest')).toBe(false);
    expect(own.unreadSessionIds.has('latest')).toBe(false);
    const sections = buildInboxHomeSections(home, new Set(), aggregate, now);
    const ids = (key: string) => sections.find(section => section.key === key)!.data
      .flatMap(row => row.kind === 'session' ? [row.item.session.id] : []);
    expect(ids('inbox-inbox')).toEqual(mode === 'unread' ? [] : ['older']);
    expect(ids('inbox-working')).toEqual(mode === 'idle' ? [] : ['latest']);
  }
});
