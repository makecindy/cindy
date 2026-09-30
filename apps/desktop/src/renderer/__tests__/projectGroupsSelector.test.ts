import { describe, expect, it } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';
import { groupSessions, type GroupSessionsOptions } from '@/features/cc-agent/lib/projectGrouping';
import { createProjectGroupsSelector } from '@/features/cc-agent/lib/projectGroupsSelector';
import { sessionCardVisualCases } from '@/features/cc-agent/sidebar/__fixtures__/sessionCardVisualCases';

function fixtures(): Session[] {
  return Array.from({ length: 1000 }, (_, i) => ({
    ...sessionCardVisualCases[0].session,
    id: `task-${i}`,
    title: `Task ${i}`,
    workingDir: `/projects/project-${i % 25}`,
    pinnedAt: i % 29 === 0 ? '2026-09-01T00:00:00.000Z' : null,
    userSendAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
  }));
}

describe('project grouping structural reuse', () => {
  it('updates timestamp/preview/spend without rebuilding untouched groups or stale row data', () => {
    const select = createProjectGroupsSelector();
    const sessions = fixtures();
    const before = select(sessions, {});
    const next = sessions.slice();
    next[1] = {
      ...next[1],
      updatedAt: '2026-09-15T00:00:00.000Z',
      preview: 'new',
      totalCostUsd: 3,
    };
    const after = select(next, {});
    expect(after).toEqual(groupSessions(next));
    expect(after.pinned).toBe(before.pinned);
    expect(after.projects.filter((p, i) => p === before.projects[i])).toHaveLength(24);
    expect(after.projects.flatMap((p) => p.sessions).find((s) => s.id === next[1].id)).toBe(
      next[1],
    );
    expect(select(next.slice(), {})).toBe(after);
  });

  it.each<Partial<Session>>([
    { userSendAt: '2026-09-20T00:00:00.000Z' },
    { workingDir: '/different/project' },
    { workspaceKind: 'dialogue' },
    { status: 'archived' },
    { pinnedAt: '2026-09-20T00:00:00.000Z' },
    { deviceLinkDeviceId: 'remote', deviceLinkDeviceName: 'Machine' },
    { deviceLinkConnectionStatus: 'disconnected' },
    { title: 'renamed' },
    { createdAt: '2020-01-01T00:00:00.000Z' },
    { _count: { messages: 0 } },
  ])('matches canonical grouping after mutation %j', (patch) => {
    const select = createProjectGroupsSelector();
    const sessions = fixtures();
    select(sessions, {});
    const next = sessions.slice();
    next[1] = { ...next[1], ...patch };
    expect(select(next, {})).toEqual(groupSessions(next));
  });

  it('preserves updatedAt sorting fallback for unsent tasks and draft placement', () => {
    const select = createProjectGroupsSelector();
    const sessions = fixtures();
    sessions[1] = { ...sessions[1], userSendAt: null, _count: { messages: 0 } };
    select(sessions, {});
    const next = sessions.slice();
    next[1] = { ...next[1], updatedAt: '2026-09-20T00:00:00.000Z' };
    expect(select(next, {})).toEqual(groupSessions(next));
    const withMessage = next.map((s, i) => (i === 1 ? { ...s, _count: { messages: 1 } } : s));
    expect(select(withMessage, {})).toEqual(groupSessions(withMessage));
  });

  it('invalidates aliases, persistent projects, bots, pin inclusion, insertion and removal', () => {
    const select = createProjectGroupsSelector();
    let sessions = fixtures();
    const options: GroupSessionsOptions[] = [
      {},
      { includePinnedInProjects: true },
      { projectAliases: new Map([['/projects/project-1', 'Alias']]) },
      {
        persistentLocalProjects: [
          { workingDir: '/empty', lastUsedAt: '2026-09-20', knownAgentKinds: ['cc'] },
        ],
      },
      {
        botOwnerBySessionId: new Map([
          ['task-1', { botId: 'bot', displayName: 'Bot', avatar: '', avatarColor: '' }],
        ]),
      },
    ];
    for (const option of options) {
      expect(select(sessions, option)).toEqual(groupSessions(sessions, option));
      sessions = sessions.slice(1);
      expect(select(sessions, option)).toEqual(groupSessions(sessions, option));
    }
    sessions = [...fixtures().slice(0, 1), ...sessions];
    expect(select(sessions, {})).toEqual(groupSessions(sessions));
  });

  it('reuses equivalent persistent catalogues while retaining fresh pinned, dialogue and bot rows', () => {
    const select = createProjectGroupsSelector();
    const sessions = fixtures();
    sessions[1] = { ...sessions[1], workspaceKind: 'dialogue' };
    const options: GroupSessionsOptions = {
      includePinnedInProjects: true,
      persistentLocalProjects: [
        { workingDir: '/empty', lastUsedAt: '2026-09-01', knownAgentKinds: ['cc'] },
      ],
      botOwnerBySessionId: new Map([
        ['task-2', { botId: 'b', displayName: 'Bot', avatar: '', avatarColor: '' }],
      ]),
    };
    const before = select(sessions, options);
    const next = sessions.map((s, i) =>
      i < 3 ? { ...s, title: 'fresh', updatedAt: '2026-09-20' } : s,
    );
    const after = select(next, {
      ...options,
      persistentLocalProjects: structuredClone(options.persistentLocalProjects),
    });
    expect(after).toEqual(groupSessions(next, options));
    expect(after.pinned[0]).toBe(next[0]);
    expect(after.dialogues[0]).toBe(next[1]);
    expect(after.bots[0].sessions[0]).toBe(next[2]);
    expect(after.projects.filter((p, i) => p === before.projects[i]).length).toBeGreaterThan(20);
  });
});

function session(id: string, patch: Partial<Session> = {}): Session {
  return {
    id,
    title: id,
    workingDir: `/workspace/${id}`,
    workspaceKind: 'project',
    status: 'active',
    pinnedAt: null,
    userSendAt: '2026-08-01T00:00:00Z',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    _count: { messages: 1 },
    ...patch,
  } as Session;
}

describe('project grouping projection', () => {
  it('publishes row patches in every bucket without invalidating unrelated projects', () => {
    const rows = [session('a', { pinnedAt: '2026-08-01T00:00:00Z' }), session('b')];
    const options = { includePinnedInProjects: true };
    const select = createProjectGroupsSelector();
    const before = select(rows, options);
    const changed = {
      ...rows[0],
      title: 'new title',
      totalCostUsd: 12,
      updatedAt: '2026-08-02T00:00:00Z',
      _count: { messages: 20 },
    };
    const after = select([changed, rows[1]], options);
    expect(after).toEqual(groupSessions([changed, rows[1]], options));
    expect(after.pinned[0]).toBe(changed);
    expect(after.projects.find((p) => p.workingDir.endsWith('/a'))?.sessions[0]).toBe(changed);
    expect(after.projects.find((p) => p.workingDir.endsWith('/b'))).toBe(
      before.projects.find((p) => p.workingDir.endsWith('/b')),
    );
    expect(after.dialogues).toBe(before.dialogues);
    expect(select([changed, rows[1]], options)).toBe(after);
  });

  it.each([
    { workingDir: '/other/repo' },
    { pinnedAt: '2026-09-01T00:00:00Z' },
    { status: 'archived' },
    { workspaceKind: 'dialogue' },
    { userSendAt: '2026-09-01T00:00:00Z' },
    { createdAt: '2020-01-01T00:00:00Z' },
    { remoteHostId: 'ssh-host' },
    { deviceLinkDeviceId: 'device', deviceLinkDeviceName: 'Mac' },
    { deviceLinkConnectionStatus: 'disconnected' },
    { source: 'scheduler' },
    { orcaRole: 'lead' },
    { agentKind: 'pi' },
  ] as Partial<Session>[])(
    'matches canonical regrouping when structural fields change: %j',
    (patch) => {
      const rows = [session('a'), session('b', { workingDir: '/other/a' })];
      const select = createProjectGroupsSelector();
      select(rows);
      const changed = [{ ...rows[0], ...patch }, rows[1]];
      expect(select(changed)).toEqual(groupSessions(changed));
    },
  );

  it('invalidates first-message classification and the fallback draft clock', () => {
    const draft = session('draft', { userSendAt: null, _count: { messages: 0 } });
    const select = createProjectGroupsSelector();
    expect(select([draft]).unclassified).toHaveLength(1);
    const firstReply = { ...draft, _count: { messages: 1 } };
    expect(select([firstReply])).toEqual(groupSessions([firstReply]));
    expect(select([firstReply]).projects).toHaveLength(1);
    const later = { ...firstReply, updatedAt: '2026-09-01T00:00:00Z' };
    expect(select([later]).projects[0].latestActivityAt).toBe(later.updatedAt);
  });

  it('preserves stable-sort input order and resets on removal or empty data', () => {
    const rows = [session('a', { workingDir: '/same' }), session('b', { workingDir: '/same' })];
    const select = createProjectGroupsSelector();
    select(rows);
    for (const next of [[rows[1], rows[0]], [rows[1]], [], rows]) {
      expect(select(next)).toEqual(groupSessions(next));
    }
  });

  it('invalidates aliases, platform, pinned/draft policy, persistent projects and bot ownership', () => {
    const rows = [session('a')];
    const select = createProjectGroupsSelector();
    const policies: GroupSessionsOptions[] = [
      {},
      { projectAliases: new Map([['local:/workspace/a', 'Alias']]) },
      { localPlatform: 'win32' },
      { includePinnedInProjects: true },
      { includeDraftsInProjects: true },
      {
        persistentLocalProjects: [
          { workingDir: '/empty', lastUsedAt: '2026-09-01T00:00:00Z', knownAgentKinds: ['pi'] },
        ],
      },
      {
        botOwnerBySessionId: new Map([
          ['a', { botId: 'bot', displayName: 'Bot', avatar: 'star', avatarColor: 'blue' }],
        ]),
      },
    ];
    for (const options of policies)
      expect(select(rows, options)).toEqual(groupSessions(rows, options));
    const options = policies.at(-1)!;
    const updated = [{ ...rows[0], title: 'bot row update' }];
    expect(select(updated, options)).toEqual(groupSessions(updated, options));
    expect(select(updated, options).bots[0].sessions[0]).toBe(updated[0]);
  });

  it('reuses equal persistent catalogues but refreshes changed project metadata', () => {
    const rows = [session('a')];
    const projects = [
      { workingDir: '/empty', lastUsedAt: '2026-09-01T00:00:00Z', knownAgentKinds: ['pi'] },
    ];
    const select = createProjectGroupsSelector();
    const first = select(rows, { persistentLocalProjects: projects });
    expect(
      select(rows, {
        persistentLocalProjects: projects.map((p) => ({
          ...p,
          knownAgentKinds: [...p.knownAgentKinds],
        })),
      }),
    ).toBe(first);
    const changed = { persistentLocalProjects: [{ ...projects[0], knownAgentKinds: ['cc'] }] };
    expect(select(rows, changed)).toEqual(groupSessions(rows, changed));
  });
});
