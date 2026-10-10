import { describe, expect, it } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';
import {
  buildWorkbenchProjectOptions,
  buildWorkbenchTiles,
  collectBotHiddenSessionIds,
  isNonProjectDir,
  looksGeneratedDirName,
  countUnjudgedCandidates,
  groupWorkbenchTiles,
  tierWorkbenchProjectOptions,
  workbenchGroupHasFollowUp,
  workbenchTileGroup,
  workbenchItemNeedsLocalReference,
  type WorkbenchProjectOption,
  type WorkbenchDelegationInput,
} from '../botWorkbenchProjection';

const ART = '/Users/me/Code/tapmon-art';
const CINDY = '/Users/me/Code/cindy';

function session(id: string, patch: Partial<Session> = {}): Session {
  return {
    id,
    userId: 'u',
    title: id,
    workingDir: ART,
    workspaceKind: 'project',
    model: 'm',
    effort: 'high',
    permissionMode: 'ask',
    sdkSessionId: null,
    totalTokenUsage: 0,
    totalCostUsd: 0,
    contextTokens: 0,
    contextWindow: 0,
    fastMode: false,
    clearedAt: null,
    pinnedAt: null,
    userSendAt: '2026-10-01T01:00:00.000Z',
    status: 'active',
    agentKind: 'cc',
    source: 'desktop',
    extraDirs: [],
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-10-01T01:00:00.000Z',
    ...patch,
  } as Session;
}

function delegation(childSessionId: string, status: WorkbenchDelegationInput['status']): WorkbenchDelegationInput {
  return {
    childSessionId,
    status,
    resultSummary: null,
    lastError: null,
    createdAt: 1,
    acceptedAt: status === 'running' ? 1_000 : null,
    completedAt: null,
    updatedAt: 2,
  };
}

const base = {
  hiddenIds: new Set<string>(),
  projectDirs: [ART],
  caseInsensitive: false,
  delegations: [] as WorkbenchDelegationInput[],
  activity: new Map(),
  erroredIds: new Set<string>(),
  schedules: [],
  routines: [],
  now: Date.parse('2026-10-02T00:00:00.000Z'),
};

describe('buildWorkbenchTiles', () => {
  it('derives each tile state from host signals only', () => {
    const tiles = buildWorkbenchTiles({
      ...base,
      sessions: [
        session('running'),
        session('asking'),
        session('bg-queued', { userSendAt: null }),
      ],
      delegations: [delegation('bg-queued', 'queued')],
      activity: new Map([
        ['running', { phase: 'running', startedAtMs: 500, currentActionSummary: '导出 xhdpi 尺寸' }],
        ['asking', { phase: 'needs-interaction' }],
      ]),
    });
    const byId = new Map(tiles.map((tile) => [tile.id, tile]));
    expect(byId.get('running')).toMatchObject({
      state: 'running',
      startedAtMs: 500,
      line: { kind: 'action', text: '导出 xhdpi 尺寸' },
    });
    expect(byId.get('asking')).toMatchObject({ state: 'waiting', line: { kind: 'waiting' } });
    expect(byId.get('bg-queued')).toMatchObject({ state: 'queued', origin: 'delegated' });
  });

  it('lists every recent Cindy task, but external sessions only when judged worth continuing', () => {
    const judgment = (verdict: 'unfinished' | 'idea' | 'done', title: string, project = ART) => ({
      title,
      verdict,
      next: verdict === 'done' ? null : `${title}的下一步`,
      project,
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
    const tiles = buildWorkbenchTiles({
      ...base,
      sessions: [
        session('running', { title: '<system-reminder>x</system-reminder>导出图标' }),
        session('unjudged-idle', { preview: '12 条意见' }),
        session('unjudged-errored'),
        session('judged-unfinished', { title: '原始标题' }),
        session('judged-done'),
        session('claude-imported', { agentKind: 'cc' }),
      ],
      activity: new Map([['running', { phase: 'running' }]]),
      erroredIds: new Set(['unjudged-errored']),
      judgments: {
        'judged-unfinished': judgment('unfinished', '补描边'),
        'judged-done': judgment('done', '整理意见'),
        'claude-imported': judgment('idea', '换图标风格'),
        'claude:ext-1': judgment('unfinished', '压缩原画'),
        'codex:ext-2': judgment('idea', '加自动导出'),
        'codex:ext-done': judgment('done', '问答'),
        'codex:ext-elsewhere': judgment('unfinished', '别的项目', CINDY),
      },
      candidates: [{ source: 'claude', id: 'ext-1', projectDir: ART, updatedAt: '2026-10-01T05:00:00.000Z', archived: false }],
    });
    const byId = new Map(tiles.map((tile) => [tile.id, tile]));
    // Cindy 任务(含主人自己开的空闲任务、判为 done 的)都在;外部会话只留判为值得继续的。
    expect([...byId.keys()].sort()).toEqual(
      [
        'claude-imported',
        'claude:ext-1',
        'codex:ext-2',
        'judged-done',
        'judged-unfinished',
        'running',
        'unjudged-errored',
        'unjudged-idle',
      ].sort(),
    );
    expect(byId.has('codex:ext-done')).toBe(false);
    expect(byId.has('codex:ext-elsewhere')).toBe(false);
    expect(byId.get('running')).toMatchObject({ title: '导出图标', verdict: null });
    expect(byId.get('judged-unfinished')).toMatchObject({ title: '补描边', verdict: 'unfinished', next: '补描边的下一步' });
    expect(byId.get('claude-imported')).toMatchObject({ verdict: 'idea', origin: 'claude-code' });
    expect(byId.get('claude:ext-1')).toMatchObject({
      type: 'external',
      origin: 'claude-code',
      verdict: 'unfinished',
      lastActiveMs: Date.parse('2026-10-01T05:00:00.000Z'),
    });
    expect(byId.get('codex:ext-2')).toMatchObject({ type: 'external', origin: 'codex', verdict: 'idea' });
    // Live first, then unfinished, then ideas, then the rest.
    expect(tiles.slice(0, 5).map((tile) => ('verdict' in tile ? tile.verdict : null))).toEqual([
      null,
      'unfinished',
      'unfinished',
      'idea',
      'idea',
    ]);
    expect(groupWorkbenchTiles(tiles).map((group) => [group.key, group.tiles.map((tile) => tile.id).sort()])).toEqual([
      ['waiting', ['unjudged-errored']],
      ['running', ['running']],
      ['todo', ['claude-imported', 'claude:ext-1', 'codex:ext-2', 'judged-unfinished'].sort()],
      ['done', ['judged-done', 'unjudged-idle']],
    ]);
  });

  it('shows Pi sessions and PR / issue / idea entries the Bot wrote down, labelled by kind', () => {
    const judgment = (verdict: 'unfinished' | 'idea' | 'done', title: string, extra: Record<string, unknown> = {}) => ({
      title,
      verdict,
      next: verdict === 'done' ? null : `${title}的下一步`,
      project: ART,
      updatedAt: '2026-10-01T00:00:00.000Z',
      ...extra,
    });
    const tiles = buildWorkbenchTiles({
      ...base,
      sessions: [],
      judgments: {
        'pi:p1': judgment('unfinished', '写文档'),
        'pr:me/art#12': judgment('unfinished', '图标 PR', { ref: 'https://github.com/me/art/pull/12' }),
        'issue:me/art#7': judgment('idea', '暗色图标'),
        'idea:dark-icons': judgment('idea', '补一套暗色', { ref: `${ART}/DESIGN.md` }),
        'idea:done-one': judgment('done', '已做完'),
        'idea:elsewhere': judgment('idea', '别的项目', { project: CINDY }),
      },
    });
    const byId = new Map(tiles.map((tile) => [tile.id, tile]));
    expect([...byId.keys()].sort()).toEqual(['idea:dark-icons', 'issue:me/art#7', 'pi:p1', 'pr:me/art#12']);
    expect(byId.get('pi:p1')).toMatchObject({ type: 'external', origin: 'pi', verdict: 'unfinished' });
    expect(byId.get('pr:me/art#12')).toMatchObject({
      type: 'item',
      itemKind: 'pr',
      number: 12,
      ref: 'https://github.com/me/art/pull/12',
      project: ART,
    });
    expect(byId.get('issue:me/art#7')).toMatchObject({ type: 'item', itemKind: 'issue', number: 7, ref: null });
    expect(byId.get('idea:dark-icons')).toMatchObject({ type: 'item', itemKind: 'idea', number: null, ref: `${ART}/DESIGN.md` });
  });

  it('shows a task the owner just opened in the project, and drops ones idle for over 30 days', () => {
    const now = Date.parse('2026-10-02T00:00:00.000Z');
    const tiles = buildWorkbenchTiles({
      ...base,
      now,
      sessions: [
        session('just-opened', { userSendAt: '2026-10-01T23:59:00.000Z', updatedAt: '2026-10-01T23:59:00.000Z' }),
        session('stale', { userSendAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z' }),
        session('stale-bg', { userSendAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z' }),
      ],
      delegations: [{ ...delegation('stale-bg', 'completed'), updatedAt: 1 }],
      candidates: [{ source: 'codex', id: 'unjudged', projectDir: ART, updatedAt: '2026-10-01T00:00:00.000Z', archived: false }],
    });
    expect(tiles.map((tile) => tile.id).sort()).toEqual(['just-opened', 'stale-bg']);
    expect(workbenchTileGroup(tiles.find((tile) => tile.id === 'just-opened')!)).toBe('done');
  });

  it('keeps Bot hidden sessions, other projects, drafts, remote, archived and non-task sources out', () => {
    const live = (id: string) => [id, { phase: 'running' }] as const;
    const ids = ['kept', 'bot-main', 'bot-source', 'elsewhere', 'draft', 'remote', 'device', 'archived', 'automation-run', 'worker'];
    const tiles = buildWorkbenchTiles({
      ...base,
      hiddenIds: new Set(['bot-main']),
      activity: new Map(ids.map(live)),
      sessions: [
        session('kept'),
        session('bot-main'),
        session('bot-source', { source: 'bot' }),
        session('elsewhere', { workingDir: CINDY }),
        session('draft', { userSendAt: null, _count: { messages: 0 } }),
        session('remote', { remoteHostId: 'ssh-1' }),
        session('device', { deviceLinkDeviceId: 'mac-2' }),
        session('archived', { status: 'archived' }),
        session('automation-run', { source: 'scheduler' }),
        session('worker', { orcaRole: 'worker' }),
      ],
    });
    expect(tiles.map((tile) => tile.id)).toEqual(['kept']);
  });

  it('counts only external candidates the Bot has not judged yet, never Cindy tasks', () => {
    expect(
      countUnjudgedCandidates({
        projectDirs: [ART],
        caseInsensitive: false,
        candidates: [
          { source: 'claude', id: 'x', projectDir: ART, updatedAt: '2026-10-01T00:00:00.000Z', archived: false },
          { source: 'codex', id: 'y', projectDir: ART, updatedAt: '2026-10-01T00:00:00.000Z', archived: false },
          { source: 'codex', id: 'z', projectDir: ART, updatedAt: '2026-10-01T00:00:00.000Z', archived: true },
        ],
        judgments: {
          a: { title: 'a', verdict: 'done', next: null, project: ART, updatedAt: 'x' },
          'claude:x': { title: 'x', verdict: 'idea', next: 'n', project: ART, updatedAt: 'x' },
        },
      }),
    ).toBe(1);
  });

  it('includes project automations and the Bot own routines, disabled ones as stopped', () => {
    const tiles = buildWorkbenchTiles({
      ...base,
      sessions: [],
      schedules: [
        { id: 's-1', name: '检查 PR', status: 'active', workspaceKind: 'project', workingDir: ART, cronExpr: '0 * * * *', nextFireAt: 99 },
        { id: 's-2', name: '暂停的', status: 'paused', workspaceKind: 'project', workingDir: ART },
        { id: 's-3', name: '别的项目', status: 'active', workspaceKind: 'project', workingDir: CINDY },
        { id: 's-4', name: '伙伴内部', status: 'active', source: 'bot', workspaceKind: 'project', workingDir: ART },
      ],
      routines: [
        { id: 'r-1', name: '巡检', enabled: true, triggers: [], updatedAt: 1, lastRun: { status: 'success', createdAt: 1, resultText: '没有异常' } },
        { id: 'r-2', name: '导入的提醒', enabled: false, triggers: [], updatedAt: 1 },
        { id: 'r-3', name: '正在跑', enabled: true, activity: 'running', triggers: [], updatedAt: 1 },
      ],
    });
    const byId = new Map(tiles.map((tile) => [tile.id, tile]));
    expect(byId.get('s-1')).toMatchObject({ type: 'schedule', state: 'automation', line: { kind: 'next', at: 99 } });
    expect(byId.get('s-2')).toMatchObject({ state: 'stopped', line: { kind: 'paused' } });
    expect(byId.has('s-3')).toBe(false);
    expect(byId.has('s-4')).toBe(false);
    expect(byId.get('r-1')).toMatchObject({ type: 'routine', state: 'automation', line: { kind: 'last-run', ok: true, text: '没有异常' } });
    expect(byId.get('r-2')).toMatchObject({ state: 'stopped', line: { kind: 'disabled' } });
    expect(byId.get('r-3')).toMatchObject({ state: 'running' });
  });

  it('shows nothing from projects when none was handed over, but still lists routines', () => {
    const tiles = buildWorkbenchTiles({
      ...base,
      projectDirs: [],
      sessions: [session('kept')],
      routines: [{ id: 'r-1', name: '每日提醒', enabled: true, triggers: [], updatedAt: 1 }],
    });
    expect(tiles.map((tile) => tile.id)).toEqual(['r-1']);
  });
});

describe('groupWorkbenchTiles', () => {
  const judgment = (verdict: 'unfinished' | 'idea', title: string) => ({
    title,
    verdict,
    next: `${title}的下一步`,
    project: ART,
    updatedAt: '2026-10-01T00:00:00.000Z',
  });

  function fixture() {
    return buildWorkbenchTiles({
      ...base,
      sessions: [
        session('waiting'),
        session('errored'),
        session('running'),
        session('queued-bg'),
        session('judged', { updatedAt: '2026-10-01T03:00:00.000Z' }),
        session('finished-bg', { updatedAt: '2026-10-01T02:00:00.000Z' }),
        session('failed-bg'),
      ],
      activity: new Map([
        ['waiting', { phase: 'needs-interaction' }],
        ['running', { phase: 'running', startedAtMs: 5 }],
      ]),
      erroredIds: new Set(['errored']),
      delegations: [
        delegation('queued-bg', 'queued'),
        delegation('finished-bg', 'completed'),
        delegation('failed-bg', 'failed'),
      ],
      judgments: {
        judged: judgment('unfinished', '补描边'),
        // 出错停下的任务即使伙伴判为没做完,也先放「等你」。
        errored: judgment('unfinished', '导出报错'),
        'idea:dark-icons': judgment('idea', '暗色图标'),
        'pr:me/art#12': judgment('unfinished', '图标 PR'),
      },
      schedules: [
        { id: 's-idle', name: '检查 PR', status: 'active', workspaceKind: 'project', workingDir: ART, nextFireAt: 99 },
        { id: 's-off', name: '暂停的', status: 'paused', workspaceKind: 'project', workingDir: ART },
      ],
      routines: [{ id: 'r-run', name: '每日整理', enabled: true, activity: 'running', triggers: [], updatedAt: 1 }],
    });
  }

  it('sorts every tile into waiting / running / to do / done', () => {
    const groupOf = new Map(fixture().map((tile) => [tile.id, workbenchTileGroup(tile)]));
    expect(Object.fromEntries(groupOf)).toEqual({
      waiting: 'waiting',
      errored: 'waiting',
      'failed-bg': 'waiting',
      running: 'running',
      'r-run': 'running',
      'queued-bg': 'todo',
      judged: 'todo',
      'idea:dark-icons': 'todo',
      'pr:me/art#12': 'todo',
      'finished-bg': 'done',
      's-idle': 'done',
      's-off': 'done',
    });
  });

  it('keeps the fixed group order, collapses only done and reports its count', () => {
    const groups = groupWorkbenchTiles(fixture());
    expect(groups.map((group) => [group.key, group.defaultCollapsed])).toEqual([
      ['waiting', false],
      ['running', false],
      ['todo', false],
      ['done', true],
    ]);
    expect(groups.find((group) => group.key === 'done')!.tiles).toHaveLength(3);
  });

  it('lists at most 30 done entries and reports the older ones as a count', () => {
    const now = Date.parse('2026-10-02T00:00:00.000Z');
    const tiles = buildWorkbenchTiles({
      ...base,
      now,
      sessions: Array.from({ length: 33 }, (_, index) =>
        session(`t-${index}`, {
          updatedAt: new Date(now - (index + 1) * 60_000).toISOString(),
          userSendAt: new Date(now - (index + 1) * 60_000).toISOString(),
        }),
      ),
    });
    const done = groupWorkbenchTiles(tiles).find((group) => group.key === 'done')!;
    expect(done).toMatchObject({ total: 33, hiddenCount: 3, defaultCollapsed: true });
    expect(done.tiles).toHaveLength(30);
    expect(done.tiles[0]!.id).toBe('t-0');
  });

  it('offers 跟进 only on to-do and waiting entries', () => {
    const withFollowUp = groupWorkbenchTiles(fixture())
      .filter((group) => workbenchGroupHasFollowUp(group.key))
      .map((group) => group.key);
    expect(withFollowUp).toEqual(['waiting', 'todo']);
    expect(workbenchGroupHasFollowUp('running')).toBe(false);
    expect(workbenchGroupHasFollowUp('done')).toBe(false);
  });

  it('keeps the Bot own background tasks in the groups by their real state', () => {
    const groupOf = new Map(fixture().map((tile) => [tile.id, workbenchTileGroup(tile)]));
    expect([groupOf.get('queued-bg'), groupOf.get('failed-bg'), groupOf.get('finished-bg')]).toEqual(['todo', 'waiting', 'done']);
  });

  it('leaves empty groups out', () => {
    const tiles = buildWorkbenchTiles({
      ...base,
      sessions: [],
      judgments: { 'idea:dark-icons': judgment('idea', '暗色图标') },
    });
    expect(groupWorkbenchTiles(tiles).map((group) => group.key)).toEqual(['todo']);
    expect(groupWorkbenchTiles([])).toEqual([]);
  });
});

describe('buildWorkbenchProjectOptions', () => {
  it('merges local projects with Claude Code / Codex candidates and counts automations', () => {
    const options = buildWorkbenchProjectOptions({
      sessions: [
        session('a1', { userSendAt: '2026-10-01T05:00:00.000Z' }),
        session('a2'),
        session('c1', { workingDir: CINDY, userSendAt: '2026-09-01T00:00:00.000Z' }),
        session('hidden', { workingDir: '/Users/me/Code/secret' }),
        session('dialogue', { workingDir: '/tmp/dialogue', workspaceKind: 'dialogue' }),
      ],
      hiddenIds: new Set(['hidden']),
      schedules: [{ id: 's-1', name: 'PR', status: 'active', workspaceKind: 'project', workingDir: ART }],
      candidates: [
        { source: 'claude', id: 'x1', projectDir: ART, updatedAt: '2026-09-30T00:00:00.000Z', archived: false },
        { source: 'codex', id: 'x2', projectDir: '/Users/me/Code/only-codex', updatedAt: '2026-10-01T09:00:00.000Z', archived: false },
        { source: 'claude', id: 'x3', projectDir: CINDY, updatedAt: '2026-09-30T00:00:00.000Z', archived: true },
      ],
      localPlatform: 'darwin',
      caseInsensitive: false,
    });
    expect(options.map((option) => [option.name, option.taskCount, option.automationCount, option.claudeCount, option.codexCount]))
      .toEqual([
        ['only-codex', 0, 0, 0, 1],
        ['tapmon-art', 2, 1, 1, 0],
        ['cindy', 1, 0, 0, 0],
      ]);
  });

  it('leaves out projects already handed over', () => {
    const options = buildWorkbenchProjectOptions({
      sessions: [session('a1'), session('c1', { workingDir: CINDY })],
      hiddenIds: new Set(),
      schedules: [],
      candidates: [],
      localPlatform: 'darwin',
      caseInsensitive: false,
      excludeDirs: [ART],
    });
    expect(options.map((option) => option.name)).toEqual(['cindy']);
  });
});

describe('hidden sessions', () => {
  it('collects every Bot-linked session from the profile projection', () => {
    expect(collectBotHiddenSessionIds([{ sessions: [{ id: 'a' }, { id: 'b' }] }, { sessions: [{ id: 'c' }] }]))
      .toEqual(new Set(['a', 'b', 'c']));
  });
});

describe('project picker filtering and tiers', () => {
  const NOW = Date.UTC(2026, 9, 1);
  const DAY = 24 * 60 * 60 * 1000;
  const hints = {
    homeDir: '/Users/me',
    userDataDir: '/Users/me/Library/Application Support/Cindy Dev',
    tempDirs: ['/var/folders/ab/T'],
  };
  const option = (dir: string, patch: Partial<WorkbenchProjectOption> = {}): WorkbenchProjectOption => ({
    dir,
    name: dir.split('/').pop() ?? dir,
    taskCount: 0,
    automationCount: 0,
    claudeCount: 0,
    codexCount: 0,
    latestActivityMs: NOW - DAY,
    isGitRepo: false,
    ...patch,
  });

  it('drops the home folder, Cindy data, Bot workspaces and temp / tool caches', () => {
    for (const dir of [
      '/Users/me',
      '/Users/me/Library/Application Support/Cindy Dev/owner/bots/b1/workspace',
      '/tmp/scratch',
      '/private/tmp/x',
      '/var/folders/ab/T/cli_aae4',
      '/Users/me/Library/Caches/foo',
      '/Users/me/.cache/x',
      '/Users/me/.codex/sessions',
      '/Users/me/.claude/projects/x',
      '/Users/me/.cindy',
      '/Users/me/.cursor/worktrees/a',
    ]) {
      expect(isNonProjectDir(dir, hints, false), dir).toBe(true);
    }
    expect(isNonProjectDir('/Users/me/Code/cindy', hints, false)).toBe(false);
    // Without host hints the common home shapes are still recognized.
    expect(isNonProjectDir('/Users/someone', null, false)).toBe(true);
    expect(isNonProjectDir('/Users/someone/.codex/x', null, false)).toBe(true);
    expect(isNonProjectDir('C:/Users/me', null, true)).toBe(true);
  });

  it('recognizes generated directory names but not ordinary ones', () => {
    for (const name of [
      '6a7a8ec7-7e91-440b-9c1d-2f3e4a5b6c7d',
      '1a34b5b6-0000-4000-8000-000000000000',
      'cli_aae4722842785d27',
      'telegram-8678037594',
      'a1b2c3d4e5f60718',
    ]) {
      expect(looksGeneratedDirName(name), name).toBe(true);
    }
    for (const name of ['cindy', 'filoai-frontend', 'photos-gps', '3-codex', 'sprint-12', 'tapmon-art']) {
      expect(looksGeneratedDirName(name), name).toBe(false);
    }
  });

  it('puts git repos, Cindy projects and busy folders first, folds the rest', () => {
    const { primary, folded } = tierWorkbenchProjectOptions(
      [
        option('/Users/me/Code/cindy', { isGitRepo: true, latestActivityMs: NOW - 1 }),
        option('/Users/me/Code/filoai-frontend', { codexCount: 3, latestActivityMs: NOW - 2 }),
        option('/Users/me/Code/notes', { taskCount: 1 }),
        option('/Users/me', { taskCount: 9 }),
        option('/Users/me/Library/Application Support/Cindy Dev/o/bots/b/workspace', { taskCount: 4 }),
        option('/Users/me/tmp/6a7a8ec7-7e91-440b-9c1d-2f3e4a5b6c7d', { taskCount: 5, isGitRepo: true }),
        option('/Users/me/Code/photos-gps', { claudeCount: 1, latestActivityMs: NOW - 30 * DAY }),
        option('/Users/me/Code/3-codex', { codexCount: 1 }),
      ],
      { hints, caseInsensitive: false, now: NOW },
    );
    expect(primary.map((item) => item.name)).toEqual(['cindy', 'filoai-frontend', 'notes']);
    expect(folded.map((item) => item.name)).toEqual([
      '3-codex',
      '6a7a8ec7-7e91-440b-9c1d-2f3e4a5b6c7d',
      'photos-gps',
    ]);
  });

  it('shows at most five first-tier rows and folds the overflow by recency', () => {
    const options = Array.from({ length: 7 }, (_, index) =>
      option(`/Users/me/Code/p${index}`, { isGitRepo: true, latestActivityMs: NOW - index * DAY }),
    );
    const { primary, folded } = tierWorkbenchProjectOptions(options, { hints, caseInsensitive: false, now: NOW });
    expect(primary.map((item) => item.name)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
    expect(folded.map((item) => item.name)).toEqual(['p5', 'p6']);
  });

  it('marks git repositories reported by the host scan', () => {
    const [cindy] = buildWorkbenchProjectOptions({
      sessions: [session('c1', { workingDir: CINDY })],
      hiddenIds: new Set(),
      schedules: [],
      candidates: [],
      gitRepoDirs: [CINDY],
      localPlatform: 'darwin',
      caseInsensitive: false,
    });
    expect(cindy).toMatchObject({ name: 'cindy', isGitRepo: true });
  });
});

it('retains an entrusted legacy local reference entrance until equivalent migration', () => {
  const tiles = buildWorkbenchTiles({
    ...base,
    projectDirs: [CINDY],
    sessions: [],
    judgments: {
      'idea:local': {
        project: CINDY,
        title: '本地方案',
        next: '查看文件',
        verdict: 'idea',
        ref: CINDY + '/notes.md',
        updatedAt: new Date(base.now).toISOString(),
      },
      'idea:web': {
        project: CINDY,
        title: '网上方案',
        next: '查看',
        verdict: 'idea',
        ref: 'https://example.test/notes',
        updatedAt: new Date(base.now).toISOString(),
      },
      'idea:outside': {
        project: CINDY,
        title: '外部路径',
        next: '查看',
        verdict: 'idea',
        ref: '/private/notes.md',
        updatedAt: new Date(base.now).toISOString(),
      },
    },
  });
  const kept = tiles.filter((tile) => workbenchItemNeedsLocalReference(tile, [CINDY], false));
  expect(kept.map((tile) => tile.id)).toEqual(['idea:local']);
  expect(workbenchItemNeedsLocalReference(kept[0], [], false)).toBe(false);
});
