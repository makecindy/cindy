import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { defaultPtySpawn, type PtySpawnFn } from '../terminal/ptyFactory.js';
import { snapshotContent } from './sourceContent.js';
import { runSourceGit } from './sourceGit.js';
import {
  CINDY_MAKE_RUN_ID_PATTERN,
  makeSourceCheckoutPath,
  makeSourceRoot,
  makeTaskBranch,
  makeTaskWorktreePath,
  makeWorktreesRoot,
} from './sourcePaths.js';
import type { CindyMakeTestState, CindyMakeTestStep } from '../../shared/cindyMakeSession.js';

export type MakeTestError = NonNullable<CindyMakeTestState['error']>;
export function makeTestError(code: MakeTestError): Error & { code: MakeTestError } {
  return Object.assign(new Error(code), { code });
}

const OS_ENV_KEYS = new Set([
  'path',
  'home',
  'userprofile',
  'appdata',
  'localappdata',
  'temp',
  'tmp',
  'tmpdir',
  'systemroot',
  'windir',
  'comspec',
  'pathext',
  'programfiles',
  'programfiles(x86)',
  'programdata',
  'allusersprofile',
  'username',
  'user',
  'logname',
  'shell',
  'lang',
  'lc_all',
  'lc_ctype',
  // The child must reconnect to the user's desktop session on X11 and Wayland.
  // Keep this explicit: XDT overrides, credentials and loader hooks stay excluded.
  'display',
  'wayland_display',
  'xauthority',
  'xdg_runtime_dir',
  'xdg_session_type',
  'xdg_current_desktop',
  'xdg_session_desktop',
  'desktop_session',
  'dbus_session_bus_address',
  'pnpm_home',
  'corepack_home',
  'node_extra_ca_certs',
  'ssl_cert_file',
  'ssl_cert_dir',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'python',
  'npm_config_python',
  'pythonutf8',
  'pythondontwritebytecode',
  'corepack_enable_network',
  'corepack_enable_auto_pin',
  'corepack_enable_download_prompt',
  'npm_config_manage_package_manager_versions',
  'npm_config_managepackagemanagerversions',
  'pnpm_manage_package_manager_versions',
]);

/** Do not inherit the host's profile, harness credentials, Node hooks or dev overrides. */
export function makeTestEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (key.toLowerCase() !== 'path' && value !== undefined && OS_ENV_KEYS.has(key.toLowerCase()))
      env[key] = value;
  }
  env.PATH = (environment.PATH ?? environment.Path ?? '')
    .split(path.delimiter)
    .filter((directory) => path.isAbsolute(directory))
    .join(path.delimiter);
  env.TERM = 'xterm-256color';
  env.FORCE_COLOR = '0';
  return env;
}

export interface MakeTestWorkspace {
  userData: string;
  workingDir: string;
  runId: string;
  commit: string;
  tree?: string;
}

export async function verifyMakeTestWorkspace(
  task: MakeTestWorkspace,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<void> {
  const samePath = (a: string, b: string) =>
    process.platform === 'win32'
      ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
      : path.resolve(a) === path.resolve(b);
  if (
    !CINDY_MAKE_RUN_ID_PATTERN.test(task.runId) ||
    !samePath(task.workingDir, makeTaskWorktreePath(task.userData, task.runId))
  )
    throw makeTestError('unavailable');
  const profile = await realpath(task.userData);
  for (const directory of [
    makeSourceRoot(task.userData),
    makeSourceCheckoutPath(task.userData),
    path.join(makeSourceCheckoutPath(task.userData), '.git'),
    makeWorktreesRoot(task.userData),
    task.workingDir,
  ]) {
    signal.throwIfAborted();
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      !samePath(
        await realpath(directory),
        path.join(profile, path.relative(task.userData, directory)),
      )
    )
      throw makeTestError('unavailable');
  }
  const git = (args: string[], cwd = task.workingDir, indexFile?: string) =>
    runSourceGit(
      { ...env, ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}) },
      args,
      cwd,
      signal,
    );
  const common = (await git(['rev-parse', '--git-common-dir'])).trim();
  if (
    !samePath(
      await realpath(path.resolve(task.workingDir, common)),
      await realpath(path.join(makeSourceCheckoutPath(task.userData), '.git')),
    )
  )
    throw makeTestError('unavailable');
  if ((await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim() !== makeTaskBranch(task.runId))
    throw makeTestError('unavailable');
  if (
    (await git(['rev-parse', 'HEAD'])).trim() !== task.commit ||
    (task.tree
      ? (await snapshotContent(git, task.workingDir)) !== task.tree
      : (await git(['status', '--porcelain', '--untracked-files=all'])).trim())
  )
    throw makeTestError('changed');
  for (const file of ['.git', path.join('scripts', 'desktop-restart-runner.mjs')]) {
    const fullPath = path.join(task.workingDir, file);
    const info = await lstat(fullPath);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      !samePath(
        await realpath(fullPath),
        path.join(profile, path.relative(task.userData, fullPath)),
      )
    )
      throw makeTestError('unavailable');
  }
  signal.throwIfAborted();
}

export interface MakeTestProcess {
  ready: Promise<void>;
  closed: Promise<void>;
  stop(): void;
}

// Only fixed protocol codes enter diagnostics. Raw compiler output, paths,
// environment values and the wrapper's free-form message are never logged.
const WRAPPER_FAILURE_CODES = new Set([
  'DEV_PROCESS_EXITED',
  'STARTUP_TIMEOUT',
  'STARTUP_FAILED',
  'WHOAMI_MISMATCH',
  'MIGRATION_POLICY',
  'MIGRATE_FAILED',
  'AUTH_INIT_FAILED',
  'HOSTED_RESTART_REFUSED',
  'HOSTED_SHARED_REFUSED',
  'PRESERVE_RUNNING_INCOMPATIBLE',
  'USERDATA_IN_USE',
  'ISOLATED_OFFICIAL_PROFILE',
  'INVALID_ISOLATED_NAME',
]);
export interface MakeTestDiagnostic {
  event: 'spawn' | 'step' | 'ready' | 'failed' | 'exit';
  step?: CindyMakeTestStep;
  reason?: 'wrapperFailed' | 'earlyExit' | 'identityMismatch' | 'timeout';
  wrapperCode?: string;
  exitCode?: number;
  elapsedMs: number;
}

/** The existing restart pipeline keeps its TTY runner without opening a terminal window. */
export function launchMakeTest(
  task: MakeTestWorkspace,
  tools: { node: string; pnpm: string },
  environment: NodeJS.ProcessEnv,
  region: 'cn' | 'global',
  signal: AbortSignal,
  spawn: PtySpawnFn = defaultPtySpawn,
  onStep?: (step: CindyMakeTestStep) => void,
  onDiagnostic?: (diagnostic: MakeTestDiagnostic) => void,
): MakeTestProcess {
  signal.throwIfAborted();
  const startedAt = Date.now();
  const diagnostic = (value: Omit<MakeTestDiagnostic, 'elapsedMs'>) =>
    onDiagnostic?.({ ...value, elapsedMs: Date.now() - startedAt });
  const sandbox =
    'make-' +
    createHash('sha256')
      .update(task.userData + ':' + task.runId)
      .digest('hex')
      .slice(0, 20);
  const child = spawn(
    tools.node,
    [
      path.join(task.workingDir, 'scripts', 'desktop-restart-runner.mjs'),
      '--wait-ready',
      '--region=' + region,
      '--isolated=' + sandbox,
      '--passive',
    ],
    {
      cwd: task.workingDir,
      env: {
        ...makeTestEnvironment(environment),
        // Use the probed entry, not the host's npm_execpath. On Windows, the
        // restart runner's bare pnpm fallback can give .cmd shims the task cwd
        // as %~dp0, so they look for pnpm.cjs outside their installation.
        npm_execpath: tools.pnpm,
      },
      // Keep the machine-readable identity lines intact even with long profile paths.
      cols: 4096,
      rows: 30,
      name: 'xterm-256color',
    },
  );
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveClosed!: () => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let settled = false;
  let stopped = false;
  let stopping = false;
  let pending = '';
  let verdict: Record<string, string> | undefined;
  let lastStep: CindyMakeTestStep | undefined;
  let failedVerdict = false;
  let failureTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = setTimeout(() => fail('timeout', 'timeout'), 25 * 60_000);
  const finish = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timeout);
    clearTimeout(failureTimer);
    signal.removeEventListener('abort', abort);
    if (!settled) {
      settled = true;
      rejectReady(makeTestError('interrupted'));
    }
    resolveClosed();
  };
  const stop = () => {
    if (stopped || stopping) return;
    stopping = true;
    clearTimeout(timeout);
    clearTimeout(failureTimer);
    if (!settled) {
      settled = true;
      rejectReady(makeTestError('interrupted'));
    }
    try {
      child.kill();
    } catch {
      finish();
    }
  };
  const fail = (
    code: MakeTestError,
    reason: MakeTestDiagnostic['reason'],
    wrapperCode?: string,
  ) => {
    if (!settled) {
      diagnostic({ event: 'failed', reason, step: lastStep, wrapperCode });
      settled = true;
      rejectReady(makeTestError(code));
    }
    stop();
  };
  const abort = () => stop();
  signal.addEventListener('abort', abort, { once: true });
  child.onExit(({ exitCode }) => {
    diagnostic({ event: 'exit', exitCode, step: lastStep });
    if (!settled) {
      diagnostic({
        event: 'failed',
        reason: failedVerdict ? 'wrapperFailed' : 'earlyExit',
        step: lastStep,
      });
      settled = true;
      rejectReady(makeTestError('launchFailed'));
    }
    finish();
  });
  child.onData((data) => {
    // Only keep bounded protocol lines, never persist compiler output or environment contents.
    pending = (pending + data).slice(-32_768);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').trim();
      if (!settled && !stopping && !failedVerdict) {
        // Older checkouts have no step protocol. Read only fixed stage prefixes;
        // arbitrary terminal output is never forwarded or persisted.
        const step = /^DESKTOP_DEV_STEP=(stopping|dependencies|assets|launching)$/.exec(
          line,
        )?.[1] as CindyMakeTestStep | undefined;
        const next =
          step ??
          (line.startsWith('[ensure-deps]')
            ? 'dependencies'
            : line.startsWith('[ensure-dev-runtime-assets]')
              ? 'assets'
              : line === '==> Starting desktop remote dev...' ||
                  line === '==> Starting desktop local dev...'
                ? 'launching'
                : undefined);
        if (next && next !== lastStep) {
          lastStep = next;
          diagnostic({ event: 'step', step: next });
          onStep?.(next);
        }
      }
      if (line === 'DESKTOP_DEV_VERDICT=failed' && !settled && !failedVerdict) {
        failedVerdict = true;
        // The code follows the marker and can arrive in a later PTY chunk.
        // Bound this wait so malformed/older wrappers cannot hang the launch.
        failureTimer = setTimeout(() => fail('launchFailed', 'wrapperFailed'), 250);
        continue;
      }
      if (failedVerdict) {
        if (line.startsWith('code=')) {
          const code = line.slice(5);
          fail('launchFailed', 'wrapperFailed', WRAPPER_FAILURE_CODES.has(code) ? code : 'UNKNOWN');
          return;
        }
        continue;
      }
      if (line === 'DESKTOP_DEV_VERDICT=ready') {
        verdict = {};
        continue;
      }
      if (!verdict) continue;
      const match = /^(mode|sandbox|root|commit|pid|region)=(.*)$/.exec(line);
      if (match) verdict[match[1]] = match[2];
      if (!verdict.pid || !verdict.region || settled) continue;
      const root = path.resolve(verdict.root ?? '');
      const expected = path.resolve(task.workingDir);
      const sameRoot =
        process.platform === 'win32'
          ? root.toLowerCase() === expected.toLowerCase()
          : root === expected;
      if (
        !sameRoot ||
        verdict.commit !== task.commit ||
        verdict.mode !== 'isolated' ||
        verdict.sandbox !== sandbox ||
        verdict.region !== region ||
        !/^[1-9][0-9]*$/.test(verdict.pid)
      ) {
        fail('launchFailed', 'identityMismatch');
        return;
      }
      settled = true;
      clearTimeout(timeout);
      diagnostic({ event: 'ready' });
      resolveReady();
    }
  });
  diagnostic({ event: 'spawn' });
  if (signal.aborted) stop();
  return { ready, closed, stop };
}
