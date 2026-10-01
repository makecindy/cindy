import { describe, expect, it } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';
import {
  buildWorkbenchProjectOptions,
  buildWorkbenchTiles,
  collectBotHiddenSessionIds,
  isNonProjectDir,
  looksGeneratedDirName,
  pickImportCandidates,
  tierWorkbenchProjectOptions,
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
};

describe('buildWorkbenchTiles', () => {
  it('derives each tile state from host signals only', () => {
    const tiles = buildWorkbenchTiles({
      ...base,
      sessions: [
        session('running'),
        session('asking'),
        session('interrupted', { activeTurnStartedAt: 10, interruptedTurnStartedAt: 10, lastTurnEndedAt: 5 }),
        session('errored'),
        session('idle', { preview: '12 条意见，3 条要改' }),
        session('bg-queued', { userSendAt: null }),
        session('claude-imported', { agentKind: 'cc' }),
      ],
      delegations: [delegation('bg-queued', 'queued')],
      activity: new Map([
        ['running', { phase: 'running', startedAtMs: 500, currentActionSummary: '导出 xhdpi 尺寸' }],
        ['asking', { phase: 'needs-interaction' }],
      ]),
      erroredIds: new Set(['errored']),
    });
    const byId = new Map(tiles.map((tile) => [tile.id, tile]));
    expect(byId.get('running')).toMatchObject({
      state: 'running',
      startedAtMs: 500,
      line: { kind: 'action', text: '导出 xhdpi 尺寸' },
    });
    expect(byId.get('asking')).toMatchObject({ state: 'waiting', line: { kind: 'waiting' } });
    expect(byId.get('interrupted')).toMatchObject({ state: 'stopped', line: { kind: 'interrupted' } });
    expect(byId.get('errored')).toMatchObject({ state: 'stopped', line: { kind: 'errored' } });
    expect(byId.get('idle')).toMatchObject({ state: 'done', line: { kind: 'summary', text: '12 条意见，3 条要改' } });
    expect(byId.get('bg-queued')).toMatchObject({ state: 'queued', origin: 'delegated' });
    expect(byId.get('claude-imported')).toMatchObject({ origin: 'claude-code' });
    // Live / attention tiles come before finished ones.
    expect(tiles.at(-1)?.state).toBe('done');
  });

  it('keeps Bot hidden sessions, other projects, drafts, remote, archived and non-task sources out', () => {
    const tiles = buildWorkbenchTiles({
      ...base,
      hiddenIds: new Set(['bot-main']),
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

describe('import candidates and hidden sessions', () => {
  it('picks the most recent unarchived candidates of the chosen project, bounded', () => {
    const candidates = Array.from({ length: 5 }, (_, index) => ({
      source: 'claude' as const,
      id: `c${index}`,
      projectDir: ART,
      updatedAt: new Date(Date.UTC(2026, 8, index + 1)).toISOString(),
      archived: index === 4,
    }));
    const result = pickImportCandidates(
      [...candidates, { source: 'codex', id: 'other', projectDir: CINDY, updatedAt: '2026-10-01T00:00:00.000Z', archived: false }],
      ART,
      false,
      2,
    );
    expect(result.total).toBe(4);
    expect(result.picked.map((item) => item.id)).toEqual(['c3', 'c2']);
  });

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
