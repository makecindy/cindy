import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
  buildSessionMessagePreviewIndex,
  buildRemoteSessionListContext,
  buildRemoteSessionCardPreview,
  buildRemoteSessionSections,
  buildSessionScheduleIndex,
  deviceSessionEmptyState,
  formatRemoteSessionSidebarTime,
  remoteSessionControlsSummary,
  remoteSessionFilterLabel,
  remoteSessionOverviewCopy,
  sessionRowMessagePreview,
  summarizeRemoteSessionOverview,
  toRemoteSessionListItem,
} from '@/session/sessionList';
import type { RemoteSchedule, RemoteScheduleRun } from '@/scheduler/types';
import type { RemoteMessage, RemoteSession } from '@/session/types';

function session(id: string, patch: Partial<RemoteSession> = {}): RemoteSession {
  return {
    id,
    userId: 'user-1',
    title: id,
    workingDir: '/repo/app',
    workspaceKind: 'project',
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    permissionMode: 'ask',
    fastMode: false,
    status: 'active',
    agentKind: 'cc',
    pinnedAt: null,
    userSendAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

function schedule(id: string, patch: Partial<RemoteSchedule> = {}): RemoteSchedule {
  return {
    id,
    name: id,
    status: 'active',
    updatedAt: Date.parse('2026-01-01T00:00:00.000Z'),
    ...patch,
  };
}

function run(id: string, scheduleId: string, patch: Partial<RemoteScheduleRun> = {}): RemoteScheduleRun {
  return {
    id,
    scheduleId,
    sessionId: patch.sessionId ?? 's1',
    status: 'success',
    firedAt: Date.parse('2026-01-01T00:05:00.000Z'),
    ...patch,
  };
}

function message(sessionId: string, id: string, role: RemoteMessage['role'], content: unknown, createdAt: string): RemoteMessage {
  return {
    id,
    clientId: id,
    sessionId,
    role,
    content,
    toolUseId: null,
    agentMeta: null,
    createdAt,
  };
}

describe('sessionList', () => {
  it('groups pinned, dialogue, and project sessions without duplicating pinned rows', () => {
    const sections = buildRemoteSessionSections([
      session('project-old', { updatedAt: '2026-01-01T00:01:00.000Z' }),
      session('dialogue', { workspaceKind: 'dialogue', workingDir: null }),
      session('pinned', { pinnedAt: '2026-01-01T00:03:00.000Z', workingDir: '/repo/other' }),
      session('project-new', { updatedAt: '2026-01-01T00:02:00.000Z' }),
    ], new Date('2026-01-01T00:10:00.000Z').getTime());

    expect(sections.map((section) => [section.key, section.title, section.data.map((item) => item.session.id)])).toEqual([
      ['pinned', '置顶', ['pinned']],
      ['dialogue', '对话', ['dialogue']],
      ['project:/repo/app', 'app', ['project-new', 'project-old']],
    ]);
  });

  it('builds compact display metadata for a session row', () => {
    const item = toRemoteSessionListItem(session('s1', {
      title: '',
      workingDir: null,
      workspaceKind: 'dialogue',
      agentKind: 'codex',
      model: 'gpt-5.4',
      userSendAt: '2026-01-01T00:05:00.000Z',
      _count: { messages: 12 },
    }), new Date('2026-01-01T00:10:00.000Z').getTime());

    expect(item).toMatchObject({
      title: '未命名任务',
      subtitle: 'Codex · gpt-5.4 · dialogue',
      detail: '活跃 · 5 分钟前 · 12 条消息',
      messagePreview: null,
      lastActivityAt: '2026-01-01T00:05:00.000Z',
    });
  });

  it('formats sidebar activity time with desktop sidebar density', () => {
    const now = new Date('2026-01-01T12:00:00.000Z').getTime();

    expect(formatRemoteSessionSidebarTime('2026-01-01T11:59:30.000Z', now)).toBe('刚刚');
    expect(formatRemoteSessionSidebarTime('2026-01-01T11:55:00.000Z', now)).toBe('5 分钟');
    expect(formatRemoteSessionSidebarTime('2026-01-01T09:00:00.000Z', now)).toBe('3 小时');
    expect(formatRemoteSessionSidebarTime('2025-12-30T12:00:00.000Z', now)).toBe('2 天');
  });

  it('includes the latest message preview in rendered session rows', () => {
    const sections = buildRemoteSessionSections([
      session('s1', { title: 'Implement mobile polish' }),
    ], new Date('2026-01-01T00:10:00.000Z').getTime(), {
      messagePreviewIndex: new Map([['s1', '最近一条用户消息']]),
    });

    expect(sections[0].data[0]).toMatchObject({
      title: 'Implement mobile polish',
      messagePreview: '最近一条用户消息',
    });
  });

  it('builds home card previews: running shows running/automation text, otherwise latest message', () => {
    const base = toRemoteSessionListItem(session('base', {
      preview: '任务摘要',
      lastMessagePreview: '最近消息',
    } as Partial<RemoteSession>), Date.now(), undefined, 0, '索引消息');

    // 非运行态:显示最近消息预览(纯字符串契约,与 maker-shared 一致)。
    expect(buildRemoteSessionCardPreview(base)).toBe('索引消息');
    // 运行态:显示「运行中」。
    expect(buildRemoteSessionCardPreview(base, { running: true })).toBe('运行中');
    // 运行态 + 自动化:显示「自动化执行中」。
    expect(buildRemoteSessionCardPreview({
      ...base,
      scheduleInfo: { scheduleId: 's', scheduleName: '巡检', unreadRunIds: [], unreadCount: 0, running: true, latestRunAt: 0 },
    }, { running: true })).toBe('自动化执行中');
  });

  it('shows the device-link preview on idle rows, null when the session has no message', () => {
    // 首页未打开的会话消息未 load,改由 device-link 会话列表带的 session.preview(桌面产出),
    // 经 sessionRowMessagePreview 流入 item.messagePreview;真正零消息会话则留空。
    const empty = toRemoteSessionListItem(session('empty', { title: '打招呼' }), Date.now(), undefined, 0, null);
    expect(buildRemoteSessionCardPreview(empty)).toBeNull();

    const withPreview = session('greet', { title: '打招呼', preview: '你好，帮我看下登录失败' });
    expect(sessionRowMessagePreview(withPreview)).toBe('你好，帮我看下登录失败');
    const item = toRemoteSessionListItem(withPreview, Date.now(), undefined, 0, sessionRowMessagePreview(withPreview));
    expect(buildRemoteSessionCardPreview(item)).toBe('你好，帮我看下登录失败');
  });

  it('shows and searches collaboration roles in session rows', () => {
    const lead = session('lead', { orcaRole: 'lead', title: 'Lead Session' });
    const worker = session('worker', { orcaRole: 'worker', title: 'Worker Session' });

    expect(toRemoteSessionListItem(lead).subtitle).toContain('协作 Lead');
    expect(toRemoteSessionListItem(worker).subtitle).toContain('协作 Worker');

    const sections = buildRemoteSessionSections([lead, worker], Date.now(), {
      searchQuery: 'worker',
    });
    expect(sections.flatMap((section) => section.data.map((item) => item.session.id))).toEqual([
      'worker',
    ]);
  });

  it('adds automation schedule binding and unread metadata to session rows', () => {
    const index = buildSessionScheduleIndex([
      schedule('sched-1', { name: '移动端巡检' }),
    ], new Map([
      ['sched-1', [
        run('run-1', 'sched-1', { sessionId: 's1', readAt: undefined }),
        run('run-2', 'sched-1', {
          sessionId: 's1',
          status: 'running',
          firedAt: Date.parse('2026-01-01T00:06:00.000Z'),
        }),
      ]],
    ]));

    const item = toRemoteSessionListItem(session('s1', {
      source: 'scheduler',
      title: '[Schedule] Legacy title',
    }), new Date('2026-01-01T00:10:00.000Z').getTime(), index);

    expect(item).toMatchObject({
      title: 'Legacy title',
      subtitle: 'Claude Code · claude-sonnet-4-6',
      detail: '活跃 · 10 分钟前 · 自动化执行中 · 1 个自动化未读',
    });
    expect(item.scheduleInfo).toMatchObject({
      scheduleId: 'sched-1',
      scheduleName: '移动端巡检',
      unreadRunIds: ['run-1'],
      unreadCount: 1,
      running: true,
    });
  });

  it('groups multiple automation-generated sessions from the same schedule', () => {
    const now = new Date('2026-01-01T00:10:00.000Z').getTime();
    const scheduleIndex = buildSessionScheduleIndex([
      schedule('sched-1', { name: '移动端巡检' }),
    ], new Map([
      ['sched-1', [
        run('run-1', 'sched-1', {
          sessionId: 'old',
          readAt: undefined,
          firedAt: Date.parse('2026-01-01T00:02:00.000Z'),
        }),
        run('run-2', 'sched-1', {
          sessionId: 'running',
          status: 'running',
          firedAt: Date.parse('2026-01-01T00:06:00.000Z'),
        }),
      ]],
    ]));

    const sections = buildRemoteSessionSections([
      session('old', {
        source: 'scheduler',
        title: '[Schedule] Old run',
        updatedAt: '2026-01-01T00:02:00.000Z',
      }),
      session('running', {
        source: 'scheduler',
        title: '[Schedule] Running run',
        updatedAt: '2026-01-01T00:06:00.000Z',
      }),
      session('normal', { title: 'Normal', updatedAt: '2026-01-01T00:04:00.000Z' }),
    ], now, { scheduleIndex });

    const rows = sections.flatMap((section) => section.data);
    const group = rows.find((item) => item.automationGroup);
    expect(group).toMatchObject({
      title: '移动端巡检',
      subtitle: '自动化 · 2 个任务 · Claude Code · claude-sonnet-4-6',
      detail: '2 个任务 · 4 分钟前 · 自动化执行中 · 1 个自动化未读',
      automationGroup: {
        key: 'schedule:sched-1',
        sessionIds: ['running', 'old'],
        sessionCount: 2,
        primarySessionId: 'running',
      },
      scheduleInfo: {
        unreadRunIds: ['run-1'],
        unreadCount: 1,
        running: true,
      },
    });
    expect(group?.automationGroup?.children.map((child) => ({
      sessionId: child.sessionId,
      running: child.running,
      unreadCount: child.unreadCount,
    }))).toEqual([
      { sessionId: 'running', running: true, unreadCount: 0 },
      { sessionId: 'old', running: false, unreadCount: 1 },
    ]);
    expect(rows.map((item) => item.automationGroup?.key ?? item.session.id)).toEqual([
      'schedule:sched-1',
      'normal',
    ]);
  });

  it('shows legacy scheduled sessions even before run metadata is loaded', () => {
    const item = toRemoteSessionListItem(session('s1', {
      title: '[Schedule] Daily Report',
    }));

    expect(item.title).toBe('Daily Report');
    expect(item.scheduleInfo).toMatchObject({
      scheduleId: '',
      scheduleName: 'Daily Report',
      unreadCount: 0,
      running: false,
    });
  });

  it('marks Orca collaboration sessions without changing normal grouping', () => {
    const item = toRemoteSessionListItem(session('lead', {
      orcaRole: 'lead',
      title: 'Plan with workers',
    }), new Date('2026-01-01T00:10:00.000Z').getTime());

    expect(item.subtitle).toBe('协作 Lead · Claude Code · claude-sonnet-4-6');

    const sections = buildRemoteSessionSections([
      session('normal'),
      session('worker', { orcaRole: 'worker', title: 'Worker reply' }),
    ], Date.now(), { searchQuery: 'worker' });

    expect(sections.flatMap((section) => section.data.map((row) => row.session.id))).toEqual(['worker']);
  });

  it('marks existing worktree sessions without adding remote worktree creation semantics', () => {
    const item = toRemoteSessionListItem(session('wt', {
      worktreePath: '/repo/app/.xdt-worktrees/feat-mobile',
    }), new Date('2026-01-01T00:10:00.000Z').getTime());

    expect(item).toMatchObject({
      subtitle: 'Worktree feat-mobile · Claude Code · claude-sonnet-4-6',
      worktreeLabel: 'Worktree feat-mobile',
    });

    const sections = buildRemoteSessionSections([
      session('normal'),
      session('wt', { worktreePath: '/repo/app/.xdt-worktrees/feat-mobile' }),
    ], Date.now(), { searchQuery: 'feat-mobile' });

    expect(sections.flatMap((section) => section.data.map((row) => row.session.id))).toEqual(['wt']);
  });

  it('filters by status before building sections', () => {
    const sections = buildRemoteSessionSections([
      session('active'),
      session('archived', { status: 'archived', workingDir: '/repo/archive' }),
      session('deleted', { status: 'deleted', workingDir: '/repo/deleted' }),
    ], new Date('2026-01-01T00:10:00.000Z').getTime(), {
      statusFilter: 'all',
    });

    expect(sections.flatMap((section) => section.data.map((item) => item.session.id))).toEqual([
      'active',
      'archived',
    ]);

    const archivedOnly = buildRemoteSessionSections([
      session('active'),
      session('archived', { status: 'archived', workingDir: '/repo/archive' }),
    ], new Date('2026-01-01T00:10:00.000Z').getTime(), {
      statusFilter: 'archived',
    });

    expect(archivedOnly.flatMap((section) => section.data.map((item) => item.session.id))).toEqual(['archived']);
  });

  it('filters waiting and automation sessions from explicit mobile indexes', () => {
    const scheduleIndex = buildSessionScheduleIndex([
      schedule('sched-1', { name: '夜间巡检' }),
    ], new Map([
      ['sched-1', [run('run-1', 'sched-1', { sessionId: 'scheduled' })]],
    ]));
    const pendingInteractionIndex = new Map([
      ['waiting', 2],
      ['scheduled-waiting', 1],
    ]);
    const sessions = [
      session('normal'),
      session('waiting', { workingDir: '/repo/waiting' }),
      session('scheduled', { workingDir: '/repo/scheduled' }),
      session('scheduled-waiting', { source: 'scheduler', title: '[Schedule] Deploy', workingDir: '/repo/deploy' }),
      session('deleted-waiting', { status: 'deleted', workingDir: '/repo/deleted' }),
    ];

    const waitingRows = buildRemoteSessionSections(sessions, Date.now(), {
      pendingInteractionIndex,
      scheduleIndex,
      statusFilter: 'waiting',
    }).flatMap((section) => section.data);
    expect(waitingRows.map((item) => [item.session.id, item.pendingInteractionCount]).sort()).toEqual([
      ['scheduled-waiting', 1],
      ['waiting', 2],
    ]);
    expect(waitingRows.find((item) => item.session.id === 'waiting')?.detail).toContain('等待处理 2 个');
    expect(waitingRows.find((item) => item.session.id === 'scheduled-waiting')?.detail).toContain('等待处理 1 个');

    const automationRows = buildRemoteSessionSections(sessions, Date.now(), {
      pendingInteractionIndex,
      scheduleIndex,
      statusFilter: 'automation',
    }).flatMap((section) => section.data);
    const represented = automationRows.flatMap((item) => item.automationGroup?.sessionIds ?? [item.session.id]);
    expect(represented.sort()).toEqual(['scheduled', 'scheduled-waiting']);
  });

  it('summarizes the mobile device-detail overview from current mirrored sessions', () => {
    const scheduleIndex = buildSessionScheduleIndex([
      schedule('sched-1', { name: '夜间巡检' }),
    ], new Map([
      ['sched-1', [
        run('run-1', 'sched-1', {
          sessionId: 'scheduled',
          status: 'running',
          readAt: undefined,
        }),
      ]],
    ]));
    const overview = summarizeRemoteSessionOverview([
      session('active', { pinnedAt: '2026-01-01T00:01:00.000Z', workingDir: '/repo/app' }),
      session('waiting', { workingDir: '/repo/app' }),
      session('scheduled', { workingDir: '/repo/ops' }),
      session('legacy-scheduled', { title: '[Schedule] Legacy', workingDir: null }),
      session('archived', { status: 'archived', workingDir: '/repo/archive' }),
      session('deleted', { status: 'deleted', workingDir: '/repo/deleted' }),
    ], new Map([
      ['waiting', 2],
    ]), scheduleIndex);

    expect(overview).toEqual({
      active: 4,
      all: 5,
      archived: 1,
      automation: 2,
      pinned: 1,
      projectCount: 3,
      runningAutomation: 1,
      waiting: 1,
    });
    expect(remoteSessionFilterLabel('waiting', overview)).toBe('待处理 1');
    expect(remoteSessionFilterLabel('all', overview)).toBe('全部 5');
    expect(remoteSessionControlsSummary('automation', overview)).toBe('自动化 2 · 项目分组');
    expect(remoteSessionOverviewCopy(overview)).toBe('1 个置顶 · 3 个项目 · 1 个自动化执行中');
  });

  it('builds mobile list context for search and grouped automation rows', () => {
    const now = new Date('2026-01-01T00:10:00.000Z').getTime();
    const activeSessions = [
      session('billing', { title: 'Billing regression', workingDir: '/repo/billing' }),
      session('mobile', { title: 'Mobile polish', workingDir: '/repo/mobile' }),
    ];
    const activeOverview = summarizeRemoteSessionOverview(activeSessions, new Map(), new Map());
    const searchSections = buildRemoteSessionSections(activeSessions, now, {
      searchQuery: 'billing',
      statusFilter: 'active',
    });

    expect(buildRemoteSessionListContext({
      overview: activeOverview,
      searchQuery: 'billing',
      sections: searchSections,
      statusFilter: 'active',
    })).toMatchObject({
      title: '搜索结果',
      detail: '1 个匹配任务 · 活跃 2 · 项目分组',
      hint: '搜索范围包含标题、项目路径、模型、自动化名称和消息预览。',
      resultCount: 1,
      rowCount: 1,
    });

    const scheduleIndex = buildSessionScheduleIndex([
      schedule('sched-1', { name: '移动端巡检' }),
    ], new Map([
      ['sched-1', [
        run('run-1', 'sched-1', { sessionId: 'run-a' }),
        run('run-2', 'sched-1', { sessionId: 'run-b' }),
      ]],
    ]));
    const automationSessions = [
      session('run-a', { source: 'scheduler', title: '[Schedule] Run A' }),
      session('run-b', { source: 'scheduler', title: '[Schedule] Run B' }),
    ];
    const automationOverview = summarizeRemoteSessionOverview(automationSessions, new Map(), scheduleIndex);
    const automationSections = buildRemoteSessionSections(automationSessions, now, {
      scheduleIndex,
      statusFilter: 'automation',
    });

    expect(buildRemoteSessionListContext({
      overview: automationOverview,
      searchQuery: '',
      sections: automationSections,
      statusFilter: 'automation',
    })).toMatchObject({
      title: '自动化生成的任务',
      detail: '2 个任务 · 1 行 · 自动化 2 · 项目分组',
      hint: '自动化生成的任务会按计划聚合，展开后可以进入单次运行。',
      resultCount: 2,
      rowCount: 1,
    });
  });

  it('keeps mobile device-detail empty states specific to search and filters', () => {
    expect(deviceSessionEmptyState('active', 'billing')).toMatchObject({
      title: '没有匹配的任务',
    });
    expect(deviceSessionEmptyState('waiting', '')).toMatchObject({
      title: '没有待处理请求',
    });
    expect(deviceSessionEmptyState('automation', '')).toMatchObject({
      title: '没有自动化生成的任务',
    });
    expect(deviceSessionEmptyState('archived', '')).toMatchObject({
      title: '没有归档任务',
    });
    expect(deviceSessionEmptyState('active', '')).toMatchObject({
      title: '这台电脑暂无活动任务',
    });
  });

  it('searches title, project path, model, agent kind, status, and message previews', () => {
    const sessions = [
      session('title-hit', { title: 'Release audit', workingDir: '/repo/app' }),
      session('path-hit', { title: 'Other', workingDir: '/repo/mobile-control' }),
      session('model-hit', { title: 'Other', workingDir: '/repo/model', model: 'gpt-5.4' }),
      session('message-hit', { title: 'Other', workingDir: '/repo/messages' }),
      session('row-preview-hit', {
        title: 'Other',
        workingDir: '/repo/row-preview',
        lastMessagePreview: 'Latest desktop row preview mentions billing',
      } as Partial<RemoteSession>),
      session('miss', { title: 'Other', workingDir: '/repo/other' }),
    ];
    const messagePreviewIndex = buildSessionMessagePreviewIndex(
      sessions.map((item) => item.id),
      (sessionId) => sessionId === 'message-hit'
        ? [
            message(sessionId, 'm1', 'tool_use', { toolName: 'Bash', input: 'billing command should be ignored' }, '2026-01-01T00:01:00.000Z'),
            message(sessionId, 'm2', 'assistant', 'Use the mobile checkout handoff path.', '2026-01-01T00:02:00.000Z'),
          ]
        : [],
    );

    expect(buildRemoteSessionSections(sessions, Date.now(), { searchQuery: 'mobile' })
      .flatMap((section) => section.data.map((item) => item.session.id))).toEqual(['path-hit']);
    expect(buildRemoteSessionSections(sessions, Date.now(), { searchQuery: 'gpt-5' })
      .flatMap((section) => section.data.map((item) => item.session.id))).toEqual(['model-hit']);
    expect(buildRemoteSessionSections(sessions, Date.now(), { searchQuery: 'release' })
      .flatMap((section) => section.data.map((item) => item.session.id))).toEqual(['title-hit']);
    expect(buildRemoteSessionSections(sessions, Date.now(), { messagePreviewIndex, searchQuery: 'checkout handoff' })
      .flatMap((section) => section.data.map((item) => item.session.id))).toEqual(['message-hit']);
    expect(buildRemoteSessionSections(sessions, Date.now(), { messagePreviewIndex, searchQuery: 'billing' })
      .flatMap((section) => section.data.map((item) => item.session.id))).toEqual(['row-preview-hit']);

    const scheduleIndex = buildSessionScheduleIndex([
      schedule('sched-1', { name: '移动端巡检' }),
    ], new Map([
      ['sched-1', [run('run-1', 'sched-1', { sessionId: 'automation-hit' })]],
    ]));
    expect(buildRemoteSessionSections([
      session('automation-hit', { title: 'Other', source: 'scheduler' }),
      session('automation-miss', { title: 'Other' }),
    ], Date.now(), { scheduleIndex, searchQuery: '巡检' })
      .flatMap((section) => section.data.map((item) => item.session.id))).toEqual(['automation-hit']);
  });

  it('summarizes structured media messages without leaking raw JSON into session rows', () => {
    const messagePreviewIndex = buildSessionMessagePreviewIndex(['media-session'], (sessionId) => [
      message(sessionId, 'm1', 'user', {
        text: 'Mock image fixture',
        images: [{ name: 'mock-image-fixture.png', originalName: 'Mock image fixture' }],
      }, '2026-01-01T00:01:00.000Z'),
    ]);

    expect(messagePreviewIndex.get('media-session')).toBe('Mock image fixture · 图片 mock-image-fixture.png');
    expect(messagePreviewIndex.get('media-session')).not.toContain('{');

    const sections = buildRemoteSessionSections([
      session('media-session', {
        lastMessagePreview: JSON.stringify({
          text: 'Mock image fixture',
          images: [{ name: 'mock-image-fixture.png', originalName: 'Mock image fixture' }],
        }),
      } as Partial<RemoteSession>),
    ]);
    expect(sections[0].data[0].messagePreview).toBe('Mock image fixture · 图片 mock-image-fixture.png');
    expect(sections[0].data[0].messagePreview).not.toContain('{');
  });

  it('builds sections for a 1000-session remote device without duplicate rendered rows', () => {
    const now = new Date('2026-01-08T12:00:00.000Z').getTime();
    const sessions = createLargeSessionFixture(1000);
    const scheduleIndex = buildSessionScheduleIndex(
      [schedule('sched-0', { name: '每日巡检' }), schedule('sched-1', { name: '每周复盘' })],
      new Map([
        ['sched-0', sessions
          .filter((item) => item.source === 'scheduler' && Number(item.id.split('-').at(-1)) % 80 === 0)
          .map((item, index) => run(`run-daily-${index}`, 'sched-0', {
            sessionId: item.id,
            readAt: index % 2 === 0 ? undefined : Date.parse(item.updatedAt),
            status: index % 3 === 0 ? 'running' : 'success',
            firedAt: Date.parse(item.updatedAt),
          }))],
        ['sched-1', sessions
          .filter((item) => item.source === 'scheduler' && Number(item.id.split('-').at(-1)) % 80 === 40)
          .map((item, index) => run(`run-weekly-${index}`, 'sched-1', {
            sessionId: item.id,
            status: 'success',
            firedAt: Date.parse(item.updatedAt),
          }))],
      ]),
    );

    const start = performance.now();
    const projectSections = buildRemoteSessionSections(sessions, now, {
      scheduleIndex,
    });
    const durationMs = performance.now() - start;
    const projectRows = projectSections.flatMap((section) => section.data);
    const representedSessionIds = projectRows.flatMap((item) =>
      item.automationGroup?.sessionIds ?? [item.session.id],
    );

    expect(sessions).toHaveLength(1000);
    expect(durationMs).toBeLessThan(1000);
    expect(new Set(representedSessionIds).size).toBe(1000);
    expect(projectRows.some((item) => item.automationGroup?.sessionCount && item.automationGroup.sessionCount > 1)).toBe(true);
    expect(projectSections[0]).toMatchObject({ key: 'pinned', title: '置顶' });

    const searchStart = performance.now();
    const searchRows = buildRemoteSessionSections(sessions, now, {
      searchQuery: 'feature-42',
      scheduleIndex,
    }).flatMap((section) => section.data);
    const searchDurationMs = performance.now() - searchStart;

    expect(searchDurationMs).toBeLessThan(250);
    expect(searchRows.length).toBeGreaterThan(0);
    expect(searchRows.every((item) =>
      item.title.includes('feature-42') || item.session.workingDir?.includes('feature-42'),
    )).toBe(true);
  });
});

function createLargeSessionFixture(count: number): RemoteSession[] {
  const base = Date.parse('2026-01-08T12:00:00.000Z');
  return Array.from({ length: count }, (_, index) => {
    const isDialogue = index % 7 === 0;
    const isAutomation = index % 40 === 0;
    const project = `feature-${index % 100}`;
    return session(`large-${index}`, {
      title: isAutomation ? `[Schedule] ${index % 80 === 0 ? '每日巡检' : '每周复盘'}` : `Session ${project} #${index}`,
      workspaceKind: isDialogue ? 'dialogue' : 'project',
      workingDir: isDialogue ? null : `/repo/${project}`,
      source: isAutomation ? 'scheduler' : undefined,
      pinnedAt: index % 125 === 0 ? new Date(base - index * 1000).toISOString() : null,
      status: index % 53 === 0 ? 'archived' : 'active',
      userSendAt: new Date(base - index * 60_000).toISOString(),
      updatedAt: new Date(base - index * 60_000).toISOString(),
      _count: { messages: index % 400 },
      model: index % 11 === 0 ? 'gpt-5.4' : 'claude-sonnet-4-6',
      agentKind: index % 11 === 0 ? 'codex' : 'cc',
      orcaRole: index % 211 === 0 ? 'worker' : null,
      worktreePath: index % 97 === 0 ? `/repo/${project}/.xdt-worktrees/mobile-${index}` : undefined,
    });
  });
}
