import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkHandoverDirectory, findHandedProject, type HandoverDirectoryEnv } from '../botWorkbenchHandover.js';

let root: string;
let env: HandoverDirectoryEnv;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bot-handover-')));
  const homeDir = path.join(root, 'home');
  const userDataDir = path.join(root, 'userData');
  await mkdir(path.join(homeDir, 'code', 'repo'), { recursive: true });
  await mkdir(path.join(userDataDir, 'owners'), { recursive: true });
  env = { homeDir, userDataDir, caseInsensitive: false };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('checkHandoverDirectory', () => {
  it('accepts an existing project directory, including ~/ paths, and keeps the literal path', async () => {
    const repo = path.join(env.homeDir, 'code', 'repo');
    expect(await checkHandoverDirectory(`${repo}/`, env)).toEqual({ ok: true, path: repo });
    expect(await checkHandoverDirectory('~/code/repo', env)).toEqual({ ok: true, path: repo });
    const link = path.join(root, 'repo-link');
    await symlink(repo, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await checkHandoverDirectory(link, env)).toEqual({ ok: true, path: link });
  });

  it('rejects relative, missing and non-directory paths', async () => {
    await writeFile(path.join(root, 'file.txt'), 'x');
    expect(await checkHandoverDirectory('code/repo', env)).toMatchObject({ ok: false, errorCode: 'INVALID_PROJECT_PATH' });
    expect(await checkHandoverDirectory(path.join(root, 'missing'), env)).toMatchObject({ ok: false, errorCode: 'NOT_A_DIRECTORY' });
    expect(await checkHandoverDirectory(path.join(root, 'file.txt'), env)).toMatchObject({ ok: false, errorCode: 'NOT_A_DIRECTORY' });
  });

  it('rejects the filesystem root, the home directory and Cindy data, also through a symlink', async () => {
    await symlink(env.homeDir, path.join(root, 'home-link'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(path.join(env.userDataDir, 'owners'), path.join(root, 'data-link'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const target of [path.parse(root).root, env.homeDir, '~', path.join(root, 'home-link'),
      path.join(env.userDataDir, 'owners'), path.join(root, 'data-link')]) {
      expect(await checkHandoverDirectory(target, env)).toMatchObject({ ok: false, errorCode: 'INVALID_PROJECT_PATH' });
    }
  });
});

describe('findHandedProject', () => {
  it('finds the handed project through ~/, a trailing slash, case and symlinks, and nothing else', async () => {
    const repo = path.join(env.homeDir, 'code', 'repo');
    const link = path.join(root, 'repo-link');
    await symlink(repo, link, process.platform === 'win32' ? 'junction' : 'dir');
    const dirs = [repo];
    const opts = { homeDir: env.homeDir, caseInsensitive: true };
    expect(await findHandedProject('~/code/repo/', dirs, opts)).toBe(repo);
    expect(await findHandedProject(repo.toUpperCase(), dirs, opts)).toBe(repo);
    expect(await findHandedProject(link, dirs, opts)).toBe(repo);
    expect(await findHandedProject(path.join(env.homeDir, 'code'), dirs, opts)).toBeNull();
    expect(await findHandedProject('code/repo', dirs, opts)).toBeNull();
  });
});
