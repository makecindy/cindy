import { describe, expect, it } from 'vitest';
import {
  buildMobileHomePresentation,
  type MobileHomeSessionLike,
} from '../mobileHome.js';

function session(id: string, patch: Partial<MobileHomeSessionLike> = {}): MobileHomeSessionLike {
  return {
    agentKind: 'cc',
    createdAt: '2026-01-01T00:00:00.000Z',
    effort: 'medium',
    fastMode: false,
    id,
    model: 'claude-sonnet-4-6',
    permissionMode: 'ask',
    pinnedAt: null,
    status: 'active',
    title: id,
    updatedAt: '2026-01-01T00:00:00.000Z',
    userId: 'user-1',
    userSendAt: null,
    workspaceKind: 'project',
    workingDir: '/repo/app',
    ...patch,
  };
}

describe('mobileHome', () => {
  it('builds a unified home without merging same project path across devices', () => {
    const home = buildMobileHomePresentation({
      devices: [
        { canOpen: true, deviceId: 'mac-a', name: 'Mac A', state: 'ready', statusLabel: '在线' },
        { canOpen: true, deviceId: 'mac-b', name: 'Mac B', state: 'ready', statusLabel: '在线' },
      ],
      now: Date.parse('2026-01-01T00:10:00.000Z'),
      sessions: [
        session('a1', {
          deviceLinkDeviceId: 'mac-a',
          deviceLinkDeviceName: 'Mac A',
          title: 'A project',
          updatedAt: '2026-01-01T00:03:00.000Z',
        }),
        session('b1', {
          deviceLinkDeviceId: 'mac-b',
          deviceLinkDeviceName: 'Mac B',
          title: 'B project',
          updatedAt: '2026-01-01T00:04:00.000Z',
        }),
      ],
    });

    expect(home.deviceFilters.map((item) => [item.id, item.label, item.sessionCount])).toEqual([
      ['all', 'All', 2],
      ['mac-a', 'Mac A', 1],
      ['mac-b', 'Mac B', 1],
    ]);
    expect(home.projects.map((project) => [project.key, project.title, project.deviceName, project.sessions.map((item) => item.session.id)])).toEqual([
      ['device:mac-b:/repo/app', 'app', 'Mac B', ['b1']],
      ['device:mac-a:/repo/app', 'app', 'Mac A', ['a1']],
    ]);
  });


  it('merges the same project when remote workingDir only differs by surrounding whitespace or trailing separators', () => {
    const home = buildMobileHomePresentation({
      devices: [{ canOpen: true, deviceId: 'mac-a', name: 'Mac A' }],
      sessions: [
        session('first', {
          deviceLinkDeviceId: 'mac-a',
          workingDir: ' /repo/app/ ',
          updatedAt: '2026-01-01T00:03:00.000Z',
        }),
        session('second', {
          deviceLinkDeviceId: 'mac-a',
          workingDir: '/repo/app',
          updatedAt: '2026-01-01T00:04:00.000Z',
        }),
      ],
    });

    expect(home.projects.map((project) => ({
      key: project.key,
      sessionIds: project.sessions.map((item) => item.session.id),
      title: project.title,
      workingDir: project.workingDir,
    }))).toEqual([
      {
        key: 'device:mac-a:/repo/app',
        sessionIds: ['second', 'first'],
        title: 'app',
        workingDir: '/repo/app',
      },
    ]);
  });

  it('groups worktree sessions into the base repo project instead of a random worktree card', () => {
    // Slack / 定时任务这类自动建 worktree 的会话,workingDir 是 `<主仓>/.cindy-worktrees/<随机名>`。
    // 不折叠的话首页会多出「serene-lovelace」这种随机名项目卡(与桌面侧栏口径不一致)。
    const home = buildMobileHomePresentation({
      devices: [{ canOpen: true, deviceId: 'mac-a', name: 'Mac A' }],
      sessions: [
        session('main-repo', { deviceLinkDeviceId: 'mac-a', updatedAt: '2026-01-01T00:03:00.000Z' }),
        session('managed-worktree', {
          deviceLinkDeviceId: 'mac-a',
          workingDir: '/repo/app/.cindy-worktrees/serene-lovelace',
          worktreePath: '/repo/app/.cindy-worktrees/serene-lovelace',
          updatedAt: '2026-01-01T00:04:00.000Z',
        }),
        session('legacy-worktree', {
          deviceLinkDeviceId: 'mac-a',
          workingDir: '/repo/app/.xdt-worktrees/pensive-pasteur/src',
          worktreePath: '/repo/app/.xdt-worktrees/pensive-pasteur',
          updatedAt: '2026-01-01T00:05:00.000Z',
        }),
        session('conventional-worktree', {
          deviceLinkDeviceId: 'mac-a',
          workingDir: '/repo/app/.claude/worktrees/manual',
          updatedAt: '2026-01-01T00:06:00.000Z',
        }),
      ],
    });

    expect(home.projects.map((project) => ({
      key: project.key,
      sessionIds: project.sessions.map((item) => item.session.id),
      title: project.title,
      workingDir: project.workingDir,
    }))).toEqual([
      {
        key: 'device:mac-a:/repo/app',
        sessionIds: ['conventional-worktree', 'legacy-worktree', 'managed-worktree', 'main-repo'],
        title: 'app',
        workingDir: '/repo/app',
      },
    ]);
  });

  it('keeps the Windows drive-root separator so C:\\ and c:/ merge into one card', () => {
    // 盘符根特例:去尾分隔符不能把 C:\ / c:/ 削成 drive-relative 的 C: —— 否则丢掉 Windows 路径特征、
    // 盘符大小写无法归一,两条盘符根会话又会拆成两张卡。
    const home = buildMobileHomePresentation({
      devices: [{ canOpen: true, deviceId: 'pc-a', name: 'PC A' }],
      sessions: [
        session('root-upper', { deviceLinkDeviceId: 'pc-a', workingDir: 'C:\\', updatedAt: '2026-01-01T00:03:00.000Z' }),
        session('root-lower', { deviceLinkDeviceId: 'pc-a', workingDir: 'c:/', updatedAt: '2026-01-01T00:04:00.000Z' }),
      ],
    });

    expect(home.projects.map((project) => [project.key, project.workingDir, project.sessions.map((item) => item.session.id)])).toEqual([
      ['device:pc-a:c:/', 'c:/', ['root-lower', 'root-upper']],
    ]);
  });

  it('matches project-scoped Windows paths case-insensitively', () => {
    const home = buildMobileHomePresentation({
      devices: [{ canOpen: true, deviceId: 'pc-a', name: 'PC A' }],
      sessions: [
        session('upper', { deviceLinkDeviceId: 'pc-a', workingDir: String.raw`C:\Repo\App` }),
        session('lower', { deviceLinkDeviceId: 'pc-a', workingDir: 'c:/repo/app/' }),
      ],
    });

    expect(home.projects.map((project) => [project.key, project.sessions.map((item) => item.session.id)])).toEqual([
      ['device:pc-a:c:/repo/app', ['upper', 'lower']],
    ]);
  });

  it('treats backslash and forward-slash UNC paths as the same Windows project', () => {
    const home = buildMobileHomePresentation({
      devices: [{ canOpen: true, deviceId: 'pc-a', name: 'PC A' }],
      sessions: [
        session('unc-back', { deviceLinkDeviceId: 'pc-a', workingDir: String.raw`\\Server\Share\App`, updatedAt: '2026-01-01T00:03:00.000Z' }),
        session('unc-fwd', { deviceLinkDeviceId: 'pc-a', workingDir: '//Server/Share/App', updatedAt: '2026-01-01T00:04:00.000Z' }),
      ],
    });

    expect(home.projects.map((project) => [project.key, project.sessions.map((item) => item.session.id)])).toEqual([
      ['device:pc-a://server/share/app', ['unc-fwd', 'unc-back']],
    ]);
  });


  it('merges sessions from a stale device id when the device name uniquely matches the current device', () => {
    const home = buildMobileHomePresentation({
      devices: [{ canOpen: true, deviceId: 'current-mac', name: 'Lizi Mac', state: 'ready' }],
      sessions: [
        session('old-device-session', {
          deviceLinkDeviceId: 'stale-mac',
          deviceLinkDeviceName: 'Lizi Mac',
          workingDir: '/repo/app',
          updatedAt: '2026-01-01T00:03:00.000Z',
        }),
        session('current-device-session', {
          deviceLinkDeviceId: 'current-mac',
          deviceLinkDeviceName: 'Lizi Mac',
          workingDir: '/repo/app',
          updatedAt: '2026-01-01T00:04:00.000Z',
        }),
      ],
    });

    expect(home.projects.map((project) => [project.key, project.sessions.map((item) => item.session.id)])).toEqual([
      ['device:current-mac:/repo/app', ['current-device-session', 'old-device-session']],
    ]);
  });

  it('claims a stale-device session into the selected current device instead of dropping it before grouping', () => {
    // 归并必须贯穿到 matchesSelectedDevice / 概览:选中当前设备时,带旧 deviceId 但设备名唯一匹配的
    // 会话不能在分组前按原始 id 被过滤掉(否则本 PR 的归并在「选中具体设备」这个最常见视图里无效)。
    const home = buildMobileHomePresentation({
      devices: [{ canOpen: true, deviceId: 'current-mac', name: 'Lizi Mac', state: 'ready' }],
      selectedDeviceId: 'current-mac',
      sessions: [
        session('stale', {
          deviceLinkDeviceId: 'stale-mac',
          deviceLinkDeviceName: 'Lizi Mac',
          workingDir: '/repo/app',
          updatedAt: '2026-01-01T00:03:00.000Z',
        }),
        session('current', {
          deviceLinkDeviceId: 'current-mac',
          deviceLinkDeviceName: 'Lizi Mac',
          workingDir: '/repo/app',
          updatedAt: '2026-01-01T00:04:00.000Z',
        }),
      ],
    });

    expect(home.projects.map((project) => [project.key, project.deviceId, project.sessions.map((item) => item.session.id)])).toEqual([
      ['device:current-mac:/repo/app', 'current-mac', ['current', 'stale']],
    ]);
    // 概览按归一化后的设备统计:两条会话都归到当前设备,只算 1 台设备、2 条会话。
    expect([home.overview.all, home.overview.devices]).toEqual([2, 1]);
  });

  it('routes the merged project card to the current deviceId even when the newest session is stale', () => {
    // 卡片 deviceId 取自归一化后的会话:最新一条是旧 deviceId 会话时,deviceId 仍必须是当前设备,
    // 否则首页「查看全部」会带着已不存在的旧 deviceId 跳转到一台空设备。
    const home = buildMobileHomePresentation({
      devices: [{ canOpen: true, deviceId: 'current-mac', name: 'Lizi Mac', state: 'ready' }],
      sessions: [
        session('current', {
          deviceLinkDeviceId: 'current-mac',
          deviceLinkDeviceName: 'Lizi Mac',
          workingDir: '/repo/app',
          updatedAt: '2026-01-01T00:03:00.000Z',
        }),
        session('stale-newest', {
          deviceLinkDeviceId: 'stale-mac',
          deviceLinkDeviceName: 'Lizi Mac',
          workingDir: '/repo/app',
          updatedAt: '2026-01-01T00:05:00.000Z',
        }),
      ],
    });

    expect(home.projects.map((project) => [project.key, project.deviceId])).toEqual([
      ['device:current-mac:/repo/app', 'current-mac'],
    ]);
  });

  it('does not merge two unknown same-name devices into one project card', () => {
    // 只在设备名唯一匹配「当前设备」时才认领;两台都不在当前设备列表、但同名的历史 / 离线设备,
    // 不能仅凭设备名合并,否则会把两台设备的同名工程错并成一张卡,破坏按设备维度的分组。
    const home = buildMobileHomePresentation({
      devices: [],
      sessions: [
        session('ghost-a', {
          deviceLinkDeviceId: 'ghost-1',
          deviceLinkDeviceName: 'MacBook Pro',
          workingDir: '/repo/app',
          updatedAt: '2026-01-01T00:03:00.000Z',
        }),
        session('ghost-b', {
          deviceLinkDeviceId: 'ghost-2',
          deviceLinkDeviceName: 'MacBook Pro',
          workingDir: '/repo/app',
          updatedAt: '2026-01-01T00:04:00.000Z',
        }),
      ],
    });

    expect(home.projects.map((project) => project.key).sort()).toEqual([
      'device:ghost-1:/repo/app',
      'device:ghost-2:/repo/app',
    ]);
  });

  it('does not claim stale sessions when two stale devices share a name matching one current device', () => {
    // stale 侧同名歧义:两台旧机都叫 MacBook Pro、当前也有一台 MacBook Pro —— 无法判断该并到哪台,
    // 保守不认领,各自保留物理 id,避免把两台不同机器错并成一张卡。
    const home = buildMobileHomePresentation({
      devices: [{ canOpen: true, deviceId: 'current-mbp', name: 'MacBook Pro', state: 'ready' }],
      sessions: [
        session('a', { deviceLinkDeviceId: 'stale-1', deviceLinkDeviceName: 'MacBook Pro', workingDir: '/repo/app' }),
        session('b', { deviceLinkDeviceId: 'stale-2', deviceLinkDeviceName: 'MacBook Pro', workingDir: '/repo/app' }),
      ],
    });

    expect(home.projects.map((project) => project.key).sort()).toEqual([
      'device:stale-1:/repo/app',
      'device:stale-2:/repo/app',
    ]);
  });

  it('ignores placeholder device names (unknown / no) when claiming stale sessions', () => {
    const home = buildMobileHomePresentation({
      devices: [{ canOpen: true, deviceId: 'current-x', name: 'unknown', state: 'ready' }],
      sessions: [
        session('u', { deviceLinkDeviceId: 'stale-x', deviceLinkDeviceName: 'unknown', workingDir: '/repo/app' }),
      ],
    });
    // placeholder 名不参与设备身份匹配 —— 不能把两台「未命名」设备当同一台并起来。
    expect(home.projects.map((project) => [project.key, project.deviceId])).toEqual([
      ['device:stale-x:/repo/app', 'stale-x'],
    ]);
  });

  it('keeps pinned sessions and chats outside project groups', () => {
    const home = buildMobileHomePresentation({
      devices: [{ canOpen: true, deviceId: 'mac-a', name: 'Mac A' }],
      sessions: [
        session('pinned', {
          deviceLinkDeviceId: 'mac-a',
          pinnedAt: '2026-01-01T00:06:00.000Z',
          workingDir: '/repo/pinned',
        }),
        session('chat', {
          deviceLinkDeviceId: 'mac-a',
          workspaceKind: 'dialogue',
          workingDir: null,
        }),
        session('project', { deviceLinkDeviceId: 'mac-a' }),
      ],
    });

    expect(home.pinned.map((item) => item.session.id)).toEqual(['pinned']);
    expect(home.chats.map((item) => item.session.id)).toEqual(['chat']);
    expect(home.projects.map((project) => project.sessions.map((item) => item.session.id))).toEqual([
      ['project'],
    ]);
  });

  it('keeps device filter order from the device list model', () => {
    const home = buildMobileHomePresentation({
      devices: [
        { canOpen: true, deviceId: 'online', name: 'Online Mac', state: 'ready', statusLabel: '在线' },
        { canOpen: false, deviceId: 'offline', name: 'Offline PC', state: 'offline', statusLabel: '离线' },
      ],
      sessions: [],
    });

    expect(home.deviceFilters.map((item) => [item.id, item.label, item.available])).toEqual([
      ['all', 'All', true],
      ['online', 'Online Mac', true],
      ['offline', 'Offline PC', false],
    ]);
  });

  it('filters by device and searches device names plus previews', () => {
    const sessions = [
      session('a1', { deviceLinkDeviceId: 'mac-a', deviceLinkDeviceName: 'Alpha Mac', title: 'Build mobile' }),
      session('b1', { deviceLinkDeviceId: 'mac-b', deviceLinkDeviceName: 'Beta Mac', title: 'Release desktop' }),
    ];

    expect(buildMobileHomePresentation({
      devices: [
        { canOpen: true, deviceId: 'mac-a', name: 'Alpha Mac' },
        { canOpen: true, deviceId: 'mac-b', name: 'Beta Mac' },
      ],
      selectedDeviceId: 'mac-b',
      sessions,
    }).projects.flatMap((project) => project.sessions.map((item) => item.session.id))).toEqual(['b1']);

    expect(buildMobileHomePresentation({
      messagePreviewIndex: new Map([['a1', 'checkout handoff notes']]),
      searchQuery: 'handoff',
      sessions,
    }).projects.flatMap((project) => project.sessions.map((item) => item.session.id))).toEqual(['a1']);
  });

  it('falls back to the device-link preview when no loaded message preview exists', () => {
    // 首页 idle 会话消息未 load(messagePreviewIndex 无值),改用 device-link 带的 session.preview。
    // dialogue 会话进 chats,其 item.messagePreview 应等于该预览。
    const home = buildMobileHomePresentation({
      now: Date.parse('2026-01-01T00:10:00.000Z'),
      sessions: [
        session('chat-1', {
          deviceLinkDeviceId: 'mac-a',
          workspaceKind: 'dialogue',
          workingDir: null,
          title: '打招呼',
          preview: '你好，帮我看下登录失败',
        }),
      ],
    });

    expect(home.chats.map((item) => [item.session.id, item.messagePreview])).toEqual([
      ['chat-1', '你好，帮我看下登录失败'],
    ]);
  });

  it('prefers a loaded message preview over the device-link preview', () => {
    const home = buildMobileHomePresentation({
      messagePreviewIndex: new Map([['chat-1', '已加载的最新消息']]),
      sessions: [
        session('chat-1', {
          deviceLinkDeviceId: 'mac-a',
          workspaceKind: 'dialogue',
          workingDir: null,
          preview: '设备端旧预览',
        }),
      ],
    });

    expect(home.chats[0]?.messagePreview).toBe('已加载的最新消息');
  });

  it('searches the device-link preview so idle rows are not filtered out', () => {
    // 首页 idle 行显示的是 session.preview;搜索同一段可见文字必须命中(haystack 与展示同源)。
    const sessions = [
      session('chat-1', {
        deviceLinkDeviceId: 'mac-a',
        workspaceKind: 'dialogue',
        workingDir: null,
        title: '打招呼',
        preview: '帮我看下登录失败的报错',
      }),
      session('chat-2', {
        deviceLinkDeviceId: 'mac-a',
        workspaceKind: 'dialogue',
        workingDir: null,
        title: '另一个会话',
        preview: '部署文档已更新',
      }),
    ];

    const home = buildMobileHomePresentation({ searchQuery: '登录失败', sessions });
    expect(home.chats.map((item) => item.session.id)).toEqual(['chat-1']);
  });

  it('collapses runs of the same schedule into one automation group row inside the project', () => {
    const scheduleInfo = (latestRunAt: number, running = false) => ({
      scheduleId: 'sched-1',
      scheduleName: '每日巡检',
      unreadRunIds: [],
      unreadCount: 0,
      running,
      latestRunAt,
    });
    const home = buildMobileHomePresentation({
      devices: [{ canOpen: true, deviceId: 'mac-a', name: 'Mac A' }],
      now: Date.parse('2026-01-01T00:10:00.000Z'),
      scheduleIndex: new Map([
        ['run-1', scheduleInfo(1)],
        ['run-2', scheduleInfo(2)],
        ['run-3', scheduleInfo(3)],
      ]),
      sessions: [
        session('run-1', { deviceLinkDeviceId: 'mac-a', source: 'scheduler', updatedAt: '2026-01-01T00:01:00.000Z' }),
        session('manual', { deviceLinkDeviceId: 'mac-a', updatedAt: '2026-01-01T00:02:00.000Z' }),
        session('run-2', { deviceLinkDeviceId: 'mac-a', source: 'scheduler', updatedAt: '2026-01-01T00:03:00.000Z' }),
        session('run-3', { deviceLinkDeviceId: 'mac-a', source: 'scheduler', updatedAt: '2026-01-01T00:04:00.000Z' }),
      ],
    });

    expect(home.projects).toHaveLength(1);
    const rows = home.projects[0].sessions;
    // 3 次 run 折叠成 1 个组行,组行出现在组内最新一条(run-3)的位置,即 manual 之前。
    // 项目侧折叠 scope 用项目分桶键(设备 + 归一化路径),组 key 带该前缀。
    expect(rows.map((item) => item.automationGroup?.key ?? item.session.id))
      .toEqual(['device:mac-a:/repo/app|schedule:sched-1', 'manual']);
    const group = rows[0].automationGroup;
    expect(group?.sessionCount).toBe(3);
    expect(group?.items.map((item) => item.session.id)).toEqual(['run-3', 'run-2', 'run-1']);
    expect(rows[0].title).toBe('每日巡检');
    // 项目卡的会话数按真实会话数聚合,不按折叠后的行数。
    expect(home.projects[0].sessionCount).toBe(4);
  });

  it('does not collapse pinned automation sessions or single-run schedules', () => {
    const home = buildMobileHomePresentation({
      devices: [{ canOpen: true, deviceId: 'mac-a', name: 'Mac A' }],
      scheduleIndex: new Map([
        ['pinned-run', {
          scheduleId: 'sched-1', scheduleName: '每日巡检', unreadRunIds: [], unreadCount: 0, running: false, latestRunAt: 1,
        }],
        ['solo-run', {
          scheduleId: 'sched-2', scheduleName: '周报', unreadRunIds: [], unreadCount: 0, running: false, latestRunAt: 2,
        }],
      ]),
      sessions: [
        session('pinned-run', { deviceLinkDeviceId: 'mac-a', pinnedAt: '2026-01-01T00:05:00.000Z', source: 'scheduler' }),
        session('solo-run', { deviceLinkDeviceId: 'mac-a', source: 'scheduler' }),
      ],
    });

    // 置顶行不参与折叠;单次运行的任务不成组,保持普通会话行。
    expect(home.pinned.map((item) => [item.session.id, item.automationGroup])).toEqual([['pinned-run', undefined]]);
    expect(home.projects[0].sessions.map((item) => [item.session.id, item.automationGroup])).toEqual([['solo-run', undefined]]);
  });

  it('keeps the grouped automation row activity on the newest run even when an older unread run is primary', () => {
    // 旧 run 未读(primary 选中它)+ 新 run 已读:组行与项目卡的活动时间必须跟最新一条,
    // 否则该项目卡会按旧时间排到别的项目后面(P2 回归)。
    const scheduleInfo = (latestRunAt: number, unread: boolean) => ({
      scheduleId: 'sched-1',
      scheduleName: '每日巡检',
      unreadRunIds: unread ? [`run-${latestRunAt}`] : [],
      unreadCount: unread ? 1 : 0,
      running: false,
      latestRunAt,
    });
    const home = buildMobileHomePresentation({
      devices: [{ canOpen: true, deviceId: 'mac-a', name: 'Mac A' }],
      now: Date.parse('2026-01-02T00:00:00.000Z'),
      scheduleIndex: new Map([
        ['old-unread', scheduleInfo(1, true)],
        ['new-read', scheduleInfo(2, false)],
      ]),
      sessions: [
        session('old-unread', { deviceLinkDeviceId: 'mac-a', source: 'scheduler', updatedAt: '2026-01-01T00:01:00.000Z' }),
        session('new-read', { deviceLinkDeviceId: 'mac-a', source: 'scheduler', updatedAt: '2026-01-01T12:00:00.000Z' }),
      ],
    });

    const row = home.projects[0].sessions[0];
    // primary 是未读的旧 run,但组行活动时间取最新一条(new-read)。
    expect(row.automationGroup?.primarySessionId).toBe('old-unread');
    expect(row.lastActivityAt).toBe('2026-01-01T12:00:00.000Z');
    expect(home.projects[0].latestActivityAt).toBe('2026-01-01T12:00:00.000Z');
  });

  it('routes the grouped automation primary to the run waiting for interaction', () => {
    // 旧 run 有待处理交互、新 run 正常:primary 必须是等用户行动的那条(点行直开它),
    // 不能落在最新一条把待确认内容藏进展开列表(P2 回归)。
    const scheduleInfo = (latestRunAt: number) => ({
      scheduleId: 'sched-1',
      scheduleName: '每日巡检',
      unreadRunIds: [],
      unreadCount: 0,
      running: false,
      latestRunAt,
    });
    const home = buildMobileHomePresentation({
      devices: [{ canOpen: true, deviceId: 'mac-a', name: 'Mac A' }],
      pendingInteractionIndex: new Map([['old-pending', 2]]),
      scheduleIndex: new Map([
        ['old-pending', scheduleInfo(1)],
        ['new-idle', scheduleInfo(2)],
      ]),
      sessions: [
        session('old-pending', { deviceLinkDeviceId: 'mac-a', source: 'scheduler', updatedAt: '2026-01-01T00:01:00.000Z' }),
        session('new-idle', { deviceLinkDeviceId: 'mac-a', source: 'scheduler', updatedAt: '2026-01-01T12:00:00.000Z' }),
      ],
    });

    const row = home.projects[0].sessions[0];
    expect(row.automationGroup?.primarySessionId).toBe('old-pending');
    // 组行活动时间仍取组内最新,不因 primary 是旧 run 而回退。
    expect(row.lastActivityAt).toBe('2026-01-01T12:00:00.000Z');
  });

  it('partitions the same schedule by project so runs in a previous workingDir stay on that project card', () => {
    // 任务改过项目目录:同 scheduleId 的 run 分布在两个 workingDir,必须各项目内各自成组,
    // 原项目不丢行、计数不漂移(P2 回归)。
    const scheduleInfo = (latestRunAt: number) => ({
      scheduleId: 'sched-1',
      scheduleName: '每日巡检',
      unreadRunIds: [],
      unreadCount: 0,
      running: false,
      latestRunAt,
    });
    const home = buildMobileHomePresentation({
      devices: [{ canOpen: true, deviceId: 'mac-a', name: 'Mac A' }],
      scheduleIndex: new Map([
        ['app-run-1', scheduleInfo(1)],
        ['app-run-2', scheduleInfo(2)],
        ['web-run-1', scheduleInfo(3)],
        ['web-run-2', scheduleInfo(4)],
      ]),
      sessions: [
        session('app-run-1', { deviceLinkDeviceId: 'mac-a', source: 'scheduler', workingDir: '/repo/app', updatedAt: '2026-01-01T00:01:00.000Z' }),
        session('app-run-2', { deviceLinkDeviceId: 'mac-a', source: 'scheduler', workingDir: '/repo/app', updatedAt: '2026-01-01T00:02:00.000Z' }),
        session('web-run-1', { deviceLinkDeviceId: 'mac-a', source: 'scheduler', workingDir: '/repo/web', updatedAt: '2026-01-01T00:03:00.000Z' }),
        session('web-run-2', { deviceLinkDeviceId: 'mac-a', source: 'scheduler', workingDir: '/repo/web', updatedAt: '2026-01-01T00:04:00.000Z' }),
      ],
    });

    expect(home.projects.map((project) => [
      project.workingDir,
      project.sessionCount,
      project.sessions.map((item) => item.automationGroup?.items.map((child) => child.session.id)),
    ])).toEqual([
      ['/repo/web', 2, [['web-run-2', 'web-run-1']]],
      ['/repo/app', 2, [['app-run-2', 'app-run-1']]],
    ]);
  });

  it('scopes legacy fallback automation grouping by device so same-named tasks on two devices stay apart', () => {
    // 无 scheduleIndex 的 legacy 会话只能靠 [Schedule] 标题 + workingDir 兜底分组;
    // 两台设备同路径同任务名时必须各自成组,不能跨设备错并。
    const legacy = (id: string, deviceId: string, deviceName: string, updatedAt: string) => session(id, {
      deviceLinkDeviceId: deviceId,
      deviceLinkDeviceName: deviceName,
      source: 'scheduler',
      title: '[Schedule] 每日巡检',
      updatedAt,
    });
    const home = buildMobileHomePresentation({
      devices: [
        { canOpen: true, deviceId: 'mac-a', name: 'Mac A' },
        { canOpen: true, deviceId: 'mac-b', name: 'Mac B' },
      ],
      sessions: [
        legacy('a-run-1', 'mac-a', 'Mac A', '2026-01-01T00:01:00.000Z'),
        legacy('a-run-2', 'mac-a', 'Mac A', '2026-01-01T00:02:00.000Z'),
        legacy('b-run-1', 'mac-b', 'Mac B', '2026-01-01T00:03:00.000Z'),
        legacy('b-run-2', 'mac-b', 'Mac B', '2026-01-01T00:04:00.000Z'),
      ],
    });

    // 同 workingDir 但不同设备 → 两张项目卡,各自折叠成一个组,互不混入。
    const groupsByProject = home.projects.map((project) =>
      project.sessions.map((item) => item.automationGroup?.items.map((child) => child.session.id)));
    expect(groupsByProject).toEqual([
      [['b-run-2', 'b-run-1']],
      [['a-run-2', 'a-run-1']],
    ]);
  });

  it('marks the no-device empty state as the remote-access onboarding kind', () => {
    // 无可用设备是「首次使用 / 产品模式说明」级空态:客户端按 emptyKind=noDevice
    // 渲染连接引导,文案讲清手机版当前是电脑端 Cindy 的远程入口。
    const home = buildMobileHomePresentation({ devices: [], sessions: [] });

    expect(home.emptyKind).toBe('noDevice');
    expect(home.emptyNoDevice).toEqual({ reason: 'firstRun', devices: [] });
    expect(home.emptyTitle).toBe('连接你电脑上的 Cindy');
    expect(home.emptyCopy).toContain('远程访问');
    expect(home.emptyCopy).toContain('运行在你的电脑上');
  });

  it('keeps plain empty-state kinds for filters once a device is available', () => {
    const devices = [{ canOpen: true, deviceId: 'mac-a', name: 'Mac A' }];

    expect(buildMobileHomePresentation({ devices, sessions: [] }).emptyKind).toBe('noSession');
    expect(buildMobileHomePresentation({ devices, sessions: [] }).emptyNoDevice).toBeNull();
    expect(buildMobileHomePresentation({ devices, sessions: [], searchQuery: 'x' }).emptyKind).toBe('search');
    expect(buildMobileHomePresentation({ devices, sessions: [], statusFilter: 'waiting' }).emptyKind).toBe('waiting');
    expect(buildMobileHomePresentation({ devices, sessions: [], statusFilter: 'automation' }).emptyKind).toBe('automation');
    expect(buildMobileHomePresentation({ devices, sessions: [], statusFilter: 'archived' }).emptyKind).toBe('archived');
  });

  it('classifies unavailable-device empty states by the most actionable reason', () => {
    const device = (deviceId: string, state: string, patch: Record<string, unknown> = {}) => ({
      canOpen: false,
      deviceId,
      name: deviceId,
      state,
      ...patch,
    });

    // 全部离线 → offline 引导(打开电脑上的 Cindy)。
    const offline = buildMobileHomePresentation({
      devices: [device('mac-a', 'offline', { statusDetail: '3 小时前在线' })],
      sessions: [],
    });
    expect(offline.emptyNoDevice).toEqual({
      reason: 'offline',
      devices: [{ deviceId: 'mac-a', name: 'mac-a', statusDetail: '3 小时前在线' }],
    });
    expect(offline.emptyTitle).toBe('打开电脑上的 Cindy');

    // 在线但没开远程控制 → 精确到开关的一步引导,copy 指名设备。
    const remoteDisabled = buildMobileHomePresentation({
      devices: [device('mac-a', 'offline'), device('Mac Studio', 'remote_disabled')],
      sessions: [],
    });
    expect(remoteDisabled.emptyNoDevice?.reason).toBe('remoteDisabled');
    expect(remoteDisabled.emptyNoDevice?.devices.map((item) => item.name)).toEqual(['Mac Studio']);
    expect(remoteDisabled.emptyTitle).toBe('在电脑上允许远程控制');
    expect(remoteDisabled.emptyCopy).toContain('「Mac Studio」');

    // 被撤销访问优先于其它一切(用户显式动作需正面回应)。
    const revoked = buildMobileHomePresentation({
      devices: [device('mac-a', 'remote_disabled'), device('MacBook', 'access_revoked')],
      sessions: [],
    });
    expect(revoked.emptyNoDevice?.reason).toBe('accessRevoked');
    expect(revoked.emptyNoDevice?.devices.map((item) => item.name)).toEqual(['MacBook']);
    expect(revoked.emptyTitle).toBe('访问权限已被撤销');
    expect(revoked.emptyCopy).toContain('「MacBook」');
  });
});
