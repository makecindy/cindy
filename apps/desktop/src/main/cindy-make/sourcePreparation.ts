import { access, lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import originalFs from 'original-fs';
import path from 'node:path';
import type { MakeToolchainEnvironment } from './toolchainEnvironment.js';
import type { MakeSourceGitProgress, MakeSourceStatus } from '../../shared/cindyMakeDoctor.js';
import { runSourceGit } from './sourceGit.js';
import { CINDY_PERSONAL_BRANCH } from './sourcePaths.js';
import { checkMakeToolVersion, untilAborted } from './doctor.js';
export const CINDY_SOURCE_REPOSITORY = 'https://github.com/makecindy/cindy.git';
export { makeSourceRoot, makeSourceCheckoutPath } from './sourcePaths.js';

const SOURCE_STATUS_FILE = 'source-status.json';

function sourceStatusPath(root: string): string {
  return path.join(root, SOURCE_STATUS_FILE);
}

async function persistSourceStatus(root: string, status: MakeSourceStatus): Promise<void> {
  try {
    await mkdir(root, { recursive: true });
    await writeFile(sourceStatusPath(root), `${JSON.stringify(status)}\n`, 'utf8');
  } catch {
    // Status is auxiliary UI state; a failed write must not block source preparation.
  }
}

/** Read the last managed checkout summary without invoking Git or exposing arbitrary paths. */
export async function readCindySourceStatus(root: string): Promise<MakeSourceStatus> {
  const fallback: MakeSourceStatus = { status: 'missing', path: path.resolve(root, 'source') };
  try {
    const parsed = JSON.parse(
      await readFile(sourceStatusPath(root), 'utf8'),
    ) as Partial<MakeSourceStatus>;
    if (
      (parsed.status !== 'missing' &&
        parsed.status !== 'preparing' &&
        parsed.status !== 'ready' &&
        parsed.status !== 'failed' &&
        parsed.status !== 'cancelled') ||
      typeof parsed.path !== 'string' ||
      path.resolve(parsed.path) !== fallback.path
    )
      return fallback;
    return {
      status: parsed.status,
      path: fallback.path,
      ...(parsed.channel ? { channel: parsed.channel } : {}),
      ...(parsed.version ? { version: parsed.version } : {}),
      ...(parsed.ref ? { ref: parsed.ref } : {}),
      ...(parsed.commit && /^[0-9a-f]{7,64}$/i.test(parsed.commit)
        ? { commit: parsed.commit }
        : {}),
      ...(parsed.branch === CINDY_PERSONAL_BRANCH ? { branch: parsed.branch } : {}),
      ...(parsed.baseCommit && /^[0-9a-f]{7,64}$/i.test(parsed.baseCommit)
        ? { baseCommit: parsed.baseCommit }
        : {}),
      ...(parsed.error ? { error: parsed.error } : {}),
      ...(parsed.phase ? { phase: parsed.phase } : {}),
      ...(parsed.progress ? { progress: parsed.progress } : {}),
    };
  } catch {
    // Checkouts created before the status file was introduced remain visible.
    try {
      await access(path.join(fallback.path, '.git'));
      return { status: 'ready', path: fallback.path };
    } catch {
      return fallback;
    }
  }
}

const sourceStatusListeners = new Set<(status: MakeSourceStatus) => void>();

interface SharedSourceJob {
  clearOnly: boolean;
  controller: AbortController;
  latest?: SourcePreparationProgress;
  status?: MakeSourceStatus;
  listeners: Set<(progress: SourcePreparationProgress) => void>;
  promise: Promise<SourcePreparationResult>;
}

/** The single in-flight source operation; later callers attach to it instead of racing it. */
let inFlight: SharedSourceJob | undefined;

/** Subscribe to source preparation state shared by every renderer window. */
export function subscribeCindySourceStatus(
  listener: (status: MakeSourceStatus) => void,
): () => void {
  sourceStatusListeners.add(listener);
  return () => sourceStatusListeners.delete(listener);
}

/**
 * Status for the Settings card: live progress while a job runs; otherwise the
 * persisted file, where a leftover "preparing" can only be an interrupted run.
 */
export async function readCurrentCindySourceStatus(root: string): Promise<MakeSourceStatus> {
  if (inFlight?.status) return inFlight.status;
  const status = await readCindySourceStatus(root);
  if (status.status === 'preparing' && !inFlight) {
    return {
      ...status,
      status: 'cancelled',
      error: 'cancelled',
      phase: undefined,
      progress: undefined,
    };
  }
  return status;
}

/** Stop the running source operation, whichever window or workflow started it. */
export function cancelCindySourcePreparation(): boolean {
  if (!inFlight || inFlight.controller.signal.aborted) return false;
  inFlight.controller.abort('cancelled');
  return true;
}

function toSourceStatus(progress: SourcePreparationProgress): MakeSourceStatus {
  return {
    status: progress.status,
    path: progress.path,
    channel: progress.target.channel,
    version: progress.target.version,
    ref: progress.target.ref,
    ...(progress.commit ? { commit: progress.commit } : {}),
    ...(progress.branch ? { branch: progress.branch } : {}),
    ...(progress.baseCommit ? { baseCommit: progress.baseCommit } : {}),
    ...(progress.error ? { error: progress.error } : {}),
    ...(progress.phase ? { phase: progress.phase } : {}),
    ...(progress.progress ? { progress: progress.progress } : {}),
  };
}

export type CindyBuildChannel = 'dev' | 'beta' | 'release';
export interface CindyBuildIdentity {
  channel: CindyBuildChannel;
  version: string;
}

export interface CindySourceTarget {
  channel: CindyBuildChannel;
  version: string;
  ref: string;
  candidates: string[];
}

export interface SourcePreparationResult {
  status: 'ready' | 'failed' | 'cancelled';
  path: string;
  target: CindySourceTarget;
  /** HEAD of the checkout: the personal baseline branch. */
  commit?: string;
  branch?: string;
  /** Upstream baseline commit for `target.ref` after this fetch. */
  baseCommit?: string;
  error?: MakeSourceStatus['error'];
  cleared?: boolean;
}

export interface SourcePreparationProgress {
  status: 'preparing' | 'ready' | 'failed' | 'cancelled';
  path: string;
  target: CindySourceTarget;
  commit?: string;
  branch?: string;
  baseCommit?: string;
  error?: SourcePreparationResult['error'];
  phase?: MakeSourceStatus['phase'];
  progress?: MakeSourceGitProgress;
}

/** Resolve the two allowed release refs. A dev build always follows main. */
export function sourceTarget(identity: CindyBuildIdentity): CindySourceTarget {
  if (identity.channel === 'dev') {
    return { channel: 'dev', version: identity.version, ref: 'main', candidates: ['main'] };
  }
  const version = identity.version.trim().replace(/^v/i, '');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    return {
      channel: identity.channel,
      version,
      ref: '',
      candidates: [],
    };
  }
  const stable = `v${version.replace(/-beta(?:\.[0-9A-Za-z.-]+)?$/i, '')}`;
  const beta = `${stable}-beta`;
  const candidates = identity.channel === 'beta' ? [beta, stable] : [stable, beta];
  return { channel: identity.channel, version, ref: '', candidates };
}

async function git(
  env: MakeToolchainEnvironment,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  onProgress?: (progress: import('../../shared/cindyMakeDoctor.js').MakeSourceGitProgress) => void,
): Promise<string> {
  return runSourceGit(env.processEnvironment(), args, cwd, signal, onProgress);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function resolveRemoteRef(
  env: MakeToolchainEnvironment,
  target: CindySourceTarget,
  signal: AbortSignal,
): Promise<string> {
  if (!target.candidates.length)
    throw Object.assign(new Error('unsupportedVersion'), { code: 'unsupportedVersion' });
  const output = await git(
    env,
    [
      'ls-remote',
      '--heads',
      '--tags',
      CINDY_SOURCE_REPOSITORY,
      ...target.candidates.flatMap((ref) => [
        `refs/heads/${ref}`,
        `refs/tags/${ref}`,
        `refs/tags/${ref}^{}`,
      ]),
    ],
    process.cwd(),
    signal,
  );
  const refs = new Set(
    output
      .split(/\r?\n/)
      .map((line) =>
        line
          .trim()
          .split(/\s+/)[1]
          ?.replace(/\^\{\}$/, ''),
      )
      .filter((ref): ref is string => Boolean(ref)),
  );
  for (const candidate of target.candidates) {
    if (refs.has(`refs/heads/${candidate}`) || refs.has(`refs/tags/${candidate}`)) return candidate;
  }
  throw Object.assign(new Error('tagNotFound'), { code: 'tagNotFound' });
}

/**
 * Delete a Cindy-owned tree. Electron's asar-aware `fs` opens any `*.asar` it
 * walks past (the checkout's node_modules/electron ships default_app.asar) and
 * then cannot unlink the file it is holding itself, so deletion must go through
 * `original-fs`. Windows still reports EBUSY/EPERM while another process holds a
 * file inside; retry briefly, then report the lock instead of a generic failure.
 */
async function removeManagedTree(dir: string): Promise<void> {
  try {
    await originalFs.promises.rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  } catch {
    // Fall through to the existence check: partial removal is still a lock.
  }
  if (await exists(dir)) throw Object.assign(new Error('locked'), { code: 'locked' });
}

function gitErrorCode(error: unknown): SourcePreparationResult['error'] {
  const code = (error as { code?: unknown } | null)?.code;
  if (
    code === 'unsupportedVersion' ||
    code === 'tagNotFound' ||
    code === 'dirty' ||
    code === 'localCommits' ||
    code === 'gitUnavailable' ||
    code === 'installFailed' ||
    code === 'locked' ||
    code === 'environmentNotReady'
  )
    return code;
  if (code === 'cancelled') return 'cancelled';
  return 'gitFailed';
}

/**
 * Prepare (or clear) the managed checkout. The operation is global: a caller
 * arriving while the same kind of operation runs (Settings and the /cindy-make
 * workflow both prepare) receives its progress and result instead of starting a
 * second Git pipeline on the same directory, and any participant's abort stops
 * the shared job. A different kind waits for the running one to settle first.
 */
export async function prepareCindySource(
  env: MakeToolchainEnvironment,
  root: string,
  identity: CindyBuildIdentity,
  callerSignal: AbortSignal,
  onProgress: (progress: SourcePreparationProgress) => void = () => {},
  options: { clearOnly?: boolean } = {},
): Promise<SourcePreparationResult> {
  const clearOnly = options.clearOnly === true;
  const cancelled = (): SourcePreparationResult => ({
    status: 'cancelled',
    path: path.resolve(root, 'source'),
    target: sourceTarget(identity),
    error: 'cancelled',
  });
  while (inFlight && inFlight.clearOnly !== clearOnly) {
    if (callerSignal.aborted) return cancelled();
    await inFlight.promise.catch(() => undefined);
  }
  if (callerSignal.aborted) return cancelled();
  if (inFlight) {
    const job = inFlight;
    const forwardAbort = () => job.controller.abort(callerSignal.reason);
    job.listeners.add(onProgress);
    callerSignal.addEventListener('abort', forwardAbort, { once: true });
    if (job.latest) onProgress(job.latest);
    try {
      return await job.promise;
    } finally {
      job.listeners.delete(onProgress);
      callerSignal.removeEventListener('abort', forwardAbort);
    }
  }
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(callerSignal.reason);
  callerSignal.addEventListener('abort', forwardAbort, { once: true });
  const job: SharedSourceJob = {
    clearOnly,
    controller,
    listeners: new Set([onProgress]),
    promise: Promise.resolve(cancelled()),
  };
  const fanout = (progress: SourcePreparationProgress) => {
    job.latest = progress;
    job.status =
      clearOnly && progress.status === 'ready'
        ? { status: 'missing', path: progress.path }
        : toSourceStatus(progress);
    for (const listener of job.listeners) listener(progress);
    for (const listener of sourceStatusListeners) listener(job.status);
  };
  inFlight = job;
  job.promise = prepareCindySourceInternal(
    env,
    root,
    identity,
    controller.signal,
    fanout,
    options,
  ).finally(() => {
    callerSignal.removeEventListener('abort', forwardAbort);
    if (inFlight === job) inFlight = undefined;
  });
  return job.promise;
}

async function prepareCindySourceInternal(
  env: MakeToolchainEnvironment,
  root: string,
  identity: CindyBuildIdentity,
  signal: AbortSignal,
  onProgress: (progress: SourcePreparationProgress) => void = () => {},
  options: { clearOnly?: boolean } = {},
): Promise<SourcePreparationResult> {
  const target = sourceTarget(identity);
  const sourcePath = path.resolve(root, 'source');
  const initialStatus: MakeSourceStatus = {
    status: 'preparing',
    path: sourcePath,
    channel: target.channel,
    version: target.version,
    ref: target.ref,
  };
  await persistSourceStatus(root, initialStatus);
  const emitProgress = async (progress: SourcePreparationProgress) => {
    await persistSourceStatus(root, {
      status: progress.status,
      path: progress.path,
      channel: progress.target.channel,
      version: progress.target.version,
      ref: progress.target.ref,
      commit: progress.commit,
      branch: progress.branch,
      baseCommit: progress.baseCommit,
      error: progress.error,
      phase: progress.phase,
      progress: progress.progress,
    });
    onProgress(progress);
  };
  await emitProgress({ status: 'preparing', path: sourcePath, target, phase: 'checking' });
  try {
    await mkdir(root, { recursive: true });
    const gitDir = path.join(sourcePath, '.git');
    if ((await exists(sourcePath)) && (await lstat(sourcePath)).isSymbolicLink())
      throw Object.assign(new Error('gitFailed'), { code: 'gitFailed' });
    if ((await exists(gitDir)) && (await lstat(gitDir)).isSymbolicLink())
      throw Object.assign(new Error('gitFailed'), { code: 'gitFailed' });

    // Probe through the shared selector so the checkout uses a working system
    // Git first, then Cindy's managed Git. No build tools are needed here.
    if (!options.clearOnly || (await exists(sourcePath))) {
      const probe = await untilAborted(env.probe('git', ['--version'], signal), signal);
      if (checkMakeToolVersion('git', probe, env.platform).status !== 'passed')
        throw Object.assign(new Error('gitUnavailable'), { code: 'gitUnavailable' });
    }

    // Clearing is deliberately local: it never resolves a remote ref, fetches, or
    // re-clones. Only a verified Cindy checkout may be removed.
    if (options.clearOnly) {
      if (!(await exists(sourcePath))) {
        await persistSourceStatus(root, { status: 'missing', path: sourcePath });
        const result: SourcePreparationResult = {
          status: 'ready',
          path: sourcePath,
          target,
          cleared: true,
        };
        onProgress(result);
        return result;
      }
      if (!(await exists(gitDir)))
        throw Object.assign(new Error('gitFailed'), { code: 'gitFailed' });
      const remote = await git(env, ['remote', 'get-url', 'origin'], sourcePath, signal);
      if (remote !== CINDY_SOURCE_REPOSITORY)
        throw Object.assign(new Error('gitFailed'), { code: 'gitFailed' });
      // The personal branch and task worktrees legitimately hold local work; the
      // settings dialog states that clearing discards them. Only a verified Cindy
      // checkout is removed, together with the worktrees it owns.
      await removeManagedTree(path.resolve(root, 'worktrees'));
      await removeManagedTree(sourcePath);
      await persistSourceStatus(root, { status: 'missing', path: sourcePath });
      const result: SourcePreparationResult = {
        status: 'ready',
        path: sourcePath,
        target,
        cleared: true,
      };
      onProgress(result);
      return result;
    }

    const resolvedRef = await resolveRemoteRef(env, target, signal);
    const resolvedTarget = { ...target, ref: resolvedRef };
    if (await exists(gitDir)) {
      const remote = await git(env, ['remote', 'get-url', 'origin'], sourcePath, signal);
      if (remote !== CINDY_SOURCE_REPOSITORY)
        throw Object.assign(new Error('gitFailed'), { code: 'gitFailed' });
      await emitProgress({
        status: 'preparing',
        path: sourcePath,
        target: resolvedTarget,
        phase: 'fetching',
      });
      await git(
        env,
        ['fetch', '--progress', '--tags', '--force', 'origin'],
        sourcePath,
        signal,
        (progress) =>
          onProgress({
            status: 'preparing',
            path: sourcePath,
            target: resolvedTarget,
            phase: 'fetching',
            progress,
          }),
      );
      // Nobody works in the managed checkout itself (tasks use their own worktrees),
      // so uncommitted changes here mean an older layout or outside tampering.
      const dirty = await git(env, ['status', '--porcelain'], sourcePath, signal);
      if (dirty) throw Object.assign(new Error('dirty'), { code: 'dirty' });
    }
    if (!(await exists(gitDir))) {
      if (await exists(sourcePath)) {
        const info = await stat(sourcePath);
        if (!info.isDirectory()) throw Object.assign(new Error('gitFailed'), { code: 'gitFailed' });
        // A directory without .git is the remainder of an interrupted clear (a file
        // was locked mid-delete). Git refuses to clone into it; finish the removal.
        await removeManagedTree(sourcePath);
      }
      await emitProgress({
        status: 'preparing',
        path: sourcePath,
        target: resolvedTarget,
        phase: 'cloning',
      });
      await git(
        env,
        [
          'clone',
          '--progress',
          '--filter=blob:none',
          '--no-tags',
          '--branch',
          resolvedRef,
          CINDY_SOURCE_REPOSITORY,
          sourcePath,
        ],
        root,
        signal,
        (progress) =>
          onProgress({
            status: 'preparing',
            path: sourcePath,
            target: resolvedTarget,
            phase: 'cloning',
            progress,
          }),
      );
      await emitProgress({
        status: 'preparing',
        path: sourcePath,
        target: resolvedTarget,
        phase: 'fetching',
      });
      await git(
        env,
        ['fetch', '--progress', '--tags', '--force', 'origin'],
        sourcePath,
        signal,
        (progress) =>
          onProgress({
            status: 'preparing',
            path: sourcePath,
            target: resolvedTarget,
            phase: 'fetching',
            progress,
          }),
      );
    }
    // The personal baseline is created once from the upstream ref and then left
    // alone: updating it to a newer upstream is a separate, explicit action, so
    // every task starts from the version the user last verified.
    const baseRef = resolvedRef === 'main' ? 'origin/main' : `refs/tags/${resolvedRef}`;
    await emitProgress({
      status: 'preparing',
      path: sourcePath,
      target: resolvedTarget,
      phase: 'preparingBranch',
    });
    const baseCommit = await git(env, ['rev-parse', `${baseRef}^{commit}`], sourcePath, signal);
    const hasPersonal = await git(
      env,
      ['branch', '--list', CINDY_PERSONAL_BRANCH],
      sourcePath,
      signal,
    );
    if (!hasPersonal.trim()) {
      await git(env, ['branch', CINDY_PERSONAL_BRANCH, baseCommit], sourcePath, signal);
    }
    await emitProgress({
      status: 'preparing',
      path: sourcePath,
      target: resolvedTarget,
      phase: 'checkingOut',
      baseCommit,
    });
    await git(env, ['checkout', CINDY_PERSONAL_BRANCH], sourcePath, signal);
    const commit = await git(env, ['rev-parse', 'HEAD'], sourcePath, signal);
    // No dependency install here: nobody works in this checkout, task worktrees
    // install their own, and packaging installs when it actually runs.
    const result: SourcePreparationResult = {
      status: 'ready',
      path: sourcePath,
      target: resolvedTarget,
      commit,
      branch: CINDY_PERSONAL_BRANCH,
      baseCommit,
    };
    await emitProgress(result);
    return result;
  } catch (error) {
    const code = signal.aborted ? 'cancelled' : gitErrorCode(error);
    const result: SourcePreparationResult = {
      status: code === 'cancelled' ? 'cancelled' : 'failed',
      path: sourcePath,
      target,
      error: code,
    };
    await persistSourceStatus(root, {
      status: 'failed',
      path: sourcePath,
      channel: target.channel,
      version: target.version,
      ref: target.ref,
      error: code,
    });
    await emitProgress(result);
    return result;
  }
}
