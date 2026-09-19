import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, unlink } from 'node:fs/promises';
import originalFs from 'original-fs';
import { brandExecutableName } from '@cindy/maker-shared/brand-identity';
import {
  retainPersonalVersion,
  publishPersonalVersion,
  versionDirectory,
  assertVersionDirectory,
  type VersionProfile,
} from './versionStore.js';
import { defaultPtySpawn, type PtySpawnFn } from '../terminal/ptyFactory.js';
import { snapshotContent, contentRef, applyContent, taskContentRef } from './sourceContent.js';
import { runSourceGit } from './sourceGit.js';
import { runSourcePnpm } from './sourcePnpm.js';
import { makeSourceCheckoutPath, makeSourceRoot, CINDY_PERSONAL_BRANCH } from './sourcePaths.js';
import {
  makeTestEnvironment,
  verifyMakeTestWorkspace,
  type MakeTestWorkspace,
} from './testRunner.js';
import type { CindyMakePersonalBuildState } from '../../shared/cindyMakeSession.js';
import { commitLocalFiles, commitPersonalFiles, MAKE_GIT_IDENTITY } from './localHistory.js';
import { createPersonalBuildCleanup } from './personalBuildCleanup.js';

type BuildError = NonNullable<CindyMakePersonalBuildState['error']>;
export function personalBuildError(code: BuildError): Error & { code: BuildError } {
  return Object.assign(new Error(code), { code });
}
export type PersonalArtifact = Required<
  Pick<CindyMakePersonalBuildState, 'artifactDirectory' | 'artifactName' | 'sha256' | 'commit'>
> & {
  versionId?: string;
  tree?: string;
  includedFeatures?: Array<{ runId: string; operationId: string }>;
};
const samePath = (a: string, b: string) =>
  process.platform === 'win32'
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);
const hashFile = async (file: string) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};

/** Resolve only recorded installer files inside this completion's private output directory. */
export async function personalArtifactPath(
  userData: string,
  completionId: string,
  artifact: PersonalArtifact,
): Promise<string> {
  if (
    !artifact.artifactDirectory.startsWith(completionId + '-') ||
    path.basename(artifact.artifactDirectory) !== artifact.artifactDirectory ||
    path.basename(artifact.artifactName) !== artifact.artifactName ||
    !/\.(exe|dmg|deb|zip)$/i.test(artifact.artifactName)
  )
    throw personalBuildError('unavailable');
  const directory = path.join(makeSourceRoot(userData), 'packages', artifact.artifactDirectory);
  const file = path.join(directory, artifact.artifactName);
  const info = await lstat(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    !samePath(
      await realpath(file),
      path.join(await realpath(userData), path.relative(userData, file)),
    ) ||
    (await hashFile(file)) !== artifact.sha256
  )
    throw personalBuildError('unavailable');
  return file;
}

export function runPersonalPackageCommand(
  node: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  spawn: PtySpawnFn = defaultPtySpawn,
): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(node, args, {
      cwd,
      env: makeTestEnvironment(env),
      cols: 4096,
      rows: 30,
      name: 'xterm-256color',
    });
    // Drain output so compiler progress cannot block the process; never publish raw build logs.
    child.onData(() => {});
    const abort = () => {
      try {
        child.kill();
      } catch {
        // The process may have exited before cancellation reached it.
      }
    };
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abort();
    }, 60 * 60_000);
    timeout.unref?.();
    signal.addEventListener('abort', abort, { once: true });
    child.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(personalBuildError('interrupted'));
      else if (timedOut || exitCode !== 0) reject(personalBuildError('buildFailed'));
      else resolve();
    });
    if (signal.aborted) abort();
  });
}

export async function personalBuildEnvironment(
  env: NodeJS.ProcessEnv,
  gitExecutable?: string,
): Promise<NodeJS.ProcessEnv> {
  const result = makeTestEnvironment(env);
  if (process.platform !== 'win32') return result;
  const roots = [
    gitExecutable ? path.dirname(path.dirname(gitExecutable)) : undefined,
    env.ProgramFiles ? path.join(env.ProgramFiles, 'Git') : undefined,
  ];
  const dirs = [
    ...roots.flatMap((root) =>
      root ? [path.join(root, 'bin'), path.join(root, 'usr', 'bin')] : [],
    ),
    ...result.PATH.split(path.delimiter),
  ];
  for (const directory of dirs) {
    try {
      if (
        !(await lstat(path.join(directory, 'bash.exe'))).isFile() ||
        /^(WindowsApps|System32|Sysnative)$/i.test(path.basename(directory))
      )
        continue;
      return { ...result, PATH: directory.replace(/\\/g, '/') + path.delimiter + result.PATH };
    } catch {
      // A missing candidate does not prevent trying the next Git Bash location.
    }
  }
  throw personalBuildError('missingShell');
}

interface BuildDeps {
  git?: typeof runSourceGit;
  pnpm?: typeof runSourcePnpm;
  packageCommand?: typeof runPersonalPackageCommand;
  verify?: typeof verifyMakeTestWorkspace;
  features?: () => Array<{ runId: string; operationId: string }>;
}

/** Integrate task files first, then build only in the locked cindy-personal checkout. */
export async function buildCindyPersonal(
  task: (MakeTestWorkspace | { mode: 'personal'; userData: string }) & {
    completionId: string;
    title?: string;
    profile?: VersionProfile;
  },
  node: string,
  environment: NodeJS.ProcessEnv,
  region: 'cn' | 'global' | 'dev',
  signal: AbortSignal,
  publish: (state: CindyMakePersonalBuildState) => Promise<void>,
  checkCurrent: () => void,
  withProject: <T>(operation: () => Promise<T>) => Promise<T>,
  deps: BuildDeps = {},
): Promise<PersonalArtifact> {
  return withProject(async () => {
    const editingTask = 'mode' in task ? undefined : task;
    const verifyTask = async () => {
      if (editingTask)
        await (deps.verify ?? verifyMakeTestWorkspace)(editingTask, environment, signal);
    };
    const source = makeSourceCheckoutPath(task.userData);
    const merge = await mkdtemp(path.join(os.tmpdir(), 'cindy-make-merge-'));
    const canonicalMerge = await realpath(merge);
    let output: string | undefined;
    let published = false;
    let versionId: string | undefined;
    let cleanup: Awaited<ReturnType<typeof createPersonalBuildCleanup>> | undefined;
    const check = () => {
      signal.throwIfAborted();
      checkCurrent();
    };
    const git = async (args: string[], cwd = source, indexFile?: string) => {
      check();
      return (deps.git ?? runSourceGit)(
        { ...environment, ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}) },
        args,
        cwd,
        signal,
      );
    };
    const pnpm = (args: string[]) => {
      check();
      return (deps.pnpm ?? runSourcePnpm)(environment, args, source, signal);
    };
    let baseline = '';
    let baselineTree = '';
    let candidateTree = '';
    let taskTree = '';
    const assertSource = async (tree: string) => {
      if (
        (await git(['rev-parse', 'HEAD'])).trim() !== baseline ||
        (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim() !== CINDY_PERSONAL_BRANCH ||
        (await snapshotContent(git, source)) !== tree
      )
        throw personalBuildError('baselineChanged');
    };
    try {
      check();
      await publish({ status: 'merging' });
      await verifyTask();
      const canonicalSource = await realpath(source);
      if ((await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim() !== CINDY_PERSONAL_BRANCH)
        throw personalBuildError('changed');
      cleanup = await createPersonalBuildCleanup(task.userData, region, (args, cwd) =>
        (deps.git ?? runSourceGit)(environment, args, cwd, AbortSignal.timeout(30_000)),
      );
      await cleanup.clean();
      const personal = await commitPersonalFiles(git, source);
      baseline = personal.commit;
      baselineTree = personal.tree;
      if (editingTask) {
        const task = editingTask;
        taskTree = task.tree ?? (await git(['rev-parse', task.commit + '^{tree}'])).trim();
        const taskBase =
          (await contentRef(git, source, taskContentRef(task.runId, 'integrated'))) ??
          (await contentRef(git, source, taskContentRef(task.runId, 'base'))) ??
          (
            await git([
              'rev-parse',
              (await git(['merge-base', baseline, task.commit])).trim() + '^{tree}',
            ])
          ).trim();
        await git(['worktree', 'add', '--detach', merge, baseline]);
        let candidateCommit: string;
        try {
          const committedTaskTree = (await git(['rev-parse', task.commit + '^{tree}'])).trim();
          if (committedTaskTree === taskTree) {
            await git(
              [...MAKE_GIT_IDENTITY, 'merge', '--no-commit', '--no-ff', task.commit],
              merge,
            );
          } else {
            // Retained pre-upgrade completions have a file snapshot but no task commit yet.
            await applyContent(git, merge, taskBase, taskTree, true);
          }
          const candidate = await commitLocalFiles(
            git,
            merge,
            'Cindy Make: integrate personal feature',
            true,
          );
          candidateTree = candidate.tree;
          candidateCommit = candidate.commit;
        } catch (error) {
          if ((await git(['ls-files', '--unmerged'], merge)).trim())
            throw personalBuildError('conflict');
          throw error;
        }
        await (deps.verify ?? verifyMakeTestWorkspace)(task, environment, signal);
        await assertSource(baselineTree);
        check();
        // Adopt the local merge commit before checking/packaging in the real personal checkout.
        // Cancellation never discards the already integrated commit or the editing worktree.
        const adoptGit = (args: string[], cwd: string, indexFile?: string) =>
          (deps.git ?? runSourceGit)(
            { ...environment, ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}) },
            args,
            cwd,
            AbortSignal.timeout(120_000),
          );
        await adoptGit(['merge', '--ff-only', candidateCommit], source);
        await adoptGit(['update-ref', taskContentRef(task.runId, 'integrated'), taskTree], source);
        baseline = candidateCommit;
      } else {
        candidateTree = baselineTree;
      }
      const includedFeatures = deps.features?.();
      check();
      try {
        await publish({ status: 'checking', checkStep: 'dependencies' });
        await pnpm(['install', '--frozen-lockfile', '--prefer-offline', '--prod=false']);
        await publish({ status: 'checking', checkStep: 'tests' });
        await pnpm(['test:unit:related']);
        await publish({ status: 'checking', checkStep: 'types' });
        await pnpm(['--recursive', '--workspace-concurrency=1', '--if-present', 'typecheck']);
      } catch {
        throw personalBuildError(signal.aborted ? 'interrupted' : 'checksFailed');
      }
      check();
      await assertSource(candidateTree);
      const artifacts = path.join(
        source,
        'apps',
        'desktop',
        'release',
        'artifacts',
        region,
        'unversioned',
        process.platform + '-' + process.arch,
      );
      // This checkout is reused. An old manifest must never make an empty build look successful.
      try {
        if (
          !samePath(
            await realpath(artifacts),
            path.join(canonicalSource, path.relative(source, artifacts)),
          )
        )
          throw personalBuildError('unavailable');
        await unlink(path.join(artifacts, 'build-info.json'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await publish({ status: 'packaging' });
      check();
      await cleanup.captureManifest();
      await (deps.packageCommand ?? runPersonalPackageCommand)(
        node,
        [
          path.join(source, 'apps', 'desktop', 'scripts', 'package-desktop.mjs'),
          '--platform',
          process.platform,
          '--arch',
          process.arch,
          '--region',
          region,
          '--no-sign',
        ],
        source,
        environment,
        signal,
      );
      check();
      await assertSource(candidateTree);
      const info = JSON.parse(await readFile(path.join(artifacts, 'build-info.json'), 'utf8'));
      const installer = Array.isArray(info.files)
        ? info.files.find((file: { role?: string }) => file.role === 'installer')
        : undefined;
      if (
        info.product !== 'cindy-desktop' ||
        info.versionless !== true ||
        info.version !== null ||
        info.commitSha !== baseline ||
        info.region !== region ||
        info.platform !== process.platform ||
        info.arch !== process.arch ||
        !installer ||
        typeof installer.name !== 'string' ||
        path.basename(installer.name) !== installer.name ||
        !/\.(exe|dmg|deb|zip)$/i.test(installer.name) ||
        !/^[0-9a-f]{64}$/i.test(installer.sha256 ?? '')
      )
        throw personalBuildError('buildFailed');
      const installerPath = path.join(artifacts, installer.name);
      if (
        !samePath(
          await realpath(installerPath),
          path.join(canonicalSource, path.relative(source, installerPath)),
        ) ||
        (await hashFile(installerPath)) !== installer.sha256
      )
        throw personalBuildError('buildFailed');
      const packages = path.join(makeSourceRoot(task.userData), 'packages');
      await mkdir(packages, { recursive: true });
      if (
        (await lstat(packages)).isSymbolicLink() ||
        !samePath(
          await realpath(packages),
          path.join(await realpath(task.userData), path.relative(task.userData, packages)),
        )
      )
        throw personalBuildError('unavailable');
      output = await mkdtemp(path.join(packages, task.completionId + '-'));
      await copyFile(installerPath, path.join(output, installer.name));
      const artifact: PersonalArtifact = {
        artifactDirectory: path.basename(output),
        artifactName: installer.name,
        sha256: installer.sha256,
        commit: baseline,
        tree: candidateTree,
        ...(includedFeatures ? { includedFeatures } : {}),
      };
      await personalArtifactPath(task.userData, task.completionId, artifact);
      if (task.profile) {
        const appName = brandExecutableName(region);
        const packaged = path.join(
          source,
          'apps',
          'desktop',
          'out',
          appName + '-' + process.platform + '-' + process.arch,
        );
        versionId = await retainPersonalVersion({
          profile: task.profile,
          sourceDirectory:
            process.platform === 'darwin' ? path.join(packaged, appName + '.app') : packaged,
          appName,
          title: task.title ?? '',
          commit: baseline,
          tree: candidateTree,
        });
        if (versionId) artifact.versionId = versionId;
      }
      await publish({ status: 'publishing' });
      await verifyTask();
      await cleanup.restoreManifest();
      await cleanup.clean();
      await assertSource(candidateTree);
      check();
      if (versionId) publishPersonalVersion(task.userData, versionId);
      published = true;
      return artifact;
    } finally {
      let cleanupFailed = false;
      // Only the merge candidate is disposable. Never remove the source or editing worktree.
      const disposable = async () => {
        try {
          return (
            !(await lstat(merge)).isSymbolicLink() &&
            samePath(await realpath(merge), canonicalMerge)
          );
        } catch {
          return false;
        }
      };
      if (await disposable()) {
        try {
          await (deps.git ?? runSourceGit)(
            environment,
            ['-c', 'core.longpaths=true', 'worktree', 'remove', '--force', merge],
            source,
            AbortSignal.timeout(120_000),
          );
        } catch {
          // A partial Git cleanup can still leave a disposable directory below.
        }
        try {
          if (await disposable())
            await originalFs.promises.rm(merge, {
              recursive: true,
              force: true,
              maxRetries: 3,
              retryDelay: 200,
            });
        } catch {
          cleanupFailed = true;
        }
      }
      if (!published && output) {
        try {
          if (
            !(await lstat(output)).isSymbolicLink() &&
            samePath(
              await realpath(output),
              path.join(await realpath(task.userData), path.relative(task.userData, output)),
            )
          )
            await originalFs.promises.rm(output, { recursive: true, force: true });
        } catch {
          cleanupFailed = true;
        }
      }
      if (!published && versionId) {
        const directory = versionDirectory(task.userData, versionId);
        try {
          assertVersionDirectory(task.userData, directory);
          await originalFs.promises.rm(directory, { recursive: true, force: true });
        } catch {
          cleanupFailed = true;
        }
      }
      if (cleanup) {
        try {
          await cleanup.restoreManifest();
        } catch {
          cleanupFailed = true;
        }
        try {
          await cleanup.clean();
        } catch {
          cleanupFailed = true;
        }
      }
      if (cleanupFailed && !published) throw personalBuildError('cleanupFailed');
    }
  });
}
