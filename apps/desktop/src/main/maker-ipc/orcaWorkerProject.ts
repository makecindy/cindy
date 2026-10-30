import { getNewMakerWorktreeBranchPreference } from '../maker-host/newMakerWorktreeBranchPreferenceCache';
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
import type {
  WorkerProjectContext,
  WorkerOwnedWorktree,
  WorkerWorktreeSourceSelection,
} from '../../shared/orca-worker-project';

const log = createLogger('orca-worker-project');
const stripEol = (value: string) => value.replace(/[\r\n]+$/, '');
const identity = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);

export async function probeWorkerProject(
  directory: string,
  details = true,
): Promise<WorkerProjectProbe> {
  const result: WorkerProjectProbe = {
    directory,
    baseRepo: null as string | null,
    branch: null as string | null,
    exists: false,
    dirty: false,
    isWorktree: false,
    worktreeName: undefined as string | undefined,
    commonDir: null as string | null,
    checkoutRoot: null as string | null,
    realDirectory: null as string | null,
  };
  try {
    result.exists = (await fs.stat(directory)).isDirectory();
    if (result.exists) result.realDirectory = await fs.realpath(directory);
  } catch {
    return result;
  }
  if (!result.exists) return result;
  try {
    const options = { timeoutMs: 5000 };
    const { stdout } = await gitExec(
      ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--git-dir'],
      directory,
      options,
    );
    const [root, common, gitDir] = stripEol(stdout).split(/\r?\n/);
    result.checkoutRoot = await fs.realpath(root);
    result.commonDir = await fs.realpath(common);
    result.isWorktree = identity(await fs.realpath(gitDir)) !== identity(result.commonDir);
    if (result.isWorktree) result.worktreeName = path.basename(root);
    // worktree list's first entry is the main checkout (also handles separate git dirs).
    const { stdout: list } = await gitExec(
      ['worktree', 'list', '--porcelain', '-z'],
      directory,
      options,
    );
    const first = list.split('\0').find((line) => line.startsWith('worktree '));
    result.baseRepo = first ? first.slice(9) : root;
    if (!details) return result;
    const { stdout: status } = await gitExec(
      ['status', '--porcelain=v2', '--branch', '--untracked-files=normal'],
      directory,
      options,
    );
    const lines = stripEol(status).split(/\r?\n/);
    const oid = lines.find((line) => line.startsWith('# branch.oid '))?.slice(13);
    const head = lines.find((line) => line.startsWith('# branch.head '))?.slice(14);
    if (oid === '(initial)') {
      result.headState = 'unborn';
    } else if (oid && head) {
      result.headState = head === '(detached)' ? 'detached' : 'branch';
      result.branch = result.headState === 'detached' ? oid : head;
    }
    result.dirty = lines.some((line) => line.length > 0 && !line.startsWith('# '));
  } catch {
    /* Non-Git directories remain valid projects. */
  }
  return result;
}

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

function validateWorktreeSource(sourceBranch: string | undefined): void {
  if (
    sourceBranch !== undefined &&
    (typeof sourceBranch !== 'string' ||
      !sourceBranch.trim() ||
      sourceBranch.length > 1024 ||
      sourceBranch.startsWith('-') ||
      Array.from(sourceBranch).some((character) => character.charCodeAt(0) < 32))
  ) {
    throw new Error('Worktree source_branch must be a valid branch or commit');
  }
}

/** Resolve the optional tool revision before reserving a slot or creating a checkout. */
export async function resolveWorkerWorktreeSourceSelection(
  directory: string,
  sourceBranch?: string,
  probe: (directory: string) => Promise<WorkerProjectProbe> = probeWorkerProject,
  leadDirectory?: string | null,
  readPreference = getNewMakerWorktreeBranchPreference,
): Promise<WorkerWorktreeSourceSelection> {
  validateWorktreeSource(sourceBranch);
  const info = await probe(directory);
  if (!info.exists) throw new Error('Worker worktree directory does not exist');
  if (!info.baseRepo) throw new Error('Worker worktree requires a Git repository');
  let source: WorkerWorktreeSourceSelection['source'] =
    sourceBranch === undefined ? 'current' : 'explicit';
  let fallbackReason: string | undefined;
  if (sourceBranch === undefined && leadDirectory !== undefined) {
    const [target, lead] = await Promise.all([
      projectPathIdentity(directory, fs.realpath),
      leadDirectory ? projectPathIdentity(leadDirectory, fs.realpath) : Promise.resolve(null),
    ]);
    let sameRepository = target === lead;
    if (!sameRepository && leadDirectory) {
      const leadProject = await probe(leadDirectory);
      if (leadProject.baseRepo) {
        const [targetRepo, leadRepo] = await Promise.all([
          projectPathIdentity(info.baseRepo, fs.realpath),
          projectPathIdentity(leadProject.baseRepo, fs.realpath),
        ]);
        sameRepository = targetRepo === leadRepo;
      }
    }
    if (!sameRepository) {
      try {
        sourceBranch = readPreference(info.baseRepo)?.sourceBranch;
      } catch {
        fallbackReason =
          'Could not read the remembered source branch; used the current checkout branch.';
      }
      if (sourceBranch !== undefined) {
        try {
          validateWorktreeSource(sourceBranch);
          await gitExec(
            ['rev-parse', '--verify', '--quiet', '--end-of-options', `${sourceBranch}^{commit}`],
            directory,
            { timeoutMs: 5000 },
          );
          source = 'memory';
        } catch {
          sourceBranch = undefined;
          fallbackReason =
            'The remembered source branch no longer exists or cannot be verified; used the current checkout branch.';
        }
      } else if (!fallbackReason) {
        fallbackReason = 'No remembered source branch; used the current checkout branch.';
      }
    }
  }
  validateWorktreeSource(sourceBranch);
  if (sourceBranch !== undefined && source === 'explicit') {
    try {
      await gitExec(
        ['rev-parse', '--verify', '--quiet', '--end-of-options', `${sourceBranch}^{commit}`],
        directory,
        { timeoutMs: 5000 },
      );
    } catch {
      throw new Error('Worktree source_branch must reference an existing commit');
    }
  }
  if (sourceBranch !== undefined) return { sourceBranch, source };
  if (info.headState === 'unborn' || !info.branch) {
    throw new Error('Worker worktree requires a repository with a commit');
  }
  return { sourceBranch: info.branch, source, ...(fallbackReason ? { fallbackReason } : {}) };
}

/** Compatibility reader for callers that only need the resolved revision. */
export async function resolveWorkerWorktreeSource(
  directory: string,
  sourceBranch?: string,
  probe: (directory: string) => Promise<WorkerProjectProbe> = probeWorkerProject,
): Promise<string> {
  return (await resolveWorkerWorktreeSourceSelection(directory, sourceBranch, probe)).sourceBranch;
}

export function getWorkerOwnedWorktree(sessionId: string): WorkerOwnedWorktree | undefined {
  const meta = WorktreeManager.getForSession(sessionId);
  return meta ? { path: meta.path, branch: meta.branch } : undefined;
}

export async function createWorkerWorktree(
  sessionId: string,
  directory: string,
  sourceBranch: string,
): Promise<string> {
  const info = await probeWorkerProject(directory);
  if (!info.baseRepo) throw new Error('Worker worktree requires a Git repository');
  const created = await WorktreeManager.createWorktree(
    { sessionId, baseRepo: info.baseRepo, name: '', sourceBranch },
    { trackBackgroundCheckout: true },
  );
  if (!created.ok) throw new Error(`Worker worktree creation failed: ${created.error.message}`);
  // Probe paths are realpaths, so a symlink spelling cannot change the subproject offset.
  const relative =
    info.checkoutRoot && info.realDirectory
      ? path.relative(info.checkoutRoot, info.realDirectory)
      : '';
  if (!relative) return created.meta.path;

  // Stage checkout only includes root startup files. A subproject and its rules need
  // the full checkout; root-directory Workers keep the normal asynchronous startup.
  await WorktreeManager.awaitBackgroundCheckout(sessionId);
  const subproject = path.join(created.meta.path, relative);
  try {
    const [realRoot, realSubproject] = await Promise.all([
      fs.realpath(created.meta.path),
      fs.realpath(subproject),
    ]);
    const withinRoot = path.relative(identity(realRoot), identity(realSubproject));
    if (
      withinRoot &&
      withinRoot !== '..' &&
      !withinRoot.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(withinRoot) &&
      (await fs.stat(realSubproject)).isDirectory()
    )
      return subproject;
  } catch {
    // The selected source branch may not contain this subproject.
  }
  log.warn('Worker subproject is unavailable within the new worktree; using its root', {
    sessionId,
  });
  return created.meta.path;
}
