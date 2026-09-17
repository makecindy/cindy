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
