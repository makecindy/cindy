import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
  buildRemoteSessionListContext,
  buildRemoteSessionCardPreview,
  buildRemoteSessionSections,
  buildSessionMessagePreviewIndex,
  buildSessionScheduleIndex,
  deviceSessionEmptyState,
  getRemoteSessionPreviewCollapse,
  remoteSessionControlsSummary,
  remoteSessionFilterLabel,
  remoteSessionOverviewCopy,
  type RemoteSessionListMessage as RemoteMessage,
  type RemoteSessionListSession as RemoteSession,
  sessionRowMessagePreview,
  summarizeRemoteSessionOverview,
  toRemoteSessionListItem,
  formatRemoteSessionSidebarTime,
} from '../sessionList.js';
import type { PresentationLocalizer } from '../presentationLocalization.js';
import type { RemoteSchedule, RemoteScheduleRun } from '../scheduleTypes.js';
import { CONTINUE_AFTER_ERROR_PROMPT } from '../syntheticTrigger.js';

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

  it('groups worktree sessions under their base repo instead of the random worktree name', () => {
    const sections = buildRemoteSessionSections([
      session('main-repo', { updatedAt: '2026-01-01T00:01:00.000Z' }),
      session('worktree', {
        updatedAt: '2026-01-01T00:02:00.000Z',
        workingDir: '/repo/app/.cindy-worktrees/serene-lovelace',
        worktreePath: '/repo/app/.cindy-worktrees/serene-lovelace',
      }),
    ], new Date('2026-01-01T00:10:00.000Z').getTime());

    expect(sections.map((section) => [section.key, section.title, section.data.map((item) => item.session.id)])).toEqual([
      ['project:/repo/app', 'app', ['worktree', 'main-repo']],
    ]);
    // worktree 身份不丢:仍由会话行副标题标出。
    expect(sections[0].data[0].worktreeLabel).toBe('Worktree serene-lovelace');
  });

  it('未起名会话用调用方给的本地化文案,不回落工作目录路径', () => {
    // 哨兵若按「无标题」处理,会回落 workingDir 把完整路径当标题显示,与 desktop 的
    // 「未命名任务」不一致(PR #1031 review P1)。文案由调用方按当前 locale 传入 ——
    // 共享层不能兜中文串,mobile 还支持 en / ja / ko。
    const now = new Date('2026-01-01T00:10:00.000Z').getTime();
    const sentinel = session('s-sentinel', {
      title: 'New Maker',
      workingDir: '/Users/dash/Code/Cindy/cindy',
    });

    expect(
      toRemoteSessionListItem(sentinel, now, undefined, 0, null, null, '未命名任务').title,
    ).toBe('未命名任务');
    // 同一条会话换 locale → 换文案(锁住「不在共享层写死中文」)。
    expect(
      toRemoteSessionListItem(sentinel, now, undefined, 0, null, null, 'Untitled session').title,
    ).toBe('Untitled session');
    // 调用方没给文案时回落既有链(workingDir),而不是悄悄显示中文。
    expect(toRemoteSessionListItem(sentinel, now).title).toBe('/Users/dash/Code/Cindy/cindy');

    // 空标题(非哨兵)不受影响,仍走既有兜底链。
    const emptyTitle = toRemoteSessionListItem(
      session('s-empty', { title: '', workingDir: '/Users/dash/Code/Cindy/cindy' }),
      now,
      undefined,
      0,
      null,
      null,
      '未命名任务',
    );
    expect(emptyTitle.title).toBe('/Users/dash/Code/Cindy/cindy');
  });

  it('buildRemoteSessionSections 把 unnamedLabel 透传到列表行', () => {
    // 设备详情页与首页都经 options 传 locale 文案;漏传就会在 en/ja/ko 下露出中文或路径。
    const [section] = buildRemoteSessionSections(
      [session('s-sentinel', { title: 'New Maker', workingDir: '/repo' })],
      new Date('2026-01-01T00:10:00.000Z').getTime(),
      { unnamedLabel: 'Untitled session' },
    );
    expect(section.data[0].title).toBe('Untitled session');
  });

  // 搜索 haystack 与行上显示的串必须同源(PR #1031 review P1)。两条断言方向相反,
  // 缺哪一条都会留下一半的错位:只补 label 会让内部哨兵继续可搜,只删哨兵会让
  // 界面上看得见的文案搜不到。
  it('未起名会话能按行上显示的兜底文案搜到', () => {
    const sections = buildRemoteSessionSections(
      [
        session('s-sentinel', { title: 'New Maker', workingDir: '/repo' }),
        session('s-named', { title: '修 Orca 心跳', workingDir: '/other' }),
      ],
      new Date('2026-01-01T00:10:00.000Z').getTime(),
      { searchQuery: 'Untitled', unnamedLabel: 'Untitled session' },
    );
    expect(sections.flatMap((s) => s.data).map((item) => item.session.id)).toEqual(['s-sentinel']);
  });

  it('内部哨兵不进 haystack:搜 "New Maker" 只命中标题里真有这个词的会话', () => {
    const sections = buildRemoteSessionSections(
      [
        session('s-sentinel', { title: 'New Maker', workingDir: '/repo' }),
        session('s-named', { title: 'Fix New Maker draft route', workingDir: '/other' }),
      ],
      new Date('2026-01-01T00:10:00.000Z').getTime(),
      { searchQuery: 'new maker', unnamedLabel: 'Untitled session' },
    );
    expect(sections.flatMap((s) => s.data).map((item) => item.session.id)).toEqual(['s-named']);
  });

  it('automation 会话按剥掉前缀后的可见标题可搜', () => {
    // 投影替掉的是原始 title 那一项;`[Schedule] ` 前缀本来就不显示,剥掉后的串
    // 由 haystack 里的 automationDisplayTitle 继续覆盖。
    const sections = buildRemoteSessionSections(
      [session('s-auto', { title: '[Schedule] 每日巡检', workingDir: '/repo' })],
      new Date('2026-01-01T00:10:00.000Z').getTime(),
      { searchQuery: '每日巡检', unnamedLabel: 'Untitled session' },
    );
    expect(sections.flatMap((s) => s.data).map((item) => item.session.id)).toEqual(['s-auto']);
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
      detail: '活跃 · 5 minutes ago · 12 条消息',
      messagePreview: null,
      lastActivityAt: '2026-01-01T00:05:00.000Z',
    });
  });

  it('caps oversized message counts at 1000+', () => {
    const item = toRemoteSessionListItem(session('s-big', {
      title: '大库',
      workingDir: null,
      workspaceKind: 'dialogue',
      agentKind: 'codex',
      model: 'gpt-5.4',
      userSendAt: '2026-01-01T00:05:00.000Z',
      _count: { messages: 1001 },
    }), new Date('2026-01-01T00:10:00.000Z').getTime());

    expect(item).toMatchObject({
      detail: '活跃 · 5 minutes ago · 1000+ 条消息',
      messagePreview: null,
      lastActivityAt: '2026-01-01T00:05:00.000Z',
    });
  });

  it('labels pi sessions as Pi instead of falling back to Claude Code', () => {
    // codex review 回归:共享标签映射二元化会让桌面创建的 Pi 会话在手机端显示成 Claude Code。
    const item = toRemoteSessionListItem(session('s-pi', {
      title: '',
      workingDir: null,
      workspaceKind: 'dialogue',
      agentKind: 'pi',
      model: 'claude-sonnet-4-6',
      userSendAt: '2026-01-01T00:05:00.000Z',
      _count: { messages: 3 },
    }), new Date('2026-01-01T00:10:00.000Z').getTime());

    expect(item.subtitle).toBe('Pi · claude-sonnet-4-6 · dialogue');
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

  it('uses live activity for running card previews before static running fallback', () => {
    const base = toRemoteSessionListItem(
      session('s1', { title: 'Run tests' }),
      new Date('2026-01-01T00:10:00.000Z').getTime(),
      undefined,
      0,
      '旧的消息摘要',
    );

    expect(buildRemoteSessionCardPreview({
      ...base,
      liveActivity: {
        sessionId: 's1',
        phase: 'running',
        compactDetail: '正在检查失败测试',
      },
    }, { running: true })).toBe('正在检查失败测试');

    expect(buildRemoteSessionCardPreview(base, { running: true })).toBe('运行中');
    expect(buildRemoteSessionCardPreview({
      ...base,
      liveActivity: {
        sessionId: 's1',
        phase: 'completed',
        compactDetail: '完成',
      },
    }, { running: true })).toBe('运行中');
    expect(buildRemoteSessionCardPreview({
      ...base,
      session: { ...base.session, source: 'scheduler' },
    }, { running: true })).toBe('自动化执行中');
    expect(buildRemoteSessionCardPreview(base, { running: false })).toBe('旧的消息摘要');
  });

  it('localizes generated preview states without treating message text as a state marker', () => {
    const message = toRemoteSessionListItem(
      session('s1', { title: 'Run tests' }),
      new Date('2026-01-01T00:10:00.000Z').getTime(),
      undefined,
      0,
      '运行中',
    );
    const localizer = {
      translate: (key: string, fallback: string) => key.endsWith('.running') ? 'Running' : fallback,
    };

    expect(buildRemoteSessionCardPreview(message, { localizer })).toBe('运行中');
    expect(buildRemoteSessionCardPreview(message, { localizer, running: true })).toBe('Running');
  });

  it('prefers human awaiting copy over stale tool status when interaction is pending', () => {
    const base = toRemoteSessionListItem(
      session('s1', { title: 'Ask something' }),
      new Date('2026-01-01T00:10:00.000Z').getTime(),
      undefined,
      0,
      '旧的消息摘要',
    );

    // needs-interaction 时不透传过期的 tool 状态行(如 'ask_user_question running...')
    expect(buildRemoteSessionCardPreview({
      ...base,
      liveActivity: {
        sessionId: 's1',
        phase: 'needs-interaction',
        compactDetail: 'ask_user_question running...',
        interactionKind: 'ask_user_question',
        attention: true,
      },
    }, { running: true })).toBe('等待你的回复');

    expect(buildRemoteSessionCardPreview({
      ...base,
      liveActivity: {
        sessionId: 's1',
        phase: 'needs-interaction',
        compactDetail: 'Bash running...',
        interactionKind: 'permission',
      },
    }, { running: false })).toBe('等待授权');

    expect(buildRemoteSessionCardPreview({
      ...base,
      liveActivity: {
        sessionId: 's1',
        phase: 'needs-interaction',
        compactDetail: '',
        interactionKind: 'plan_review',
      },
    }, { running: true })).toBe('等待计划审阅');

    // relay 断连时靠 pendingInteractionCount 兜底,kind 未知给通用文案
    expect(buildRemoteSessionCardPreview({
      ...base,
      pendingInteractionCount: 1,
    }, { running: true })).toBe('等待你处理');
  });

  it('returns null for idle previews when the session has no message yet', () => {
    const idle = toRemoteSessionListItem(
      session('s1', { title: 'Run tests' }),
      new Date('2026-01-01T00:10:00.000Z').getTime(),
      undefined,
      0,
      null,
    );
    expect(idle.messagePreview).toBeNull();
    expect(buildRemoteSessionCardPreview(idle, { running: false })).toBeNull();
  });

  it('reads the device-link preview field via sessionRowMessagePreview for idle rows', () => {
    // 首页会话经 device-link(local-db:sessions:list)注水,桌面把最近一条消息纯文本放在
    // session.preview;首页构建时经 sessionRowMessagePreview 流入 item.messagePreview,
    // idle 行据此显示最后回答文字 —— 无需服务端改动,可纯 OTA。
    const withPreview = session('s2', { title: '打招呼', preview: '你好，帮我看下登录失败' });
    expect(sessionRowMessagePreview(withPreview)).toBe('你好，帮我看下登录失败');
    const item = toRemoteSessionListItem(
      withPreview,
      Date.now(),
      undefined,
      0,
      sessionRowMessagePreview(withPreview),
    );
    expect(buildRemoteSessionCardPreview(item)).toBe('你好，帮我看下登录失败');
  });

  it('preserves a JSON-looking device-link preview as plain text (no re-parse)', () => {
    // session.preview 已是桌面提炼好的纯文本;用户消息正文恰好是 JSON 形时不能被再解析丢原文。
    const jsonish = session('jsonish', { preview: '{"error":"login failed"}' });
    expect(sessionRowMessagePreview(jsonish)).toBe('{"error":"login failed"}');
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
      detail: '活跃 · 10 minutes ago · 自动化执行中 · 1 个自动化未读',
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
      detail: '2 个任务 · 4 minutes ago · 自动化执行中 · 1 个自动化未读',
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

  it('keeps each automation run as its own row when groupAutomations is false', () => {
    const now = new Date('2026-01-01T00:10:00.000Z').getTime();
    const scheduleIndex = buildSessionScheduleIndex([
      schedule('sched-1', { name: '移动端巡检' }),
    ], new Map([
      ['sched-1', [
        run('run-1', 'sched-1', { sessionId: 'old', readAt: undefined, firedAt: Date.parse('2026-01-01T00:02:00.000Z') }),
        run('run-2', 'sched-1', { sessionId: 'running', status: 'running', firedAt: Date.parse('2026-01-01T00:06:00.000Z') }),
      ]],
    ]));

    const sections = buildRemoteSessionSections([
      session('old', { source: 'scheduler', title: '[Schedule] Old run', updatedAt: '2026-01-01T00:02:00.000Z' }),
      session('running', { source: 'scheduler', title: '[Schedule] Running run', updatedAt: '2026-01-01T00:06:00.000Z' }),
      session('normal', { title: 'Normal', updatedAt: '2026-01-01T00:04:00.000Z' }),
    ], now, { scheduleIndex, groupAutomations: false });

    const rows = sections.flatMap((section) => section.data);
    // 不折叠:两个 run 各自成行,无 automationGroup 包裹。
    expect(rows.some((item) => item.automationGroup)).toBe(false);
    expect(rows.map((item) => item.session.id).sort()).toEqual(['normal', 'old', 'running']);
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

  it('counts a worktree session under its base repo so the overview matches the project sections', () => {
    const sessions = [
      session('main-repo', { workingDir: '/repo/app' }),
      session('worktree', {
        workingDir: '/repo/app/.cindy-worktrees/serene-lovelace',
        worktreePath: '/repo/app/.cindy-worktrees/serene-lovelace',
      }),
    ];
    const overview = summarizeRemoteSessionOverview(sessions, new Map(), new Map());
    const sections = buildRemoteSessionSections(sessions, new Date('2026-01-01T00:10:00.000Z').getTime());

    expect(overview.projectCount).toBe(1);
    expect(sections.filter((section) => section.key.startsWith('project:'))).toHaveLength(1);
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

  it('never leaks hidden synthetic trigger prompts into session previews', () => {
    // 桌面「失败后继续」的隐藏续跑 prompt(带 [UI_ACTION_TRIGGER] 前缀)常是会话
    // 最后一条 user 行:预览必须回落到上一条可见消息,而不是把裸英文指令亮出来。
    const messagePreviewIndex = buildSessionMessagePreviewIndex(['s1'], (sessionId) => [
      message(sessionId, 'm1', 'assistant', '上一条可见回答', '2026-01-01T00:01:00.000Z'),
      message(sessionId, 'm2', 'user', { text: CONTINUE_AFTER_ERROR_PROMPT, images: [], files: [] }, '2026-01-01T00:02:00.000Z'),
    ]);
    expect(messagePreviewIndex.get('s1')).toBe('上一条可见回答');

    // raw string 与 JSON 字符串包裹形态同样被挡
    const rawIndex = buildSessionMessagePreviewIndex(['s2'], (sessionId) => [
      message(sessionId, 'm1', 'user', CONTINUE_AFTER_ERROR_PROMPT, '2026-01-01T00:01:00.000Z'),
    ]);
    expect(rawIndex.get('s2')).toBeUndefined();

    const rowWithSynthetic = session('s3', {
      lastMessageText: JSON.stringify({ text: CONTINUE_AFTER_ERROR_PROMPT, images: [], files: [] }),
    } as Partial<RemoteSession>);
    expect(sessionRowMessagePreview(rowWithSynthetic)).toBeNull();

    // silent-stop 自动续跑行(agentMeta.autoResume)同样不进预览——回落上一条可见消息。
    // 按标记过滤而非文本:用户真发「继续」两个字是合法消息,不能误伤。
    const autoResumeIndex = buildSessionMessagePreviewIndex(['s4'], (sessionId) => [
      message(sessionId, 'm1', 'assistant', '任务推进到一半', '2026-01-01T00:01:00.000Z'),
      {
        ...message(sessionId, 'm2', 'user', '继续', '2026-01-01T00:02:00.000Z'),
        agentMeta: { delivery: 'turn', autoResume: true },
      },
    ]);
    expect(autoResumeIndex.get('s4')).toBe('任务推进到一半');

    const genuineContinueIndex = buildSessionMessagePreviewIndex(['s5'], (sessionId) => [
      message(sessionId, 'm1', 'user', '继续', '2026-01-01T00:02:00.000Z'),
    ]);
    expect(genuineContinueIndex.get('s5')).toBe('继续');
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

describe('getRemoteSessionPreviewCollapse', () => {
  const nowMs = Date.parse('2026-01-10T12:00:00.000Z');
  // 超出 24h 豁免窗口的旧活动时间与窗口内的近期活动时间。
  const staleIso = '2026-01-05T00:00:00.000Z';
  const recentIso = '2026-01-10T11:00:00.000Z';

  function listItem(
    id: string,
    activityIso: string,
    options: { pending?: number; live?: Parameters<typeof toRemoteSessionListItem>[5] } = {},
  ) {
    return toRemoteSessionListItem(
      session(id, { updatedAt: activityIso }),
      nowMs,
      undefined,
      options.pending ?? 0,
      null,
      options.live ?? null,
    );
  }

  it('collapses stale items beyond the limit like the desktop sidebar', () => {
    const items = ['s1', 's2', 's3', 's4', 's5', 's6', 's7'].map((id) => listItem(id, staleIso));
    const view = getRemoteSessionPreviewCollapse(items, { limit: 5, nowMs });

    expect(view.totalCount).toBe(7);
    expect(view.hiddenCount).toBe(2);
    expect(view.visibleItems.map((item) => item.session.id)).toEqual(['s1', 's2', 's3', 's4', 's5']);
  });

  it('keeps items with activity within 24h visible beyond the limit', () => {
    const items = ['s1', 's2', 's3', 's4', 's5', 's6', 's7'].map((id) => listItem(id, recentIso));
    const view = getRemoteSessionPreviewCollapse(items, { limit: 5, nowMs });

    expect(view.hiddenCount).toBe(0);
    expect(view.visibleItems).toHaveLength(7);
  });

  it('keeps attention items visible: pending interaction / schedule unread / live attention', () => {
    const items = ['s1', 's2', 's3', 's4', 's5'].map((id) => listItem(id, staleIso));
    const pending = listItem('s6', staleIso, { pending: 1 });
    const unread = {
      ...listItem('s7', staleIso),
      scheduleInfo: {
        scheduleId: 'sch-1',
        scheduleName: '每日巡检',
        unreadRunIds: ['r1'],
        unreadCount: 1,
        running: false,
        latestRunAt: Date.parse(staleIso),
      },
    };
    const needsInteraction = listItem('s8', staleIso, {
      live: { sessionId: 's8', phase: 'needs-interaction', compactDetail: '等待选择' },
    });
    const collapsed = listItem('s9', staleIso);
    const view = getRemoteSessionPreviewCollapse(
      [...items, pending, unread, needsInteraction, collapsed],
      { limit: 5, nowMs },
    );

    expect(view.visibleItems.map((item) => item.session.id)).toEqual(
      ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'],
    );
    expect(view.hiddenCount).toBe(1);
  });

  it('keeps running items visible: schedule running / live running / host isSessionRunning', () => {
    const items = ['s1', 's2', 's3', 's4', 's5'].map((id) => listItem(id, staleIso));
    const scheduleRunning = {
      ...listItem('s6', staleIso),
      scheduleInfo: {
        scheduleId: 'sch-2',
        scheduleName: '每周复盘',
        unreadRunIds: [],
        unreadCount: 0,
        running: true,
        latestRunAt: Date.parse(staleIso),
      },
    };
    const liveRunning = listItem('s7', staleIso, {
      live: { sessionId: 's7', phase: 'running', compactDetail: '执行中' },
    });
    const hostRunning = listItem('s8', staleIso);
    const collapsed = listItem('s9', staleIso);
    const view = getRemoteSessionPreviewCollapse(
      [...items, scheduleRunning, liveRunning, hostRunning, collapsed],
      { limit: 5, nowMs, isSessionRunning: (sessionId) => sessionId === 's8' },
    );

    expect(view.visibleItems.map((item) => item.session.id)).toEqual(
      ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'],
    );
    expect(view.hiddenCount).toBe(1);
  });

  it('keeps an automation group visible when a non-primary member run is running or needs attention', () => {
    const items = ['s1', 's2', 's3', 's4', 's5'].map((id) => listItem(id, staleIso));
    // 组行本体(primary)完全陈旧空闲,只有组内非 primary 成员分别命中宿主运行态 / live attention。
    const groupOf = (id: string, members: ReturnType<typeof listItem>[]) => ({
      ...listItem(id, staleIso),
      automationGroup: {
        key: `schedule:${id}`,
        baseKey: `schedule:${id}`,
        title: id,
        sessionIds: members.map((member) => member.session.id),
        sessionCount: members.length,
        primarySessionId: members[0].session.id,
        children: [],
        items: members,
      },
    });
    const hostRunningGroup = groupOf('g1', [listItem('g1-run1', staleIso), listItem('g1-run2', staleIso)]);
    const liveAttentionGroup = groupOf('g2', [
      listItem('g2-run1', staleIso),
      listItem('g2-run2', staleIso, {
        live: { sessionId: 'g2-run2', phase: 'needs-interaction', compactDetail: '等待选择' },
      }),
    ]);
    const staleGroup = groupOf('g3', [listItem('g3-run1', staleIso), listItem('g3-run2', staleIso)]);
    const view = getRemoteSessionPreviewCollapse(
      [...items, hostRunningGroup, liveAttentionGroup, staleGroup],
      { limit: 5, nowMs, isSessionRunning: (sessionId) => sessionId === 'g1-run2' },
    );

    expect(view.visibleItems.map((item) => item.session.id)).toEqual(
      ['s1', 's2', 's3', 's4', 's5', 'g1', 'g2'],
    );
    expect(view.hiddenCount).toBe(1);
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

function zhTimeLocalizer(): PresentationLocalizer {
  const dict: Record<string, string> = {
    'devices.presentation.sessionList.time.justNow': '刚刚',
    'devices.presentation.sessionList.time.minutesAgo': '{{count}} 分钟前',
    'devices.presentation.sessionList.time.hoursAgo': '{{count}} 小时前',
    'devices.presentation.sessionList.time.daysAgo': '{{count}} 天前',
    'devices.presentation.sessionList.time.minutes': '{{count}} 分钟',
    'devices.presentation.sessionList.time.hours': '{{count}} 小时',
    'devices.presentation.sessionList.time.days': '{{count}} 天',
    'devices.presentation.sessionList.time.weeks': '{{count}} 周',
    'devices.presentation.sessionList.time.months': '{{count}} 月',
    'devices.presentation.sessionList.time.years': '{{count}} 年',
  };
  return {
    translate: (key, fallback, values) => {
      const template = dict[key] ?? fallback;
      return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? ''));
    },
  };
}

describe('formatRemoteSessionSidebarTime', () => {
  const now = new Date('2026-01-01T12:00:00.000Z').getTime();

  it('falls back to English when no localizer is passed', () => {
    expect(formatRemoteSessionSidebarTime('2026-01-01T11:59:30.000Z', now)).toBe('Just now');
    expect(formatRemoteSessionSidebarTime('2026-01-01T11:55:00.000Z', now)).toBe('5 min');
    expect(formatRemoteSessionSidebarTime('2026-01-01T09:00:00.000Z', now)).toBe('3 hr');
    expect(formatRemoteSessionSidebarTime('2025-12-30T12:00:00.000Z', now)).toBe('2 d');
  });

  it('uses translated compact strings when a localizer is passed', () => {
    const t = zhTimeLocalizer();
    expect(formatRemoteSessionSidebarTime('2026-01-01T11:59:30.000Z', now, t)).toBe('刚刚');
    expect(formatRemoteSessionSidebarTime('2026-01-01T11:55:00.000Z', now, t)).toBe('5 分钟');
    expect(formatRemoteSessionSidebarTime('2026-01-01T09:00:00.000Z', now, t)).toBe('3 小时');
    expect(formatRemoteSessionSidebarTime('2025-12-30T12:00:00.000Z', now, t)).toBe('2 天');
  });
});
