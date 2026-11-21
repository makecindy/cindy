import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createGroupAssistantTasks } from '../groupAssistantTask.js';
import type { ChatAssistantSessionRecord } from '../chatServerWorkspaces.js';
import { createGroupProjectFolders, findRepositoryFolders, folderRepositories, requestRepository } from '../groupProjectFolder.js';

const cindyRepo = { kind: 'github' as const, repo: 'makecindy/cindy' };
const room = { id: 'room', name: 'Cindy', project: cindyRepo };
const options = { botId: 'bot', isCurrent: () => true };
describe('group execution project', () => {
  // A fork's `upstream` is the repository the group shares; any git host counts, a plain path does not.
  it('names a folder\'s repositories with a fork\'s upstream first', () => {
    expect(folderRepositories([
      { name: 'origin', url: 'git@github.com:me/cindy.git' }, { name: 'mirror', url: 'https://gitlab.com/me/cindy.git' },
      { name: 'upstream', url: 'https://github.com/makecindy/cindy' }, { name: 'backup', url: 'https://github.com/MakeCindy/Cindy.git' },
    ])).toEqual([cindyRepo, { kind: 'github', repo: 'me/cindy' }, { kind: 'git', host: 'gitlab.com', path: 'me/cindy' }]);
    // A company GitLab over SSH and CNB name the same repository however their address is written.
    expect(folderRepositories([{ name: 'origin', url: 'ssh://git@gitlab.example.com:2222/Platform/tools/cindy.git' }, { name: 'cnb', url: 'git@cnb.cool:org/name.git' }]))
      .toEqual([{ kind: 'git', host: 'gitlab.example.com', path: 'Platform/tools/cindy' }, { kind: 'git', host: 'cnb.cool', path: 'org/name' }]);
    expect(folderRepositories([{ name: 'origin', url: '/srv/git/cindy.git' }])).toEqual([]);
  });

  it('returns all distinct registered checkouts, including forks', async () => {
    const read = { isMainCheckout: async () => true,
      remotes: async (dir: string) => ({ '/work/fork': ['https://github.com/me/cindy.git', 'git@github.com:makecindy/cindy.git'],
        '/work/other': ['https://github.com/someone/else.git'], '/work/older': ['https://github.com/makecindy/cindy'] } as Record<string, string[]>)[dir] ?? [] };
    expect(await findRepositoryFolders(['/work/fork', '/work/other', '/work/older'], cindyRepo, read))
      .toEqual(['/work/fork', '/work/older'].map(dir => path.resolve(dir)));
  });

  it('uses the executing buddy for missing or ambiguous repositories, and no project if it has none', async () => {
    const matches = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(['/a', '/b']).mockResolvedValueOnce([]);
    const executorProject = vi.fn().mockResolvedValueOnce('/buddy').mockResolvedValueOnce('/buddy').mockResolvedValueOnce(null);
    const folders = createGroupProjectFolders({ chosen: () => null, findRegistered: matches, executorProject });
    expect((await folders.forWork(room, options)).dir).toBe('/buddy');
    expect((await folders.forWork(room, options)).dir).toBe('/buddy');
    expect((await folders.forWork(room, options)).dir).toBeNull();
    expect(executorProject).toHaveBeenCalledWith('bot');
  });

  it('uses an explicit binding before the request, and a unique repository URL before the buddy', async () => {
    let chosen: string | null = '/bound';
    const findRegistered = vi.fn(async () => ['/dev']);
    const folders = createGroupProjectFolders({ chosen: () => chosen, findRegistered,
      validate: async dir => ({ ok: true, dir }), executorProject: async () => '/buddy' });
    const request = requestRepository('查一下 https://github.com/makecindy/cindy/pull/42');
    expect(request).toEqual(cindyRepo);
    expect((await folders.forWork({ id: 'r' }, { ...options, request })).dir).toBe('/bound');
    expect(findRegistered).not.toHaveBeenCalled();
    chosen = null;
    expect((await folders.forWork({ id: 'r' }, { ...options, request })).dir).toBe('/dev');
    expect(requestRepository('Cindy 插件断了')).toBeNull();
    expect(requestRepository('https://github.com/a/b https://github.com/c/d')).toBeNull();
  });
  it('keeps the topic’s project on follow-up and changes it for a new repository request', async () => {
    const records: Record<string, ChatAssistantSessionRecord> = {};
    const ensureSession = vi.fn(async (input: { sessionId?: string; title: string; projectDir: string | null }) =>
      ({ ok: true as const, sessionId: input.sessionId ?? input.projectDir! }));
    const folders = createGroupProjectFolders({ chosen: () => null, validate: async dir => ({ ok: true, dir }),
      executorProject: async () => '/buddy', findRegistered: async repo => repo.kind === 'github' ? ['/' + repo.repo] : [] });
    const tasks = createGroupAssistantTasks({ folders, ensureSession, current: () => true,
      store: () => ({ read: () => records, save: value => Object.assign(records, value) }) });
    const group = { id: 'g', name: 'Group' };
    const follow = (text: string) => tasks.forRequest(group, () => true, 'topic', requestRepository(text));
    expect((await follow('https://github.com/a/one/issues/1')).sessionId).toBe('/a/one');
    expect((await follow('再看一下')).sessionId).toBe('/a/one');
    expect((await follow('https://github.com/b/two')).sessionId).toBe('/b/two');
    expect((await tasks.forRequest(group, () => true, 'other-topic')).sessionId).toBe('/buddy');
  });

});
