/**
 * Where the Open Artifact runtime comes from, and how its daemon starts.
 *
 * Order (design §3): a daemon already running for the home is used as it is, whatever its version (a real Node or
 * another app started it, not Cindy). Otherwise Cindy starts one, always the same way in dev and packaged builds:
 * through the kit's `daemon.spawn` hook in an Electron utility process (openArtifact.desktop.ts), where the daemon
 * runs its type servers in worker threads. Only runtimes from {@link OPEN_ARTIFACT_CLI_VERSION} on can do that (an
 * older one would try to start the Electron helper as Node and hang), so the computer's best runtime is used only
 * when it is at least that version; otherwise Cindy's own copy of the pinned `@open-artifact/cli` tarball, downloaded
 * through the verified downloader and unpacked with managed-tools, is handed to the kit (`update: 'bundled'`).
 */
import path from 'node:path';
import {
  compareVersions,
  daemonStartPlan,
  ensureDaemon,
  openArtifactHome,
  readDaemon,
  readRuntimesFile,
  runtimeInfo,
  type DaemonExitSource,
  type DaemonStart,
} from '@open-artifact/harness-kit';
import type { DaemonState, HarnessRuntime } from '@open-artifact/protocol';
import { download, type DownloadOptions } from '../downloader/index.js';
import { installTool, installedTool } from '../managed-tools/installer.js';
import type { ToolArtifact } from '../managed-tools/types.js';
import { createLogger } from '../logger.js';

const log = createLogger('open-artifact');

/**
 * The runtime Cindy brings, and the oldest one it starts (see the file comment). Pinned by digest and size; bump all
 * four together.
 */
export const OPEN_ARTIFACT_CLI_VERSION = '0.14.1';
export const OPEN_ARTIFACT_CLI_ARTIFACT: ToolArtifact = {
  id: 'open-artifact-cli',
  version: OPEN_ARTIFACT_CLI_VERSION,
  host: 'any',
  url: `https://registry.npmjs.org/@open-artifact/cli/-/cli-${OPEN_ARTIFACT_CLI_VERSION}.tgz`,
  sha256: '6202a5fc2e30f1a7992633bb641ac42aaa26b2ccb1da00af474d9988b9d50103',
  format: 'tar.gz',
  executable: 'package/scripts/open-artifact.mjs',
};
export const OPEN_ARTIFACT_CLI_SIZE = 21_535_592;
const REGISTRY_HOST = 'registry.npmjs.org';

/**
 * The Open Artifact home Cindy uses. `CINDY_OPEN_ARTIFACT_HOME` (read only here) points a dev run at an isolated
 * home so it never touches the person's own daemon; unset, the kit's default applies (`$OPEN_ARTIFACT_HOME`, else
 * `~/.agents/open-artifact`), so Cindy shares the library with the person's other agent apps.
 */
export function cindyOpenArtifactHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CINDY_OPEN_ARTIFACT_HOME?.trim();
  return openArtifactHome(override || undefined);
}

/** A failure the agent can read and pass on: what is wrong and what the person can do. */
export class OpenArtifactUnavailableError extends Error {
  constructor(
    readonly code: 'runtime_download_failed' | 'daemon_start_failed',
    message: string,
  ) {
    super(message);
    this.name = 'OpenArtifactUnavailableError';
  }
}

export interface RuntimeDeps {
  /** Cindy's managed-tools root (`<userData>/managed-tools`, the same root as gh). */
  toolsRoot: string;
  home: string;
  signal?: AbortSignal;
  readDaemon?: typeof readDaemon;
  daemonStartPlan?: typeof daemonStartPlan;
  installedTool?: typeof installedTool;
  installTool?: typeof installTool;
  download?: (options: DownloadOptions) => Promise<unknown>;
  runtimeInfo?: typeof runtimeInfo;
}

/** What the harness is created with: the daemon that runs, or the entry Cindy starts it from. */
export type PreparedRuntime =
  | { source: 'running' }
  | { source: 'computer'; bin: string; version: string; env: NodeJS.ProcessEnv }
  | { source: 'cindy'; bin: string; runtime: HarnessRuntime };

const runtimeDirOf = (executable: string) => path.dirname(path.dirname(executable));

/** The verified download of the pinned tarball: registry host only, no redirects, exact size and digest. */
export function verifiedRuntimeDownload(
  fetchFile: (options: DownloadOptions) => Promise<unknown> = download,
): (options: DownloadOptions) => Promise<unknown> {
  return (options) => fetchFile({
    ...options,
    expectedSize: OPEN_ARTIFACT_CLI_SIZE,
    redirect: 'error',
    isUrlAllowed: (url) => {
      try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && parsed.hostname === REGISTRY_HOST;
      } catch {
        return false;
      }
    },
  });
}

/**
 * Decides which runtime backs the harness. Never starts a daemon (see {@link startDaemon}); it may download and
 * unpack the pinned runtime when the computer has none.
 */
export async function prepareRuntime(deps: RuntimeDeps): Promise<PreparedRuntime> {
  return (await localRuntime(deps)) ?? downloadRuntime(deps);
}

/** Cindy has connected to this home before: the daemon keeps each adapter's last `hello` in `runtimes.json`. */
export function usedHomeBefore(home: string, read: typeof readRuntimesFile = readRuntimesFile): boolean {
  try {
    return Boolean(read(home).adapters?.cindy);
  } catch {
    return false;
  }
}

const ownRuntime = (executable: string): PreparedRuntime => ({
  source: 'cindy',
  bin: executable,
  runtime: { dir: runtimeDirOf(executable), version: OPEN_ARTIFACT_CLI_VERSION, update: 'bundled' },
});

/** {@link prepareRuntime} without the download: `null` when no runtime that can start here is on disk. */
export async function localRuntime(deps: RuntimeDeps): Promise<PreparedRuntime | null> {
  const read = deps.readDaemon ?? readDaemon;
  if (await read(deps.home)) return { source: 'running' };
  // The kit ranks the computer's runtimes newest first; the best one is used only from the floor up.
  const best = (deps.daemonStartPlan ?? daemonStartPlan)({ home: deps.home }).tries[0];
  if (best?.version && compareVersions(best.version, OPEN_ARTIFACT_CLI_VERSION) >= 0) {
    return { source: 'computer', bin: best.bin, version: best.version, env: best.env };
  }
  if (best) log.info('Open Artifact runtime on this computer is too old to start here', { version: best.version ?? null });

  const info = deps.runtimeInfo ?? runtimeInfo;
  const existing = await (deps.installedTool ?? installedTool)(deps.toolsRoot, OPEN_ARTIFACT_CLI_ARTIFACT);
  if (existing && info(runtimeDirOf(existing))?.version === OPEN_ARTIFACT_CLI_VERSION) return ownRuntime(existing);
  return null;
}

async function downloadRuntime(deps: RuntimeDeps): Promise<PreparedRuntime> {
  const info = deps.runtimeInfo ?? runtimeInfo;
  log.info('Downloading the Open Artifact runtime', { version: OPEN_ARTIFACT_CLI_VERSION });
  let lastLogged = -1;
  try {
    const executable = await (deps.installTool ?? installTool)({
      root: deps.toolsRoot,
      artifact: OPEN_ARTIFACT_CLI_ARTIFACT,
      signal: deps.signal ?? new AbortController().signal,
      onProgress: (progress) => {
        // No new panel in C1: progress goes to the log only, in 25 % steps.
        const percent = progress.download.percent;
        const step = percent === null ? -1 : Math.floor(percent / 25);
        if (step > lastLogged) {
          lastLogged = step;
          log.info('Open Artifact runtime download', { status: progress.status, percent });
        }
      },
      validate: async (entry) => info(runtimeDirOf(entry))?.version === OPEN_ARTIFACT_CLI_VERSION,
    }, { download: verifiedRuntimeDownload(deps.download) });
    log.info('Open Artifact runtime installed', { version: OPEN_ARTIFACT_CLI_VERSION });
    return ownRuntime(executable);
  } catch (error) {
    log.warn('Open Artifact runtime download failed', { error: (error as Error).message });
    throw new OpenArtifactUnavailableError(
      'runtime_download_failed',
      `Cindy could not download the Open Artifact runtime ${OPEN_ARTIFACT_CLI_VERSION} from ${REGISTRY_HOST} `
      + `(${(error as Error).message}). Check the network connection and try again.`,
    );
  }
}

/**
 * Starts the daemon for `home` from the chosen entry. The only place Cindy starts it.
 *
 * `spawn` is the kit's `daemon.spawn` hook (openArtifact.desktop.ts forks the entry in an Electron utility process),
 * the same in dev and packaged builds, whose RunAsNode fuse is off (forge.config.ts). `bin` names the one runtime to
 * start, so the kit never falls back to an older runtime that could not run there.
 */
export async function startDaemon(
  home: string,
  prepared: Exclude<PreparedRuntime, { source: 'running' }>,
  spawn: (start: DaemonStart) => DaemonExitSource | Promise<DaemonExitSource>,
  ensure: typeof ensureDaemon = ensureDaemon,
): Promise<DaemonState> {
  try {
    return await ensure({
      home,
      bin: prepared.bin,
      version: prepared.source === 'cindy' ? prepared.runtime.version : prepared.version,
      ...(prepared.source === 'computer' ? { env: prepared.env } : {}),
      spawn,
    });
  } catch (error) {
    log.warn('Open Artifact daemon did not start', { error: (error as Error).message });
    throw new OpenArtifactUnavailableError(
      'daemon_start_failed',
      `The Open Artifact daemon did not start (${(error as Error).message}). `
      + `Its log is in ${path.join(home, 'logs', 'daemon.out')}.`,
    );
  }
}

/** A daemon process Cindy started: its end, and a graceful stop (`SIGTERM` on macOS and Linux). */
export interface StartedDaemon extends DaemonExitSource {
  kill(): unknown;
}

/** How Cindy starts the daemon process (openArtifact.desktop.ts forks it in a utility process). */
export type CindyDaemonSpawn = (start: DaemonStart) => StartedDaemon | Promise<StartedDaemon>;

/** How long quit waits for the daemon to finish its own stop: well inside the app's async quit budget. */
export const DAEMON_STOP_WAIT_MS = 3000;

/**
 * Asks a daemon Cindy started to stop and waits for its exit, at most `timeoutMs`. On `SIGTERM` the daemon stops its
 * type servers (worker threads) and removes `daemon.json` and its lock. Never throws.
 */
export function stopStartedDaemon(child: StartedDaemon, timeoutMs = DAEMON_STOP_WAIT_MS): Promise<'exited' | 'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref?.();
    child.once('exit', () => {
      clearTimeout(timer);
      resolve('exited');
    });
    try {
      child.kill();
    } catch (error) {
      log.warn('Open Artifact daemon stop failed', { error: (error as Error).message });
      clearTimeout(timer);
      resolve('exited');
    }
  });
}
