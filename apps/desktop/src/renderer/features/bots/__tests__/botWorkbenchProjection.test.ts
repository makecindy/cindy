import { describe, expect, it } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';
import {
  buildWorkbenchProjectOptions,
  buildWorkbenchTiles,
  collectBotHiddenSessionIds,
  pickImportCandidates,
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
