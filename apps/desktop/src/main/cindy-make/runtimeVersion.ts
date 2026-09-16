import { execFile } from 'node:child_process';
import type { MakeRuntimeVersion, MakeUpstreamInclusion } from '../../shared/cindyMakeDoctor';

export interface RuntimeSourceBuild {
  commit?: string;
  dirty?: boolean;
  root?: string;
}

const loadedBuild: RuntimeSourceBuild = import.meta.env.CINDY_RUNTIME_SOURCE ?? {};
const validCommit = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

export type RuntimeGit = (
  root: string,
  args: string[],
  signal: AbortSignal,
) => Promise<{ code: number; stdout: string }>;

const runtimeGit: RuntimeGit = (root, args, signal) =>
  new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd: root,
        signal,
        encoding: 'utf8',
        timeout: 3000,
        maxBuffer: 256 * 1024,
        windowsHide: true,
      },
      (error, stdout) =>
        resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout }),
    );
  });

export async function resolveMakeRuntime(
  input: { packaged: boolean; version: string },
  signal: AbortSignal,
  build: RuntimeSourceBuild = loadedBuild,
  git: RuntimeGit = runtimeGit,
) {
  const runtime: MakeRuntimeVersion = {
    channel: !input.packaged ? 'dev' : /-beta(?:\.|$)/i.test(input.version) ? 'beta' : 'release',
    version: input.version,
    ...(validCommit(build.commit) ? { commit: build.commit } : {}),
    confidence: validCommit(build.commit) && build.dirty === false ? 'exact' : 'unknown',
  };
  const isCurrent = async () => {
    if (runtime.confidence !== 'exact' || signal.aborted) return false;
    if (input.packaged) return true;
    if (!build.root) return false;
    try {
      const head = await git(build.root, ['rev-parse', 'HEAD'], signal);
      const status = await git(
        build.root,
        ['status', '--porcelain=v1', '-z', '--untracked-files=normal'],
        signal,
      );
      const unchanged =
        head.code === 0 &&
        head.stdout.trim() === build.commit &&
        status.code === 0 &&
        !status.stdout;
      if (!unchanged) runtime.confidence = 'unknown';
      return unchanged;
    } catch {
      return false;
    }
  };
  if (!(await isCurrent())) runtime.confidence = 'unknown';
  const containsCommit = async (
    commit: string,
    compareSignal = signal,
  ): Promise<MakeUpstreamInclusion> => {
    if (!validCommit(commit) || !(await isCurrent())) return 'unknown';
    if (commit === runtime.commit) return 'included';
    if (input.packaged || !build.root) return 'unknown';
    try {
      const included = await git(
        build.root,
        ['merge-base', '--is-ancestor', commit, runtime.commit!],
        compareSignal,
      );
      if (included.code === 0) {
        const reverts = await git(
          build.root,
          [
            'log',
            '--format=%B',
            `${commit}..${runtime.commit}`,
            `--grep=${commit}`,
            '--fixed-strings',
          ],
          compareSignal,
        );
        return reverts.code === 0 && !/revert/i.test(reverts.stdout) ? 'included' : 'unknown';
      }
      if (included.code !== 1) return 'unknown';
      const later = await git(
        build.root,
        ['merge-base', '--is-ancestor', runtime.commit!, commit],
        compareSignal,
      );
      return later.code === 0 ? 'notIncluded' : 'unknown';
    } catch {
      return 'unknown';
    }
  };
  return { runtime, isCurrent, containsCommit };
}
