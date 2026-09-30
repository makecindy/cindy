import { describe, expect, it } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';
import {
  buildWorkbenchProjectOptions,
  buildWorkbenchTiles,
  collectBotHiddenSessionIds,
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

  it('includes project automations, paused ones as stopped', () => {
    const tiles = buildWorkbenchTiles({
      ...base,
      sessions: [],
      schedules: [
        { id: 's-1', name: '检查 PR', status: 'active', workspaceKind: 'project', workingDir: ART, cronExpr: '0 * * * *', nextFireAt: 99 },
        { id: 's-2', name: '暂停的', status: 'paused', workspaceKind: 'project', workingDir: ART },
        { id: 's-3', name: '别的项目', status: 'active', workspaceKind: 'project', workingDir: CINDY },
        { id: 's-4', name: '伙伴内部', status: 'active', source: 'bot', workspaceKind: 'project', workingDir: ART },
      ],
    });
    const byId = new Map(tiles.map((tile) => [tile.id, tile]));
    expect(byId.get('s-1')).toMatchObject({ type: 'schedule', state: 'automation', line: { kind: 'next', at: 99 } });
    expect(byId.get('s-2')).toMatchObject({ state: 'stopped', line: { kind: 'paused' } });
    expect(byId.has('s-3')).toBe(false);
    expect(byId.has('s-4')).toBe(false);
  });

  it('shows nothing when no project was handed over', () => {
    const tiles = buildWorkbenchTiles({ ...base, projectDirs: [], sessions: [session('kept')] });
    expect(tiles).toEqual([]);
  });
});

describe('buildWorkbenchProjectOptions', () => {
  it('lists local projects with their task and automation counts', () => {
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
      localPlatform: 'darwin',
      caseInsensitive: false,
    });
    expect(options.map((option) => [option.name, option.taskCount, option.automationCount])).toEqual([
      ['tapmon-art', 2, 1],
      ['cindy', 1, 0],
    ]);
  });

  it('leaves out projects already handed over', () => {
    const options = buildWorkbenchProjectOptions({
      sessions: [session('a1'), session('c1', { workingDir: CINDY })],
      hiddenIds: new Set(),
      schedules: [],
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
