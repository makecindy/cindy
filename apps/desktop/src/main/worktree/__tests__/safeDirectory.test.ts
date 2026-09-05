import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureCindySafeDirectory,
  resolveCindySafeDirectoryConfigPath,
  type GitConfigExecutor,
} from '../safeDirectory';

describe('ensureCindySafeDirectory', () => {
  let appDataPath: string;
  let executeGitConfig: ReturnType<typeof vi.fn<GitConfigExecutor>>;

  beforeEach(() => {
    appDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-safe-directory-unit-'));
    executeGitConfig = vi.fn<GitConfigExecutor>();
  });

  afterEach(() => {
    fs.rmSync(appDataPath, { recursive: true, force: true });
  });

  it('writes the exact path to the Cindy config before installing one global include', async () => {
    const directory = path.join(appDataPath, 'repo with spaces');
    const configPath = resolveCindySafeDirectoryConfigPath(appDataPath);
    executeGitConfig.mockRejectedValueOnce({ exitCode: 1 }).mockResolvedValue({
      stdout: '',
      stderr: '',
    });

    await ensureCindySafeDirectory({ appDataPath, directory, executeGitConfig });

    expect(executeGitConfig.mock.calls).toEqual([
      [['config', '--global', '--fixed-value', '--get-all', 'include.path', configPath]],
      [
        [
          'config',
          '--file',
          configPath,
          '--fixed-value',
          '--replace-all',
          'safe.directory',
          directory,
          directory,
        ],
      ],
      [
        [
          'config',
          '--global',
          '--fixed-value',
          '--replace-all',
          'include.path',
          configPath,
          configPath,
        ],
      ],
    ]);
    expect(fs.statSync(path.dirname(configPath)).isDirectory()).toBe(true);
  });

  it('does not rewrite the global config when the Cindy include already exists', async () => {
    const directory = path.join(appDataPath, 'second-repo');
    const configPath = resolveCindySafeDirectoryConfigPath(appDataPath);
    executeGitConfig.mockResolvedValue({ stdout: `${configPath}\n`, stderr: '' });

    await ensureCindySafeDirectory({ appDataPath, directory, executeGitConfig });

    expect(executeGitConfig.mock.calls).toEqual([
      [['config', '--global', '--fixed-value', '--get-all', 'include.path', configPath]],
      [
        [
          'config',
          '--file',
          configPath,
          '--fixed-value',
          '--replace-all',
          'safe.directory',
          directory,
          directory,
        ],
      ],
    ]);
  });

  it('propagates global config read failures instead of treating them as a missing include', async () => {
    const failure = { exitCode: 128, stderr: 'malformed config' };
    executeGitConfig.mockRejectedValue(failure);

    await expect(
      ensureCindySafeDirectory({
        appDataPath,
        directory: path.join(appDataPath, 'repo'),
        executeGitConfig,
      }),
    ).rejects.toBe(failure);
    expect(executeGitConfig).toHaveBeenCalledTimes(1);
  });
});
