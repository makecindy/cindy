// Shared test-only RPC harness: lifecycle tests use Node fixtures; integration tests use Pi.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const SAFE_ENV_KEYS = [
  'PATH',
  'Path',
  'SystemRoot',
  'SYSTEMROOT',
  'ComSpec',
  'COMSPEC',
  'PATHEXT',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
] as const;

const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_RPC_TIMEOUT_MS = 5_000;
const DEFAULT_EXIT_TIMEOUT_MS = 1_000;
const MAX_STDERR_CHARS = 2_000;

type FailureCode =
  | 'binary_unavailable'
  | 'cleanup_timeout'
  | 'invalid_response'
  | 'process_exited'
  | 'rpc_timeout'
  | 'startup_timeout';

class PiRpcHarnessError extends Error {
  constructor(
    readonly code: FailureCode,
    message: string,
    readonly details: { stderr: string; exitCode?: number | null; signal?: NodeJS.Signals | null },
  ) {
    super(`[${code}] ${message}`);
    this.name = 'PiRpcHarnessError';
  }
}

export interface PiCommand {
  name?: unknown;
  description?: unknown;
  source?: unknown;
  sourceInfo?: {
    baseDir?: unknown;
    scope?: unknown;
    source?: unknown;
    path?: unknown;
  };
}

interface RunOptions {
  binaryPath: string;
  binaryPrefixArgs?: string[];
  cwd: string;
  configHome: string;
  sessionDir: string;
  approve: boolean;
  /** Additional CLI resource gates/explicit paths under test. */
  extraArgs?: string[];
  /** The hard-gate probe disables offline mode so it cannot mask install attempts. */
  offline?: boolean;
  extraEnv?: NodeJS.ProcessEnv;
  beforeRpcRequest?: () => Promise<void>;
  spawnProcess?: typeof spawn;
  startupTimeoutMs?: number;
  rpcTimeoutMs?: number;
  exitTimeoutMs?: number;
}

interface RunResult {
  commands: PiCommand[];
  stderr: string;
}

function createSafeEnv(
  root: string,
  configHome: string,
  options: Pick<RunOptions, 'offline' | 'extraEnv'> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }

  const home = path.join(root, 'home');
  const xdg = path.join(root, 'xdg-config');
  mkdirSync(home, { recursive: true });
  mkdirSync(xdg, { recursive: true });
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = xdg;
  env.PI_CODING_AGENT_DIR = configHome;
  if (options.offline !== false) env.PI_OFFLINE = '1';
  env.PI_TELEMETRY = '0';
  env.NO_COLOR = '1';
  return { ...env, ...options.extraEnv };
}

function piArgs(options: Pick<RunOptions, 'sessionDir' | 'approve' | 'extraArgs'>): string[] {
  return [
    '--mode', 'rpc',
    '--provider', 'dummy',
    '--model', 'dummy-model',
    '--session-dir', options.sessionDir,
    '--no-context-files',
    options.approve ? '--approve' : '--no-approve',
    ...(options.extraArgs ?? []),
  ];
}

function appendStderr(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length <= MAX_STDERR_CHARS ? next : next.slice(-MAX_STDERR_CHARS);
}

function waitForClose(
  closePromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(closed);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    void closePromise.then(() => finish(true));
  });
}

async function terminateProcess(
  child: ChildProcess,
  closePromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  timeoutMs: number,
  stderr: string,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill('SIGTERM'); } catch { /* the close event remains authoritative */ }
  if (await waitForClose(closePromise, timeoutMs)) return;

  try { child.kill('SIGKILL'); } catch { /* the close event remains authoritative */ }
  if (await waitForClose(closePromise, timeoutMs)) return;

  throw new PiRpcHarnessError(
    'cleanup_timeout',
    `Pi process did not exit after SIGTERM and SIGKILL (${timeoutMs}ms each)`,
    { stderr, exitCode: child.exitCode, signal: child.signalCode },
  );
}

export async function runGetCommands(options: RunOptions): Promise<RunResult> {
  let child: ChildProcess | undefined;
  let stderr = '';
  let pendingError: PiRpcHarnessError | undefined;
  let result: RunResult | undefined;
  let operationError: unknown;
  let operationFailed = false;
  let cleanupError: unknown;
  let closeResolve!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    closeResolve = resolve;
  });

  try {
    child = (options.spawnProcess ?? spawn)(
      options.binaryPath,
      [...(options.binaryPrefixArgs ?? []), ...piArgs(options)],
      {
        cwd: options.cwd,
        env: createSafeEnv(path.dirname(options.configHome), options.configHome, options),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    child.stderr?.on('data', (chunk) => { stderr = appendStderr(stderr, chunk); });
    child.on('close', (code, signal) => closeResolve({ code, signal }));

    result = await new Promise<RunResult>((resolve, reject) => {
      const decoder = new StringDecoder('utf8');
      let stdout = '';
      let settled = false;
      const startupTimer = setTimeout(() => {
        fail(new PiRpcHarnessError('startup_timeout', `Pi did not spawn within ${options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS}ms`, { stderr }));
      }, options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
      let rpcTimer: NodeJS.Timeout | undefined;

      const cleanup = () => {
        if (startupTimer) clearTimeout(startupTimer);
        if (rpcTimer) clearTimeout(rpcTimer);
        child?.stdout?.removeListener('data', onStdout);
        child?.removeListener('error', onError);
        child?.removeListener('close', onClose);
      };
      const fail = (error: PiRpcHarnessError) => {
        if (settled) return;
        settled = true;
        pendingError = error;
        cleanup();
        reject(error);
      };
      const succeed = (commands: PiCommand[]) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ commands, stderr });
      };
      const onError = (error: NodeJS.ErrnoException) => {
        fail(new PiRpcHarnessError(
          error.code === 'ENOENT' ? 'binary_unavailable' : 'process_exited',
          error.code === 'ENOENT' ? `Pi binary unavailable: ${options.binaryPath}` : `Pi spawn failed: ${error.message}`,
          { stderr },
        ));
      };
      const onStdinError = (error: NodeJS.ErrnoException) => {
        fail(new PiRpcHarnessError(
          'process_exited',
          `Pi RPC stdin failed: ${error.message}`,
          { stderr, exitCode: child?.exitCode, signal: child?.signalCode },
        ));
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
        if (!settled) {
          fail(new PiRpcHarnessError(
            'process_exited',
            `Pi exited before get_commands response (code=${code}, signal=${signal})`,
            { stderr, exitCode: code, signal },
          ));
        }
      };
      const onStdout = (chunk: Buffer | string) => {
        stdout += typeof chunk === 'string' ? chunk : decoder.write(chunk);
        while (true) {
          const newline = stdout.indexOf('\n');
          if (newline === -1) break;
          let line = stdout.slice(0, newline);
          stdout = stdout.slice(newline + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (!line.trim()) continue;
          let frame: unknown;
          try {
            frame = JSON.parse(line);
          } catch {
            fail(new PiRpcHarnessError('invalid_response', `Pi returned non-JSON stdout: ${line.slice(0, 200)}`, { stderr }));
            return;
          }
          if (!frame || typeof frame !== 'object') continue;
          const response = frame as { id?: unknown; type?: unknown; success?: unknown; data?: unknown; error?: unknown };
          if (response.type !== 'response' || response.id !== 'fixture-get-commands') continue;
          if (response.success !== true) {
            fail(new PiRpcHarnessError('invalid_response', `get_commands failed: ${String(response.error ?? 'unknown')}`, { stderr }));
            return;
          }
          const data = response.data as { commands?: unknown } | undefined;
          if (!Array.isArray(data?.commands)) {
            fail(new PiRpcHarnessError('invalid_response', 'get_commands response has no commands array', { stderr }));
            return;
          }
          succeed(data.commands as PiCommand[]);
          return;
        }
      };

      child!.once('error', onError);
      child!.once('close', onClose);
      child!.stdin?.on('error', onStdinError);
      child!.stdout?.on('data', onStdout);
      child!.once('spawn', () => {
        void (async () => {
          if (settled) return;
          clearTimeout(startupTimer);
          try {
            await options.beforeRpcRequest?.();
            if (settled) return;
            child!.stdin?.write(JSON.stringify({ type: 'get_commands', id: 'fixture-get-commands' }) + '\n');
          } catch (error) {
            fail(new PiRpcHarnessError('process_exited', `Pi RPC setup/write failed: ${String(error)}`, { stderr }));
            return;
          }
          rpcTimer = setTimeout(() => {
            fail(new PiRpcHarnessError('rpc_timeout', `get_commands timed out after ${options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS}ms`, { stderr }));
          }, options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS);
        })();
      });
    });
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  if (child) {
    try {
      await terminateProcess(
        child,
        closePromise,
        options.exitTimeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS,
        stderr,
      );
    } catch (error) {
      cleanupError = error;
    }
  }
  if (pendingError) {
    pendingError.details.stderr = stderr;
  }
  if (cleanupError) {
    throw cleanupError;
  }
  if (operationFailed) {
    throw operationError;
  }
  if (!result) throw new Error('Pi RPC harness completed without a result');
  return result;
}
