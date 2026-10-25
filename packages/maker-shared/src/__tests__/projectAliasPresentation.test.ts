import { describe, expect, it } from 'vitest';
// Regression: mobile home/detail built directory titles even when the host had a project alias.
// Production entries: buildMobileHomePresentation/buildRemoteSessionSections. Existing list tests
// cover grouping but not alias updates. Minimal failure: rename one /repo/Slack对话 snapshot;
// both titles must change while task titles, source paths and group keys stay unchanged (unit).
import { buildMobileHomePresentation, type MobileHomeSessionLike } from '../mobileHome.js';
import { buildRemoteSessionSections } from '../sessionList.js';
import { createProjectAliasMirror, type HostProjectAliasesSnapshot } from '../projectAliasSync.js';

function session(id: string, patch: Partial<MobileHomeSessionLike> = {}): MobileHomeSessionLike {
  return {
    id,
    title: `Task ${id}`,
    workingDir: '/repo/Slack对话',
    workspaceKind: 'project',
    deviceLinkDeviceId: 'computer-a',
    model: 'model',
    agentKind: 'cc',
    status: 'active',
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
    ...patch,
  };
}

function snapshot(alias: string | null, projectKey = 'local:/repo/Slack对话'): HostProjectAliasesSnapshot {
  return { platform: 'darwin', aliases: alias === null ? [] : [{ projectKey, alias }] };
}

describe('project aliases in controller presentations', () => {
  it('renames and clears project titles on home and detail without changing task titles, paths, or group keys', async () => {
    const mirror = createProjectAliasMirror();
    const sessions = [session('one'), session('two')];
    let host = snapshot(null);
    const read = async () => host;
    await mirror.refresh('computer-a', read);
    const home = () => buildMobileHomePresentation({ sessions, projectAliases: mirror.getSnapshot() });
    const detail = () => buildRemoteSessionSections(sessions, 0, { projectAliases: mirror.getSnapshot() });
    const originalKey = home().projects[0].key;
    expect(home().projects[0].title).toBe('Slack对话');
    expect(detail()[0].title).toBe('Slack对话');

    host = snapshot('Slack同步测试');
    await mirror.invalidate('computer-a', read);
    expect(home().projects[0]).toMatchObject({ key: originalKey, title: 'Slack同步测试', workingDir: '/repo/Slack对话' });
    expect(detail()[0].title).toBe('Slack同步测试');
    expect(sessions.map((row) => row.title)).toEqual(['Task one', 'Task two']);

    host = snapshot(null);
    await mirror.invalidate('computer-a', read);
    expect(home().projects[0]).toMatchObject({ key: originalKey, title: 'Slack对话' });
    expect(detail()[0].title).toBe('Slack对话');
  });

  it('keeps different computers with the same path independent', () => {
    const projectAliases = new Map([
      ['computer-a', snapshot('First')],
      ['computer-b', snapshot('Second')],
    ]);
    const home = buildMobileHomePresentation({
      sessions: [session('one'), session('two', { deviceLinkDeviceId: 'computer-b' })],
      projectAliases,
    });
    expect(new Map(home.projects.map((group) => [group.deviceId, group.title])))
      .toEqual(new Map([['computer-a', 'First'], ['computer-b', 'Second']]));
  });

  it('applies a host base-project alias to its worktree and supports detail rows without source metadata', () => {
    const projectAliases = new Map([['computer-a', snapshot('Project')]]);
    const row = session('worktree', { workingDir: '/repo/Slack对话/.cindy-worktrees/example' });
    expect(buildMobileHomePresentation({ sessions: [row], projectAliases }).projects[0].title).toBe('Project');
    expect(buildRemoteSessionSections([{ ...row, deviceLinkDeviceId: undefined }], 0, {
      projectAliases, projectAliasDeviceId: 'computer-a',
    })[0].title).toBe('Project');
  });

  it('accepts the existing local-name projection without borrowing it for SSH members', () => {
    const projectAliases = new Map([['device:computer-a:/repo/Slack对话', 'Local']]);
    const local = session('one');
    const ssh = session('two', { remoteHostId: 'ssh-a' });
    expect(buildMobileHomePresentation({ sessions: [local], projectAliases }).projects[0].title).toBe('Local');
    expect(buildRemoteSessionSections([local], 0, { projectAliases })[0].title).toBe('Local');
    for (const sessions of [[local, ssh], [ssh, local]]) {
      expect(buildMobileHomePresentation({ sessions, projectAliases, searchQuery: 'Task one' }).projects[0].title)
        .toBe('Slack对话');
      expect(buildRemoteSessionSections(sessions, 0, { projectAliases })[0].title).toBe('Slack对话');
    }
    expect(buildMobileHomePresentation({ sessions: [ssh], projectAliases }).projects[0].title).toBe('Slack对话');
  });

  it('keeps a single-identity alias when a deleted foreign member remains in the source', () => {
    const projectAliases = new Map([['computer-a', snapshot('Local')]]);
    const sessions = [session('one'), session('gone', { remoteHostId: 'ssh-a', status: 'deleted' })];
    expect(buildMobileHomePresentation({ sessions, projectAliases, searchQuery: 'Task one' }).projects[0].title)
      .toBe('Local');
    expect(buildRemoteSessionSections(sessions, 0, { projectAliases, searchQuery: 'Task one' })[0].title)
      .toBe('Local');
  });

  // A project's identity comes from every member, before search/status/pinning hide rows.
  it.each(['search', 'status', 'pinned', 'worktree'] as const)(
    'keeps a mixed local/SSH project title stable when %s hides its other member',
    (filter) => {
      const projectAliases = new Map([['computer-a', {
        platform: 'darwin', aliases: [
          { projectKey: 'local:/repo/Slack对话', alias: 'Local' },
          { projectKey: 'remote:ssh-a:/repo/Slack对话', alias: 'Remote' },
        ],
      }]]);
      const sessions = [session('one'), session('two', {
        remoteHostId: 'ssh-a',
        ...(filter === 'status' ? { status: 'archived' } : {}),
        ...(filter === 'pinned' ? { pinnedAt: '2026-10-23T00:00:00.000Z' } : {}),
        ...(filter === 'worktree' ? { workingDir: '/repo/Slack对话/.cindy-worktrees/example' } : {}),
      })];
      const options = filter === 'status' ? { statusFilter: 'active' as const }
        : filter === 'pinned' ? {} : { searchQuery: 'Task one' };
      const home = buildMobileHomePresentation({ sessions, projectAliases, ...options });
      const detail = buildRemoteSessionSections(sessions, 0, { projectAliases, ...options })
        .find(section => section.key.startsWith('project:'))!;
      expect(home.projects[0].title).toBe('Slack对话');
      expect(detail.title).toBe('Slack对话');
      expect(home.projects[0].sessions.map(item => item.session.id)).toEqual(['one']);
      expect(detail.data.map(item => item.session.id)).toEqual(['one']);
    },
  );

  it.each([false, true])('never assigns a local name to an existing mixed local/SSH group (reversed=%s)', (reverse) => {
    const projectAliases = new Map([['computer-a', {
      platform: 'darwin', aliases: [
        { projectKey: 'local:/repo/Slack对话', alias: 'Local' },
        { projectKey: 'remote:ssh-a:/repo/Slack对话', alias: 'Remote' },
      ],
    }]]);
    const sessions = [session('one'), session('two', { remoteHostId: 'ssh-a' })];
    if (reverse) sessions.reverse();
    expect(buildMobileHomePresentation({ sessions, projectAliases }).projects[0].title).toBe('Slack对话');
    expect(buildRemoteSessionSections(sessions, 0, { projectAliases })[0].title).toBe('Slack对话');
    expect(buildMobileHomePresentation({ sessions: [session('ssh', { remoteHostId: 'ssh-a' })], projectAliases }).projects[0].title)
      .toBe('Remote');
  });
});
