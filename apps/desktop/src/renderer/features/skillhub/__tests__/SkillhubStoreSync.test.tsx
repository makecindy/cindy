// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';
import { projectHash } from '../lib/projectHash';

const mocks = vi.hoisted(() => ({
  mode: 'local', sessions: [] as Session[], loading: true, syncProjects: vi.fn(),
  state: { skills: [] as SkillhubSkill[], syncResults: new Map<string, SkillhubSyncResult>(), bootstrapped: false },
}));
vi.mock('@/hooks/useCCSessions', () => ({ useCCSessions: () => ({ sessions: mocks.sessions, isLoading: mocks.loading }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ dataOwnerId: 'local', mode: mocks.mode }) }));
vi.mock('@/features/cc-agent/useRegisterCCAgentSidebar', () => ({ useRegisterCCAgentSidebar: vi.fn() }));
vi.mock('../hooks/useSkillSync', () => ({ useSkillSync: vi.fn() }));
vi.mock('../hooks/useSkillhub', () => ({
  useSkillhub: () => mocks.state, syncProjects: mocks.syncProjects,
  bootstrapSkillhub: vi.fn(), refresh: vi.fn(), setSkillhubDataOwner: vi.fn(),
}));
import { useSkillhubStoreSync } from '../SkillhubFeatureLayout';

afterEach(cleanup);

it('keeps pinned and newly created local project directories in the scan catalogue', () => {
  const session = (id: string, workingDir: string, extra: Partial<Session> = {}) => ({
    id, workingDir, workspaceKind: 'project', status: 'active',
    createdAt: '2026-09-08T00:00:00Z', updatedAt: '2026-09-08T00:00:00Z',
    userSendAt: '2026-09-08T00:00:00Z', pinnedAt: null, ...extra,
  } as Session);
  mocks.sessions = [
    session('pinned', '/repo/pinned', { pinnedAt: '2026-09-08T01:00:00Z' }),
    session('created', '/repo/created', { userSendAt: null }),
    session('worktree', '/repo/base/.cindy-worktrees/task'),
    session('legacy-worktree', '/repo/base/.xdt-worktrees/legacy'),
    session('user-worktree', '/repo/base/.worktrees/custom'),
    session('ssh', '/remote', { remoteHostId: 'ssh-host', pinnedAt: '2026-09-08T01:00:00Z' }),
  ];
  const { rerender } = renderHook(useSkillhubStoreSync);
  expect(mocks.syncProjects).not.toHaveBeenCalled();
  mocks.loading = false;
  rerender();
  const projects = mocks.syncProjects.mock.lastCall![0];
  expect(projects).toHaveLength(6);
  expect(projects).toEqual(expect.arrayContaining([
    expect.objectContaining({ projectRoot: '/repo/pinned', hash: projectHash('/repo/pinned') }),
    expect.objectContaining({ projectRoot: '/repo/created', hash: projectHash('/repo/created') }),
    expect.objectContaining({ projectRoot: '/repo/base', hash: projectHash('/repo/base') }),
    expect.objectContaining({ projectRoot: '/repo/base/.cindy-worktrees/task', hash: projectHash('/repo/base/.cindy-worktrees/task') }),
    expect.objectContaining({ projectRoot: '/repo/base/.xdt-worktrees/legacy', hash: projectHash('/repo/base/.xdt-worktrees/legacy') }),
    expect.objectContaining({ projectRoot: '/repo/base/.worktrees/custom', hash: projectHash('/repo/base/.worktrees/custom') }),
  ]));
  mocks.sessions = mocks.sessions.map((item) => ({ ...item, pinnedAt: null }));
  rerender();
  expect(mocks.syncProjects.mock.lastCall![0]).toEqual(projects);
});


it.each(['google-play-console-local', 'Google-Play-Console'])('reconciles the registered slug and catalog for folder %s', async (name) => {
  mocks.mode = 'cloud';
  mocks.state.bootstrapped = true;
  const slug = 'google-play-console';
  const { skillhubCatalogKey } = await import('../../../../shared/skillhubCatalog');
  const reconcileMineRegistry = vi.fn().mockResolvedValue({ success: true, added: 0, flipped: 0, failures: [] });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { skillhub: { reconcileMineRegistry } } });
  mocks.state.skills = [{ kind: 'skill', name, registrySkillName: slug, absolutePath: `/skills/${name}`,
    registryEntry: { catalogScope: 'market', version: '1.0.0' } } as SkillhubSkill];
  mocks.state.syncResults = new Map([
    [skillhubCatalogKey(slug, 'market'), { exists: true, isMine: true, authorId: 'publisher', latestVersion: '2.0.0' } as SkillhubSyncResult],
    [skillhubCatalogKey(slug, 'team'), { exists: true, isMine: true, authorId: 'other-publisher', latestVersion: '3.0.0' } as SkillhubSyncResult],
  ]);
  const hook = renderHook(useSkillhubStoreSync);
  await waitFor(() => expect(reconcileMineRegistry).toHaveBeenCalledExactlyOnceWith([
    { name: slug, absolutePath: `/skills/${name}`, authorId: 'publisher', version: '2.0.0' },
  ]));
  await act(async () => hook.rerender());
  expect(reconcileMineRegistry).toHaveBeenCalledTimes(1);
  mocks.mode = 'local';
});
