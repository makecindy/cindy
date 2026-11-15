// Unit: project-settings v7 requires optional directories and clone failure recovery.
// Existing registration tests require an existing folder and cannot cover allocation.
// Minimum failures: two creates with the same name; rejected clone; owner switch.
// Exercises prepareNewProject on isolated temporary folders with injected Git.
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prepareNewProject } from '../projectCreation';
import {
  parseProjectRepository,
  projectCreationFolderName,
} from '@cindy/maker-shared/project-alias-sync';
vi.mock('../dialogue-workspace-settings.js', () => ({ dialogueWorkspaceRoots: () => [] }));
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'cindy-create-project-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const deps = () => ({
  root: async () => root,
  git: vi.fn<typeof import('../git-review/gitRunner').runGit>(async () => ({
    stdout: '',
    stderr: '',
    exitCode: 0,
  })),
  github: async () => '/tools/gh',
});
it.each([
  ['https://git.example.com/repo.git', 'https://git.example.com/repo.git', 'repo'],
  ['https://github.com/org/repo', 'https://github.com/org/repo.git', 'repo'],
  [
    'https://gitlab.example.com/group/sub/repo/-/tree/main',
    'https://gitlab.example.com/group/sub/repo.git',
    'repo',
  ],
  ['git@gitlab.example.com:group/repo.git', 'ssh://git@gitlab.example.com/group/repo.git', 'repo'],
  [
    'ssh://git@gitlab.example.com:2222/group/repo.git',
    'ssh://git@gitlab.example.com:2222/group/repo.git',
    'repo',
  ],
])('recognizes repository address %s', (input, url, name) => {
  expect(parseProjectRepository(input)).toEqual({ url, name });
});
it.each([
  'file:///tmp/repo',
  'ext::evil',
  '/home/user/repo',
  'https://token:password@github.com/a/b',
  'https://token@github.com/a/b',
  '-c',
  'bad address',
  'https://github.com/a/%2e%2e/b',
  'ssh://-oProxyCommand=x@gitlab.com/a/b',
])('rejects non-repository or credential-bearing input %s', (input) => {
  expect(parseProjectRepository(input)).toBeNull();
});
it('allocates non-conflicting directories atomically without replacing existing contents', async () => {
  await mkdir(path.join(root, 'Demo'));
  await writeFile(path.join(root, 'Demo', 'keep'), 'mine');
  const results = await Promise.all([
    prepareNewProject({ name: 'Demo' }, () => {}, deps()),
    prepareNewProject({ name: 'Demo' }, () => {}, deps()),
  ]);
  expect(new Set(results.map((row) => row.directory))).toEqual(
    new Set([path.join(root, 'Demo-2'), path.join(root, 'Demo-3')]),
  );
  expect(await readFile(path.join(root, 'Demo', 'keep'), 'utf8')).toBe('mine');
});
it('clones with argument boundaries and keeps SSH ports', async () => {
  const d = deps();
  const prepared = await prepareNewProject(
    { repositoryUrl: 'ssh://git@gitlab.example.com:2222/group/repo' },
    () => {},
    d,
  );
  expect(d.git.mock.calls[0]?.[0]).toEqual([
    '-c',
    'core.hooksPath=',
    'clone',
    '--',
    'ssh://git@gitlab.example.com:2222/group/repo.git',
    prepared.directory,
  ]);
});
it('removes only the allocated folder after clone failure, leaving other projects intact', async () => {
  await mkdir(path.join(root, 'keep'));
  const d = deps();
  d.git.mockRejectedValueOnce(new Error('credential detail must not escape'));
  await expect(
    prepareNewProject({ repositoryUrl: 'https://gitlab.com/g/repo' }, () => {}, d),
  ).rejects.toThrow('Could not clone');
  expect(await readdir(root)).toEqual(['keep']);
});
it('never clones over a non-empty selected directory', async () => {
  await writeFile(path.join(root, 'keep'), 'mine');
  const d = deps();
  await expect(
    prepareNewProject({ directory: root, repositoryUrl: 'https://github.com/a/b' }, () => {}, d),
  ).rejects.toThrow('empty directory');
  expect(d.git).not.toHaveBeenCalled();
  expect(await readFile(path.join(root, 'keep'), 'utf8')).toBe('mine');
});
it('cleans an allocated folder when the account changes during cloning', async () => {
  let current = true;
  const d = deps();
  d.git.mockImplementationOnce(async () => {
    current = false;
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  await expect(
    prepareNewProject(
      { repositoryUrl: 'https://gitlab.com/g/repo' },
      () => {
        if (!current) throw Error('owner changed');
      },
      d,
    ),
  ).rejects.toThrow('owner changed');
  expect(await readdir(root)).toEqual([]);
});
it('makes safe folder names across platforms', () => {
  expect(projectCreationFolderName('../CON')).toBe('..-CON');
  expect(projectCreationFolderName('CON')).toBe('Project');
  expect(projectCreationFolderName('示例 / demo')).toBe('示例 - demo');
});
