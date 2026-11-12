import path from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { projectPluginWorkdir, resolvePluginWorkdir } from '../remotePluginProjects';

const { stat } = vi.hoisted(() => ({ stat: vi.fn() }));
vi.mock('node:fs/promises', () => ({ stat }));
vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock('../../appSessionState.js', () => ({ ownerScopedUserDataPath: () => 'unused' }));

beforeEach(() => stat.mockReset());

it('keeps the selected Host path as display metadata and issues the same identity for normalized spellings', () => {
  const workdir = path.resolve('target', 'Cindy');
  const project = projectPluginWorkdir(workdir);
  expect(project).toMatchObject({ name: 'Cindy', path: workdir, workdir });
  expect(project.id).toMatch(/^[a-f0-9]{64}$/);
  expect(projectPluginWorkdir(workdir + path.sep).id).toBe(project.id);
});

it('resolves only an existing absolute directory on the Host before issuing a project id', async () => {
  const workdir = path.resolve('target', 'Cindy');
  stat.mockResolvedValue({ isDirectory: () => true });
  expect(await resolvePluginWorkdir(workdir)).toEqual(projectPluginWorkdir(workdir));
  expect(stat).toHaveBeenCalledWith(workdir);
  stat.mockResolvedValueOnce({ isDirectory: () => false });
  await expect(resolvePluginWorkdir(workdir)).rejects.toThrow('INVALID_PROJECT_DIRECTORY');
  stat.mockRejectedValueOnce(new Error('ENOENT'));
  await expect(resolvePluginWorkdir(workdir)).rejects.toThrow('ENOENT');
  stat.mockClear();
  await expect(resolvePluginWorkdir('controller-relative')).rejects.toThrow('INVALID_PROJECT_DIRECTORY');
  await expect(resolvePluginWorkdir(workdir + '\0')).rejects.toThrow('INVALID_PROJECT_DIRECTORY');
  expect(stat).not.toHaveBeenCalled();
});
