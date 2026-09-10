import { access, lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MakeToolchainEnvironment } from './toolchainEnvironment.js';
import type { MakeSourceGitProgress, MakeSourceStatus } from '../../shared/cindyMakeDoctor.js';
import { runSourceGit } from './sourceGit.js';
import { checkMakeToolVersion, untilAborted } from './doctor.js';
export const CINDY_SOURCE_REPOSITORY = 'https://github.com/makecindy/cindy.git';
export function makeSourceRoot(userData: string): string {
  return path.join(userData, 'cindy-make');
}

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
  commit?: string;
  error?: MakeSourceStatus['error'];
  cleared?: boolean;
}

export interface SourcePreparationProgress {
  status: 'preparing' | 'ready' | 'failed' | 'cancelled';
  path: string;
  target: CindySourceTarget;
  commit?: string;
  error?: SourcePreparationResult['error'];
  phase?: 'checking' | 'cloning' | 'fetching' | 'checkingOut';
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

function gitErrorCode(error: unknown): SourcePreparationResult['error'] {
  const code = (error as { code?: unknown } | null)?.code;
  if (
    code === 'unsupportedVersion' ||
    code === 'tagNotFound' ||
    code === 'dirty' ||
    code === 'localCommits' ||
    code === 'gitUnavailable' ||
    code === 'environmentNotReady'
  )
    return code;
  if (code === 'cancelled') return 'cancelled';
  return 'gitFailed';
}

/** Prepare a managed checkout without touching the official app directory or user workdirs. */
export async function prepareCindySource(
  env: MakeToolchainEnvironment,
  root: string,
  identity: CindyBuildIdentity,
  signal: AbortSignal,
  onProgress: (progress: SourcePreparationProgress) => void = () => {},
  options: { clearOnly?: boolean } = {},
): Promise<SourcePreparationResult> {
  const target = sourceTarget(identity);
  const sourcePath = path.resolve(root, 'source');
  const previousStatus = await readCindySourceStatus(root);
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
      const dirty = await git(env, ['status', '--porcelain'], sourcePath, signal);
      if (dirty) throw Object.assign(new Error('dirty'), { code: 'dirty' });
      const stash = await git(env, ['stash', 'list'], sourcePath, signal);
      if (stash) throw Object.assign(new Error('localCommits'), { code: 'localCommits' });
      const clearRef = previousStatus.ref || target.ref;
      if (!clearRef) throw Object.assign(new Error('gitFailed'), { code: 'gitFailed' });
      const baseRef = clearRef === 'main' ? 'refs/remotes/origin/main' : `refs/tags/${clearRef}`;
      const localCommits = await git(
        env,
        ['rev-list', 'HEAD', '--not', baseRef],
        sourcePath,
        signal,
      );
      if (localCommits) throw Object.assign(new Error('localCommits'), { code: 'localCommits' });
      await rm(sourcePath, { recursive: true, force: true });
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
      const dirty = await git(env, ['status', '--porcelain'], sourcePath, signal);
      if (dirty) throw Object.assign(new Error('dirty'), { code: 'dirty' });
      const stash = await git(env, ['stash', 'list'], sourcePath, signal);
      if (stash) throw Object.assign(new Error('localCommits'), { code: 'localCommits' });
      const baseRef =
        resolvedRef === 'main' ? 'refs/remotes/origin/main' : `refs/tags/${resolvedRef}`;
      const localCommits = await git(
        env,
        ['rev-list', 'HEAD', '--not', baseRef],
        sourcePath,
        signal,
      );
      if (localCommits) throw Object.assign(new Error('localCommits'), { code: 'localCommits' });
      const checkoutRef = resolvedRef === 'main' ? 'origin/main' : resolvedRef;
      await emitProgress({
        status: 'preparing',
        path: sourcePath,
        target: resolvedTarget,
        phase: 'checkingOut',
      });
      await git(env, ['checkout', '--detach', checkoutRef], sourcePath, signal);
      await git(env, ['reset', '--hard', checkoutRef], sourcePath, signal);
    }
    if (!(await exists(gitDir))) {
      if (await exists(sourcePath)) {
        const info = await stat(sourcePath);
        if (!info.isDirectory()) throw Object.assign(new Error('gitFailed'), { code: 'gitFailed' });
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
    const commit = await git(env, ['rev-parse', 'HEAD'], sourcePath, signal);
    const result: SourcePreparationResult = {
      status: 'ready',
      path: sourcePath,
      target: resolvedTarget,
      commit,
    };
    await persistSourceStatus(root, {
      status: 'ready',
      path: sourcePath,
      channel: resolvedTarget.channel,
      version: resolvedTarget.version,
      ref: resolvedTarget.ref,
      commit,
    });
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
