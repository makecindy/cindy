import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { Session } from '@/lib/ccAgent.types';
import { moveLocalTaskProject } from '../sessionProjectMove';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  get: vi.fn(),
  find: vi.fn(),
  patch: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('@/lib/sessionService', () => ({ get: mocks.get }));
vi.mock('@/lib/sessionsStore', () => ({
  sessionsStore: { findById: mocks.find, patchLocal: mocks.patch },
}));
vi.mock('@/lib/recentWorkdirsStore', () => ({
  recentWorkdirsStore: { forceRefresh: mocks.refresh },
}));
const row = { id: 'task', workingDir: '/source', workspaceKind: 'project' } as Session;

beforeEach(() => {
  vi.clearAllMocks();
  setDataOwnerGeneration('owner');
  vi.stubGlobal('window', { electronAPI: { deviceLink: { taskMigration: mocks.request } } });
  mocks.request.mockResolvedValue({ projectMove: { sessionId: 'task' } });
  mocks.find.mockReturnValue(row);
  mocks.refresh.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

it('requests a host move and preserves the source cwd while the host has queued the target', async () => {
  mocks.get.mockResolvedValue({ ...row, projectMoveTarget: { workingDir: '/target' } });
  await moveLocalTaskProject('task', '/target');
  expect(mocks.request).toHaveBeenCalledWith(null, {
    action: 'move-project',
    sessionId: 'task',
    workingDir: '/target',
  });
  expect(mocks.get).toHaveBeenCalledWith('task', { fresh: true });
  expect(mocks.patch).toHaveBeenCalledWith('task', {
    workingDir: '/source',
    workspaceKind: 'project',
    projectMoveTarget: { workingDir: '/target' },
  });
});

it('does not overwrite a newer target push while refreshing after acceptance', async () => {
  mocks.get.mockImplementation(async () => {
    mocks.find.mockReturnValue({ ...row, projectMoveTarget: { workingDir: '/newer' } });
    return { ...row, projectMoveTarget: { workingDir: '/older' } };
  });
  await moveLocalTaskProject('task', '/older');
  expect(mocks.patch).not.toHaveBeenCalled();
});

it('does not update another account from an accepted old move', async () => {
  mocks.request.mockImplementation(async () => {
    setDataOwnerGeneration('other-owner');
    return { projectMove: { sessionId: 'task' } };
  });
  await moveLocalTaskProject('task', '/target');
  expect(mocks.get).not.toHaveBeenCalled();
  expect(mocks.patch).not.toHaveBeenCalled();
});

it('leaves host state intact when the request rejects instead of rolling back an uncertain write', async () => {
  mocks.request.mockRejectedValue(new Error('MIGRATION_PROJECT_PRECONDITION_FAILED'));
  await expect(moveLocalTaskProject('task', '/target')).rejects.toThrow(
    'MIGRATION_PROJECT_PRECONDITION_FAILED',
  );
  expect(mocks.patch).not.toHaveBeenCalled();
});
