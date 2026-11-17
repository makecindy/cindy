// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
import { useProjectsForPicker } from '../hooks/useProjectsForPicker';

beforeEach(() => {
  mocks.mode = 'local';
  mocks.loading = true;
  mocks.sessions = [];
  mocks.syncProjects.mockClear();
  mocks.state = { skills: [], syncResults: new Map(), bootstrapped: false };
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { platform: 'linux' } });
});

afterEach(cleanup);

// Unit regression: the production store-sync hook must scan Windows casing aliases
// once. Prior coverage had only distinct POSIX roots and worktree directories.
// Minimal failure: two sessions for one drive/UNC root with different casing.
it.each([
  { platform: 'win32', roots: ['D:/Projects/hf-parent', 'd:/projects/HF-PARENT/'], count: 1 },
  { platform: 'win32', roots: ['//Server/Share/hf-parent', '//server/share/HF-PARENT'], count: 1 },
  { platform: 'linux', roots: ['/repo/Project', '/repo/project'], count: 2 },
])('scans $count project roots on $platform for $roots', ({ platform, roots, count }) => {
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { platform } });
  mocks.loading = false;
  mocks.sessions = roots.map((workingDir, index) => ({
    id: `case-${index}`, workingDir, workspaceKind: 'project', status: 'active',
    createdAt: '2026-09-08T00:00:00Z', updatedAt: '2026-09-08T00:00:00Z',
    userSendAt: '2026-09-08T00:00:00Z', pinnedAt: null,
  } as Session));
  renderHook(useSkillhubStoreSync);
  const projects = mocks.syncProjects.mock.lastCall![0];
  expect(projects).toHaveLength(count);
  expect(projects[0]).toMatchObject({
    projectRoot: roots[0], hash: projectHash(roots[0]), displayName: roots[0].split('/').at(-1),
  });
  const picker = renderHook(useProjectsForPicker);
  expect(picker.result.current.projects).toHaveLength(count);
  expect(picker.result.current.projects[0].projectRoot).toBe(roots[0]);
});

// Unit regression (Reviewer F1): store-sync project roots/hashes identify detail
// URLs. The alias-count coverage above never changes session activity/order.
// Two aliases exchanging updatedAt priority must keep their catalogue identity,
// including both the base and the independently scanned worktree directory.
it.each([
  ['D:/Projects/hf-parent', 'd:/projects/hf-parent'],
  ['//Server/Share/hf-parent', '//server/share/hf-parent'],
  ['D:/Projects/hf-parent/.cindy-worktrees/task', 'd:/projects/hf-parent/.cindy-worktrees/task'],
])('keeps project roots and detail hashes stable when alias activity changes: %s', (firstRoot, secondRoot) => {
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { platform: 'win32' } });
  mocks.loading = false;
  mocks.sessions = [secondRoot, firstRoot].map((workingDir, index) => ({
    id: `activity-${index}`, workingDir, workspaceKind: 'project', status: 'active',
    createdAt: '2026-09-08T00:00:00Z',
    updatedAt: index === 0 ? '2026-09-09T00:00:00Z' : '2026-09-08T00:00:00Z',
    userSendAt: null, pinnedAt: null, _count: { messages: 1 },
  } as Session));
  const storeSync = renderHook(useSkillhubStoreSync);
  const picker = renderHook(useProjectsForPicker);
  const originalProjects = mocks.syncProjects.mock.lastCall![0];
  const originalTargets = picker.result.current.projects;
  expect(originalProjects).toEqual(expect.arrayContaining([
    expect.objectContaining({ projectRoot: firstRoot, hash: projectHash(firstRoot) }),
  ]));
  const latestSession = { ...mocks.sessions[1], updatedAt: '2026-09-10T00:00:00Z' };
  mocks.sessions = [latestSession, mocks.sessions[0]];
  storeSync.rerender();
  picker.rerender();
  expect(mocks.syncProjects.mock.lastCall![0]).toEqual(originalProjects);
  expect(picker.result.current.projects).toEqual(originalTargets);
});

// Unit regression (PR #8019 review r4439529931): groupSessions identifies a project
// by sessionProjectDirectory (explicit projectDir wins over cwd), so the stable
// representative spelling must be chosen from that same field, not from workingDir.
// Minimal failure: two sessions share one cwd; their projectDir casing aliases swap
// updatedAt priority. The catalogue keeps the cwd as its own independent scan root.
it.each([
  ['D:/Projects/hf-parent', 'd:/projects/hf-parent'],
  ['//Server/Share/hf-parent', '//server/share/hf-parent'],
])('keeps explicit projectDir root and hash stable when alias activity changes: %s', (firstProject, secondProject) => {
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { platform: 'win32' } });
  mocks.loading = false;
  const cwd = 'D:/Shared/.cindy-worktrees/task';
  mocks.sessions = [firstProject, secondProject].map((projectDir, index) => ({
    id: `explicit-${index}`, workingDir: cwd, projectDir, workspaceKind: 'project', status: 'active',
    createdAt: '2026-09-08T00:00:00Z',
    updatedAt: index === 0 ? '2026-09-09T00:00:00Z' : '2026-09-08T00:00:00Z',
    userSendAt: null, pinnedAt: null, _count: { messages: 1 },
  } as Session));
  const storeSync = renderHook(useSkillhubStoreSync);
  const picker = renderHook(useProjectsForPicker);
  const originalProjects = mocks.syncProjects.mock.lastCall![0];
  const originalTargets = picker.result.current.projects;
  expect(originalProjects).toHaveLength(2);
  expect(originalProjects).toEqual(expect.arrayContaining([
    expect.objectContaining({ projectRoot: firstProject, hash: projectHash(firstProject) }),
    expect.objectContaining({ projectRoot: cwd, hash: projectHash(cwd) }),
  ]));
  expect(originalTargets).toHaveLength(1);
  expect(originalTargets[0].projectRoot).toBe(firstProject);
  const latestSession = { ...mocks.sessions[1], updatedAt: '2026-09-10T00:00:00Z' };
  mocks.sessions = [latestSession, mocks.sessions[0]];
  storeSync.rerender();
  picker.rerender();
  expect(mocks.syncProjects.mock.lastCall![0]).toEqual(originalProjects);
  expect(picker.result.current.projects).toEqual(originalTargets);
});

function crossGroupSession(
  id: string,
  projectDir: string,
  workingDir: string,
  updatedAt: string,
): Session {
  return {
    id, projectDir, workingDir, workspaceKind: 'project', status: 'active',
    createdAt: '2026-09-08T00:00:00Z', updatedAt,
    userSendAt: null, pinnedAt: null, _count: { messages: 1 },
  } as Session;
}

function scanCatalogue(): Array<{ projectRoot: string; hash: string; displayName: string }> {
  return mocks.syncProjects.mock.lastCall![0];
}

// Unit regression (PR #8019 cross-group half): within-group alias stability does
// not decide a scan root claimed by two distinct project groups. The production
// hook must keep the root, hash, label, and Windows comparison-key order when
// activity reverses. These are separate groups, not one projectDir.
it.each([
  {
    name: 'different shared cwd spellings',
    newerFirst: [
      crossGroupSession('b', 'E:/Work/b', 'd:/shared/task', '2026-09-09T00:00:00Z'),
      crossGroupSession('a', 'D:/Work/a', 'D:/Shared/task', '2026-09-08T00:00:00Z'),
    ],
    expected: [
      { projectRoot: 'D:/Shared/task', displayName: 'a · task' },
      { projectRoot: 'D:/Work/a', displayName: 'a' },
      { projectRoot: 'E:/Work/b', displayName: 'b' },
    ],
  },
  {
    name: 'one shared cwd spelling',
    newerFirst: [
      crossGroupSession('b', 'E:/Work/b', 'D:/Shared/task', '2026-09-09T00:00:00Z'),
      crossGroupSession('a', 'D:/Work/a', 'D:/Shared/task', '2026-09-08T00:00:00Z'),
    ],
    expected: [
      { projectRoot: 'D:/Shared/task', displayName: 'a · task' },
      { projectRoot: 'D:/Work/a', displayName: 'a' },
      { projectRoot: 'E:/Work/b', displayName: 'b' },
    ],
  },
  {
    name: 'parent cwd and child project root',
    newerFirst: [
      crossGroupSession('parent', 'D:/Repo', 'D:/Repo/sub', '2026-09-09T00:00:00Z'),
      crossGroupSession('child', 'd:/repo/sub', 'D:/Other', '2026-09-08T00:00:00Z'),
    ],
    expected: [
      { projectRoot: 'D:/Other', displayName: 'sub · Other' },
      { projectRoot: 'D:/Repo', displayName: 'Repo' },
      { projectRoot: 'd:/repo/sub', displayName: 'sub' },
    ],
  },
])('keeps cross-group scan roots when activity changes: $name', ({ newerFirst, expected }) => {
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { platform: 'win32' } });
  mocks.loading = false;
  const expectedCatalogue = expected.map((entry) => ({
    ...entry, hash: projectHash(entry.projectRoot),
  }));
  mocks.sessions = newerFirst;
  const storeSync = renderHook(useSkillhubStoreSync);
  expect(scanCatalogue()).toEqual(expectedCatalogue);
  expect(scanCatalogue().some((entry) => entry.projectRoot === 'D:/Repo/sub')).toBe(false);
  mocks.sessions = [...newerFirst].reverse().map((session, index) => ({
    ...session,
    updatedAt: index === 0 ? '2026-09-10T00:00:00Z' : '2026-09-08T00:00:00Z',
  }));
  storeSync.rerender();
  expect(scanCatalogue()).toEqual(expectedCatalogue);
});

function taskDirectorySession(
  id: string,
  taskDirectory: string,
  executionDirectory: string,
  updatedAt: string,
  lane: 'task' | 'companion',
): Session {
  const base = crossGroupSession(id, executionDirectory, executionDirectory, updatedAt);
  if (lane === 'companion') {
    return {
      ...base,
      workspaceKind: 'dialogue',
      userSendAt: null,
      companion: { id: `buddy-${id}`, role: 'group', taskProjectDir: taskDirectory },
    };
  }
  const taskSession: Session & { taskProjectDir: string } = {
    ...base,
    userSendAt: '2026-09-08T00:00:00Z',
    taskProjectDir: taskDirectory,
  };
  return taskSession;
}

// Unit regression: groupSessions now identifies a project by sessionTaskProjectDirectory
// (taskProjectDir, then companion.taskProjectDir, then projectDir/cwd). Two sessions can
// share one execution directory while those authoritative spellings differ only by case.
// The larger spelling is newer and first, then activity and array order swap. The scan
// root, hash, label, order, and picker target must stay on the smaller spelling.
it.each([
  {
    lane: 'task' as const,
    smaller: 'D:/Buddy/hf-parent',
    larger: 'd:/buddy/hf-parent',
    execution: 'D:/SharedGroup/repo',
    cwdLabel: 'hf-parent · repo',
  },
  {
    lane: 'task' as const,
    smaller: '//Server/Share/hf-parent',
    larger: '//server/share/HF-PARENT',
    execution: '//Server/Share/shared-repo',
    cwdLabel: 'hf-parent · shared-repo',
  },
  {
    lane: 'companion' as const,
    smaller: 'D:/Buddy/hf-parent',
    larger: 'd:/buddy/hf-parent',
    execution: 'D:/SharedGroup/repo',
    cwdLabel: 'hf-parent · repo',
  },
  {
    lane: 'companion' as const,
    smaller: '//Server/Share/hf-parent',
    larger: '//server/share/HF-PARENT',
    execution: '//Server/Share/shared-repo',
    cwdLabel: 'hf-parent · shared-repo',
  },
])('keeps the $lane task-directory root stable for $smaller', ({ lane, smaller, larger, execution, cwdLabel }) => {
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { platform: 'win32' } });
  mocks.loading = false;
  const expectedCatalogue = [
    { projectRoot: smaller, hash: projectHash(smaller), displayName: 'hf-parent' },
    { projectRoot: execution, hash: projectHash(execution), displayName: cwdLabel },
  ];
  const expectedTargets = [{ projectRoot: smaller, displayName: 'hf-parent' }];
  mocks.sessions = [
    taskDirectorySession('larger', larger, execution, '2026-09-09T00:00:00Z', lane),
    taskDirectorySession('smaller', smaller, execution, '2026-09-08T00:00:00Z', lane),
  ];
  const storeSync = renderHook(useSkillhubStoreSync);
  const picker = renderHook(useProjectsForPicker);
  expect(scanCatalogue()).toEqual(expectedCatalogue);
  expect(scanCatalogue().some((entry) => entry.projectRoot === larger)).toBe(false);
  expect(picker.result.current.projects).toEqual(expectedTargets);
  mocks.sessions = [
    taskDirectorySession('smaller', smaller, execution, '2026-09-10T00:00:00Z', lane),
    taskDirectorySession('larger', larger, execution, '2026-09-08T00:00:00Z', lane),
  ];
  storeSync.rerender();
  picker.rerender();
  expect(scanCatalogue()).toEqual(expectedCatalogue);
  expect(picker.result.current.projects).toEqual(expectedTargets);
});

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
