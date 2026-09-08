import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { gitExec } from '../gitExec';
import { resolveCindySafeDirectoryConfigPath } from '../safeDirectory';

function invokeGit(
  args: readonly string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      { cwd, encoding: 'utf8', env: process.env },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

describe('safe.directory Cindy config with real Git', () => {
  const environmentKeys = [
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_NOSYSTEM',
    'GIT_TEST_ASSUME_DIFFERENT_OWNER',
    'LC_ALL',
  ] as const;
  let previousEnvironment: Partial<Record<(typeof environmentKeys)[number], string>>;
  let tmpRoot: string;
  let appDataPath: string;
  let globalConfigPath: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-safe-directory-git-'));
    appDataPath = path.join(tmpRoot, 'app data');
    globalConfigPath = path.join(tmpRoot, 'global.gitconfig');
    fs.mkdirSync(appDataPath, { recursive: true });

    previousEnvironment = {};
    for (const key of environmentKeys) {
      if (process.env[key] !== undefined) previousEnvironment[key] = process.env[key];
    }
    process.env.GIT_CONFIG_GLOBAL = globalConfigPath;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.LC_ALL = 'C';
    delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;

    vi.spyOn(app, 'getPath').mockImplementation((name: string) => {
      if (name === 'appData') return appDataPath;
      return path.join(tmpRoot, name);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of environmentKeys) {
      const previous = previousEnvironment[key];
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function createRepository(name: string): Promise<string> {
    const repositoryPath = path.join(tmpRoot, name);
    fs.mkdirSync(repositoryPath, { recursive: true });
    await invokeGit(['init', '--initial-branch=main'], repositoryPath);
    fs.writeFileSync(path.join(repositoryPath, 'README.md'), 'test\n');
    await invokeGit(['add', 'README.md'], repositoryPath);
    await invokeGit(
      [
        '-c',
        'user.name=Cindy Test',
        '-c',
        'user.email=cindy@example.invalid',
        'commit',
        '--no-gpg-sign',
        '-m',
        'initial',
      ],
      repositoryPath,
    );
    return fs.realpathSync(repositoryPath);
  }

  it('shares persistent trust with independent Git processes without rewriting the global include', async () => {
    const firstRepository = await createRepository('first repo');
    const secondRepository = await createRepository('second repo');
    const cindyConfigPath = resolveCindySafeDirectoryConfigPath(appDataPath);
    process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';

    await expect(invokeGit(['status', '--short'], firstRepository)).rejects.toMatchObject({
      stderr: expect.stringContaining('dubious ownership'),
    });
    await expect(gitExec(['status', '--short'], firstRepository)).resolves.toMatchObject({
      stdout: '',
    });
    await expect(invokeGit(['status', '--short'], firstRepository)).resolves.toMatchObject({
      stdout: '',
    });

    const globalConfigAfterFirstGrant = fs.readFileSync(globalConfigPath, 'utf8');
    expect(globalConfigAfterFirstGrant).not.toContain('safe.directory');
    await gitExec(['status', '--short'], secondRepository);

    expect(fs.readFileSync(globalConfigPath, 'utf8')).toBe(globalConfigAfterFirstGrant);
    await expect(
      invokeGit(['config', '--global', '--get-all', 'include.path']),
    ).resolves.toMatchObject({ stdout: `${cindyConfigPath}\n` });
    await expect(
      invokeGit(['config', '--file', cindyConfigPath, '--get-all', 'safe.directory']),
    ).resolves.toMatchObject({ stdout: `${firstRepository}\n${secondRepository}\n` });

    fs.rmSync(firstRepository, { recursive: true, force: true });
    await expect(
      invokeGit(['config', '--file', cindyConfigPath, '--get-all', 'safe.directory']),
    ).resolves.toMatchObject({ stdout: `${firstRepository}\n${secondRepository}\n` });
  });
});
