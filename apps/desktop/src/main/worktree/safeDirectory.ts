/**
 * Persists Cindy-approved Git safe.directory entries in one Cindy-owned
 * config file. The user's global config only carries the stable include;
 * Git itself owns locking and atomic replacement for both files.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const CINDY_SHARED_DATA_DIRECTORY = 'CindyShared';
const SAFE_DIRECTORY_CONFIG_FILE = 'git-safe-directory.config';

export type GitConfigExecutor = (
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

interface GitConfigFailure {
  exitCode?: unknown;
}

export function resolveCindySafeDirectoryConfigPath(appDataPath: string): string {
  if (!path.isAbsolute(appDataPath) || appDataPath.includes('\0')) {
    throw new Error('safe.directory appData path must be absolute');
  }
  // This file deliberately lives above profile-specific userData. CN, Global,
  // and isolated dev profiles must share one include target; otherwise each
  // profile would add another permanent entry to the user's global Git config.
  return path.join(appDataPath, CINDY_SHARED_DATA_DIRECTORY, SAFE_DIRECTORY_CONFIG_FILE);
}

function isMissingConfigValue(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as GitConfigFailure).exitCode === 1;
}

async function hasGlobalInclude(
  configPath: string,
  executeGitConfig: GitConfigExecutor,
): Promise<boolean> {
  try {
    await executeGitConfig([
      'config',
      '--global',
      '--fixed-value',
      '--get-all',
      'include.path',
      configPath,
    ]);
    return true;
  } catch (error) {
    if (isMissingConfigValue(error)) return false;
    throw error;
  }
}

export async function ensureCindySafeDirectory(input: {
  appDataPath: string;
  directory: string;
  executeGitConfig: GitConfigExecutor;
}): Promise<void> {
  if (!path.isAbsolute(input.directory) || input.directory.includes('\0')) {
    throw new Error('safe.directory value must be an absolute path');
  }

  const configPath = resolveCindySafeDirectoryConfigPath(input.appDataPath);
  const includeExists = await hasGlobalInclude(configPath, input.executeGitConfig);

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await input.executeGitConfig([
    'config',
    '--file',
    configPath,
    '--fixed-value',
    '--replace-all',
    'safe.directory',
    input.directory,
    input.directory,
  ]);

  if (includeExists) return;

  await input.executeGitConfig([
    'config',
    '--global',
    '--fixed-value',
    '--replace-all',
    'include.path',
    configPath,
    configPath,
  ]);
}
