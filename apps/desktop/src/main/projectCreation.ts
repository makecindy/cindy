import fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import {
  parseProjectRepository,
  projectCreationFolderName,
} from '@cindy/maker-shared/project-alias-sync';
import { readProjectsRootDirectory } from './projects-root-settings.js';
import { listRegisteredProjectPaths } from './localDb/ipc/recentWorkdirsCore.js';
import { getDbClient } from './localDb/client/current.js';
import { loadSidebarSettingsSnapshot } from './sidebarSettingsStoreCore.js';
import { projectKeyComparisonKey } from '../shared/projectKeys.js';
import { runGit } from './git-review/gitRunner.js';
import { resolveGhBinary } from './git-context/ghBinary.js';
import {
  validateExistingLocalProjectDirectory,
  validateLocalProjectDirectory,
} from './projectDirectoryRoot.js';
import { throwIpcError } from './utils/ipcValidate.js';

export function inferProjectsRoot(
  directories: readonly string[],
  platform = process.platform,
): string | null {
  const counts = new Map<string, { parent: string; count: number }>();
  for (const directory of directories) {
    const parent = path.dirname(directory);
    if (parent === directory) continue;
    const key = platform === 'win32' ? parent.toLowerCase() : parent;
    const entry = counts.get(key) ?? { parent, count: 0 };
    entry.count++;
    counts.set(key, entry);
  }
  let best: { parent: string; count: number } | null = null;
  for (const entry of counts.values())
    if (entry.count >= 2 && (!best || entry.count > best.count)) best = entry;
  return best?.parent ?? null;
}

export async function projectCreationRoot(): Promise<string> {
  const configured = readProjectsRootDirectory();
  if (configured) return configured;
  const hidden = new Set(
    loadSidebarSettingsSnapshot().hiddenProjectKeys.map((key) =>
      projectKeyComparisonKey(key, process.platform),
    ),
  );
  const catalog = await listRegisteredProjectPaths(getDbClient());
  return (
    inferProjectsRoot(
      catalog.filter(
        (row) => !hidden.has(projectKeyComparisonKey(`local:${row}`, process.platform)),
      ),
    ) ?? path.join(homedir(), 'Projects')
  );
}

export interface PreparedNewProject {
  directory: string;
  cleanup(): Promise<void>;
}
/** Only folders reserved by this operation are eligible for cleanup; selected folders are never removed. */
export async function prepareNewProject(
  input: { directory?: string; name?: string; repositoryUrl?: string },
  assertCurrent: () => void,
  deps = { root: projectCreationRoot, git: runGit, github: resolveGhBinary },
): Promise<PreparedNewProject> {
  const repository = input.repositoryUrl ? parseProjectRepository(input.repositoryUrl) : null;
  if (input.repositoryUrl && !repository) throwIpcError('INVALID_PARAMS', 'Invalid repository URL');
  let directory = input.directory?.trim() ?? '';
  let owned = false;
  assertCurrent();
  if (!directory) {
    const root = await deps.root();
    assertCurrent();
    const lexical = validateLocalProjectDirectory(root);
    if (!lexical.ok) throwIpcError('INVALID_PARAMS', lexical.message);
    await fs.mkdir(root, { recursive: true });
    const valid = await validateExistingLocalProjectDirectory(root);
    if (!valid.ok) throwIpcError('INVALID_PARAMS', valid.message);
    const name = projectCreationFolderName(input.name || repository?.name || 'Project');
    for (let suffix = 1; suffix <= 1000; suffix++) {
      assertCurrent();
      directory = path.join(root, suffix === 1 ? name : `${name}-${suffix}`);
      try {
        await fs.mkdir(directory);
        owned = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    if (!owned) throwIpcError('ALREADY_EXISTS', 'Could not allocate a project directory');
  }
  const identity = owned ? await fs.lstat(directory) : null;
  const cleanup = async () => {
    if (!identity) return;
    const current = await fs.lstat(directory).catch(() => null);
    if (
      current &&
      !current.isSymbolicLink() &&
      current.dev === identity.dev &&
      current.ino === identity.ino
    )
      await fs.rm(directory, { recursive: true, force: true });
  };
  try {
    const lexical = validateLocalProjectDirectory(directory);
    if (!lexical.ok) throwIpcError('INVALID_PARAMS', lexical.message);
    const valid = await validateExistingLocalProjectDirectory(directory);
    if (!valid.ok) throwIpcError('INVALID_PARAMS', valid.message);
    assertCurrent();
    if (repository) {
      if ((await fs.readdir(directory)).length)
        throwIpcError('INVALID_PARAMS', 'Choose an empty directory for cloning');
      const args = ['-c', 'core.hooksPath='];
      if (
        new URL(repository.url).hostname === 'github.com' &&
        repository.url.startsWith('https:')
      ) {
        const gh = (await deps.github()).replaceAll('\\', '/');
        if (!/['\r\n]/.test(gh))
          args.push('-c', `credential.https://github.com.helper=!'${gh}' auth git-credential`);
      }
      assertCurrent();
      try {
        await deps.git([...args, 'clone', '--', repository.url, directory], {
          timeoutMs: 5 * 60_000,
          killProcessGroup: true,
          extraEnv: {
            GIT_TERMINAL_PROMPT: '0',
            GCM_INTERACTIVE: 'never',
            GH_TOKEN: undefined,
            GITHUB_TOKEN: undefined,
            GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oStrictHostKeyChecking=yes',
          },
        });
      } catch {
        throwIpcError(
          'PRECONDITION_FAILED',
          'Could not clone repository. Check its address and Git access on this computer.',
        );
      }
      assertCurrent();
    }
    return { directory, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
