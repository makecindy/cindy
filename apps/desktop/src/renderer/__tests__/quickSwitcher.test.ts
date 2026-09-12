import { describe, expect, it } from 'vitest';
import {
  catalogSessionForGrouping,
  projectSwitchTarget,
  quickSwitcherProjects,
  searchQuickSwitcher,
} from '../features/cc-agent/lib/quickSwitcher';
import { readQuickSwitcherCatalog } from '../lib/quickSwitcherService';
import type { QuickSwitcherSession } from '../../shared/quickSwitcher';

function row(id: string, patch: Partial<QuickSwitcherSession> = {}): QuickSwitcherSession {
  return {
    id,
    title: `Task ${id}`,
    workingDir: '/repo',
    workspaceKind: 'project',
    remoteHostId: null,
    agentKind: 'cc',
    status: 'active',
    pinnedAt: null,
    userSendAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    _count: { messages: 1 },
    ...patch,
  };
}

function search(
  rows: QuickSwitcherSession[],
  query: string,
  hidden = new Set<string>(),
  aliases = new Map<string, string>(),
) {
  const sessions = rows.map(catalogSessionForGrouping);
  return searchQuickSwitcher({
    query,
    sessions,
    projects: quickSwitcherProjects(sessions, aliases, [], 'win32'),
    hiddenProjectKeys: hidden,
    platform: 'win32',
    unnamedLabel: 'Untitled Task',
  });
}

describe('quick switch matching and project identity', () => {
  it('excludes unavailable recent empty projects without hiding real local, SSH or device tasks', () => {
    // These are logical project paths, independent of the host filesystem.
    const sessions = [
      row('local'),
      row('ssh', { remoteHostId: 'ssh-box' }),
      row('device', { deviceLinkDeviceId: 'device' }),
    ].map(catalogSessionForGrouping);
    const projects = quickSwitcherProjects(
      sessions,
      new Map(),
      [
        { path: '/missing', exists: false, lastUsedAt: '2026-01-01T00:00:00Z' },
        { path: '/empty', exists: true, lastUsedAt: '2026-01-01T00:00:00Z' },
        { path: '/repo', exists: false, lastUsedAt: '2026-01-01T00:00:00Z' },
      ],
      'win32',
    );
    expect(
      projects.filter((project) => project.sessions.length === 0).map((p) => p.workingDir),
    ).toEqual(['/empty']);
    expect(
      projects.flatMap((project) => project.sessions.map((session) => session.id)).sort(),
    ).toEqual(['device', 'local', 'ssh']);
    expect(
      searchQuickSwitcher({
        query: 'missing',
        sessions,
        projects,
        hiddenProjectKeys: new Set(),
        platform: 'win32',
        unnamedLabel: 'Untitled Task',
      }).results,
    ).toEqual([]);
  });

  it('searches the entire history before limiting, including archived tasks', () => {
    const rows = Array.from({ length: 300 }, (_, i) =>
      row(String(i), { title: `long needle ${i}` }),
    );
    rows.push(
      row('old', { title: 'needle', status: 'archived', updatedAt: '2000-01-01T00:00:00Z' }),
    );
    const result = search(rows, 'needle');
    expect(result.total).toBe(301);
    expect(result.results).toHaveLength(24);
    expect(result.results[0].key).toBe('session:local:old');
  });
  it('matches subsequences in names and aliases without matching paths or machines', () => {
    const rows = [
      row('a', {
        title: 'Alpha Beta',
        workingDir: '/secret/RepoName',
        remoteHostId: 'secret-host',
      }),
    ];
    expect(search(rows, 'AB').results[0].kind).toBe('session');
    expect(search(rows, 'rpn').results.some((r) => r.kind === 'project')).toBe(true);
    expect(search(rows, 'secret').results).toEqual([]);
    const aliases = new Map([['remote:secret-host:/secret/RepoName', 'Alias']]);
    expect(search(rows, 'alias', new Set(), aliases).results.map((r) => r.title)).toEqual([
      'Alias',
    ]);
    expect(search(rows, 'rpn', new Set(), aliases).results.map((r) => r.title)).toEqual(['Alias']);
  });
  it('keeps same-named local, SSH and device projects separate and hides only the requested identity', () => {
    const rows = [
      row('a'),
      row('b', { remoteHostId: 'ssh-box' }),
      row('a', { deviceLinkDeviceId: 'device' }),
    ];
    const projects = quickSwitcherProjects(
      rows.map(catalogSessionForGrouping),
      new Map(),
      [],
      'win32',
    );
    expect(new Set(projects.map((p) => p.projectKey)).size).toBe(3);
    const localKey = projects.find((p) => p.scope === 'local')!.projectKey;
    expect(
      search(rows, 'repo', new Set([localKey])).results.filter((r) => r.kind === 'project'),
    ).toHaveLength(2);
    expect(search(rows, 'Task').results.map((r) => r.key)).toContain('session:device:a');
    expect(search(rows, 'Task', new Set([localKey])).results).toHaveLength(3);
  });
  it('filters deleted/worker tasks and projects, and leaves an empty query empty', () => {
    expect(
      search([row('deleted', { status: 'deleted' }), row('worker', { orcaRole: 'worker' })], 'Task')
        .results,
    ).toEqual([]);
    expect(
      search([row('deleted', { status: 'deleted' }), row('worker', { orcaRole: 'worker' })], 'repo')
        .results,
    ).toEqual([]);
    expect(search([row('a')], ' ')).toEqual({ results: [], total: 0 });
  });
  it('uses the localized visible title and ignores message preview text', () => {
    const session = {
      ...catalogSessionForGrouping(row('draft', { title: 'New Maker' })),
      preview: 'body-only-token',
    };
    const args = {
      sessions: [session],
      projects: [],
      hiddenProjectKeys: new Set<string>(),
      platform: 'win32',
      unnamedLabel: 'Untitled Task',
    };
    expect(searchQuickSwitcher({ ...args, query: 'body-only-token' }).results).toEqual([]);
    expect(searchQuickSwitcher({ ...args, query: 'Untitled Task' }).results).toHaveLength(1);
  });
  it('keeps the current task, otherwise prefers latest active over archived, and does not invent an empty task', () => {
    const sessions = [
      row('archived', { status: 'archived', updatedAt: '2026-08-01T00:00:00Z' }),
      row('active'),
    ].map(catalogSessionForGrouping);
    const project = quickSwitcherProjects(sessions, new Map(), [], 'win32')[0];
    expect(projectSwitchTarget(project, 'local:archived')?.id).toBe('archived');
    expect(projectSwitchTarget(project, null)?.id).toBe('active');
    expect(projectSwitchTarget({ ...project, sessions: [sessions[0]] }, null)?.id).toBe('archived');
    expect(projectSwitchTarget({ ...project, sessions: [] }, null)).toBeNull();
  });
});

describe('complete directory pagination', () => {
  it('reads beyond the first page and preserves stable ids', async () => {
    const calls: Array<string | null> = [];
    const rows = await readQuickSwitcherCatalog(
      async (cursor) => {
        calls.push(cursor);
        return cursor === null
          ? { version: 1, sessions: [row('a')], nextCursor: 'a' }
          : { version: 1, sessions: [row('b')], nextCursor: null };
      },
      () => true,
    );
    expect(calls).toEqual([null, 'a']);
    expect(rows?.map((s) => s.id)).toEqual(['a', 'b']);
  });
  it('rejects repeated cursors instead of hanging or claiming a complete directory', async () => {
    await expect(
      readQuickSwitcherCatalog(
        async () => ({ version: 1, sessions: [], nextCursor: 'a' }),
        () => true,
      ),
    ).rejects.toThrow('incomplete');
  });
  it('discards an in-flight page when closed or invalidated', async () => {
    let current = true;
    expect(
      await readQuickSwitcherCatalog(
        async () => {
          current = false;
          return { version: 1, sessions: [row('old')], nextCursor: null };
        },
        () => current,
      ),
    ).toBeNull();
  });
});
