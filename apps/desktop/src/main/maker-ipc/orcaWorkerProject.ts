import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file';
import { createLogger } from '../logger';
import { getCurrentDbClientSnapshot } from '../localDb/client/current';
import { listRecentWorkdirs } from '../localDb/ipc/recentWorkdirs';
import {
  resolveSessionGitDirLive,
  resolveWorkerInheritedDirectory,
  type WorkerProjectProbe,
} from '../git-context/sessionDirResolver';
import { gitExec } from '../worktree/gitExec';
import * as WorktreeManager from '../worktree/WorktreeManager';
import type { WorkerProjectContext, WorkerOwnedWorktree } from '../../shared/orca-worker-project';

const log = createLogger('orca-worker-project');
const stripEol = (value: string) => value.replace(/[\r\n]+$/, '');
const identity = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);

// Device-local history, partitioned by the database data owner. No defaults are persisted.
const recents = createOverrideSettingsFile<{ byOwner: Record<string, string[]> }>({
  filePath: () => path.join(app.getPath('userData'), 'orca-worker-projects.json'),
  defaults: { byOwner: {} },
  normalize: (raw) => {
    const values = (raw as { byOwner?: Record<string, unknown> } | null)?.byOwner ?? {};
    return {
      byOwner: Object.fromEntries(
        Object.entries(values).map(([owner, dirs]) => [
          owner,
          Array.isArray(dirs)
            ? [
                ...new Set(
                  dirs.filter(
                    (dir): dir is string => typeof dir === 'string' && path.isAbsolute(dir),
                  ),
                ),
              ].slice(0, 10)
            : [],
        ]),
      ),
    };
  },
  log,
  label: 'worker project history',
  logLoadedValue: false,
});

const normalizedPath = (directory: string) => identity(path.resolve(directory));

async function mapProjectDirectories<T>(
  directories: string[],
  read: (directory: string) => Promise<T>,
): Promise<T[]> {
  const results: T[] = new Array(directories.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, directories.length) }, async () => {
      while (next < directories.length) {
        const index = next++;
        results[index] = await read(directories[index]!);
      }
    }),
  );
  return results;
}

async function projectPathIdentity(
  directory: string,
  realpath: (directory: string) => Promise<string>,
): Promise<string> {
  try {
    return normalizedPath(await realpath(directory));
  } catch {
    return normalizedPath(directory);
  }
}

export async function rememberWorkerProject(directory: string, owner: string): Promise<void> {
  await recents.updateAtomic(({ value }) => {
    const seen = new Set<string>();
    return {
      byOwner: {
        ...value.byOwner,
        [owner]: [directory, ...(value.byOwner[owner] ?? [])]
          .filter((value) => {
            const key = normalizedPath(value);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .slice(0, 10),
      },
    };
  });
}

type ProjectLead = Parameters<typeof resolveWorkerInheritedDirectory>[0] & {
  workspaceKind?: string | null;
};
interface WorkerProjectContextDependencies {
  inherit(lead: ProjectLead): Promise<WorkerProjectProbe>;
  recentDirectories(): Promise<string[]>;
  isDirectory(directory: string): Promise<boolean>;
  realpath(directory: string): Promise<string>;
}
const contextDependencies: WorkerProjectContextDependencies = {
  realpath: (directory) => fs.realpath(directory),
  inherit: (lead) =>
    resolveWorkerInheritedDirectory(lead, {
      infer: resolveSessionGitDirLive,
      probe: probeWorkerProject,
    }),
  recentDirectories: async () => {
    const snapshot = getCurrentDbClientSnapshot();
    if (!snapshot) throw new Error('DbClient not ready');
    recents.invalidateIfChanged();
    const recent = await listRecentWorkdirs(snapshot.client);
    return [...(recents.read().byOwner[snapshot.userId] ?? []), ...recent.map((row) => row.path)];
  },
  isDirectory: async (directory) => {
    try {
      return (await fs.stat(directory)).isDirectory();
    } catch {
      return false;
    }
  },
};

/** Open-time snapshot. Recent projects already store roots; never run Git for list rows. */
export async function readWorkerProjectContext(
  lead: ProjectLead,
  deps: WorkerProjectContextDependencies = contextDependencies,
): Promise<WorkerProjectContext> {
  const [inherited, recent] = await Promise.all([deps.inherit(lead), deps.recentDirectories()]);
  const current = inherited.baseRepo ?? lead.workingDir ?? '';
  const aliases = [
    current,
    lead.workingDir,
    lead.worktreePath,
    inherited.directory,
    inherited.checkoutRoot,
  ].filter((directory): directory is string => !!directory);
  const paths = [
    ...new Map(
      [...aliases, ...recent].filter(Boolean).map((value) => [normalizedPath(value), value]),
    ).values(),
  ];
  const keys = await mapProjectDirectories(paths, (value) =>
    projectPathIdentity(value, deps.realpath),
  );
  const identities = new Map(paths.map((value, index) => [normalizedPath(value), keys[index]!]));
  const currentAliases = new Set(aliases.map((value) => identities.get(normalizedPath(value))!));
  const seen = new Set<string>();
  const directories: string[] = [];
  for (const value of [current, ...recent]) {
    if (!value) continue;
    const key = identities.get(normalizedPath(value))!;
    // Checkout/base-repository identities belong to the same current-project row.
    const projectKey = currentAliases.has(key) ? identities.get(normalizedPath(current))! : key;
    if (seen.has(projectKey)) continue;
    seen.add(projectKey);
    // Identity is canonical, but labels and submitted paths keep the original spelling.
    directories.push(currentAliases.has(key) ? current : value);
  }
  const projects = await mapProjectDirectories(directories, async (directory) => ({
    path: directory,
    name: path.basename(directory) || directory,
    description: directory,
    missing: !(await deps.isDirectory(directory)),
  }));

  return {
    recordedDirectory: lead.workingDir ?? '',
    inherited,
    selected: inherited,
    dialogue: lead.workspaceKind === 'dialogue',
    projects,
  };
}

/** Resolve the optional tool revision before reserving a slot or creating a checkout. */

import { createWorkerWorktreeProjects } from '@cindy/worktree-core/workerProject';
export const { probeWorkerProject, resolveWorkerWorktreeSource, getWorkerOwnedWorktree, createWorkerWorktree } = createWorkerWorktreeProjects({ gitExec, log, WorktreeManager });
