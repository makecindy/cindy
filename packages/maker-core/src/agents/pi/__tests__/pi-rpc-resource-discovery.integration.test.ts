/**
 * Pi RPC 资源发现事实夹具（#2009）。
 *
 * 这组测试故意绕过 PiAgent 的生产启动装配：它只验证仓库 pin 的 Pi
 * `--mode rpc` 在隔离 `PI_CODING_AGENT_DIR` 下实际返回什么。不要把这里的
 * `--approve` 当作生产策略；它只是与 `--no-approve` 组成可重复的 trust 观测对照。
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { scanPiCustomizations } from '../customization-scanner.js';
import { capturePiRuntimeCapabilityManifest } from '../runtime-capabilities.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const PLATFORM_KEY = `${process.platform}-${process.arch}`;
const PI_BINARY = path.join(
  REPO_ROOT,
  'apps',
  'pi-bin',
  PLATFORM_KEY,
  process.platform === 'win32' ? 'pi.exe' : 'pi',
);

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

interface PiCommand {
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

interface NormalizedSkill {
  name: string;
  description: string;
  source: string;
  scope: string;
  baseDir: string;
}

interface Fixture {
  root: string;
  configHome: string;
  repoRoot: string;
  workingDir: string;
  sessionDir: string;
  normalizedRoots: Array<{ root: string; label: string }>;
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

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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

function writeSkill(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: fixture ${name}\n---\nfixture ${name}\n`,
  );
}

function writeDummyModels(configHome: string): void {
  mkdirSync(configHome, { recursive: true });
  writeFileSync(
    path.join(configHome, 'models.json'),
    JSON.stringify({
      providers: {
        dummy: {
          name: 'Dummy',
          baseUrl: 'http://127.0.0.1:9',
          api: 'anthropic-messages',
          apiKey: 'dummy',
          models: [{
            id: 'dummy-model',
            name: 'Dummy Model',
            reasoning: false,
            input: ['text'],
            contextWindow: 100_000,
            maxTokens: 4_096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          }],
        },
      },
    }, null, 2) + '\n',
  );
}

function canonicalPath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function expectedExplicitProjectSkillScope(fixture: Fixture): 'project' | 'temporary' {
  if (process.platform === 'win32') return 'project';
  // Pi v0.83.0 reports `project` on macOS when the lexical git root is already
  // canonical. The default /var -> /private/var temp-dir alias instead yields
  // `temporary`, so keep the fixture deterministic under either TMPDIR form.
  if (
    process.platform === 'darwin'
    && path.resolve(fixture.repoRoot) === canonicalPath(fixture.repoRoot)
  ) {
    return 'project';
  }
  return 'temporary';
}

async function createFixture(prefix = 'pi-rpc-fixture-'): Promise<Fixture> {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  fixtureRoots.push(root);
  const configHome = path.join(root, 'config-home');
  const repoRoot = path.join(root, 'repo');
  const workingDir = path.join(repoRoot, 'project');
  const sessionDir = path.join(root, 'sessions');

  mkdirSync(workingDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  // Pi uses the nearest git root to bound ancestor .agents/skills discovery.
  try {
    execFileSync('git', ['init', '--quiet', repoRoot]);
  } catch {
    // Lifecycle-only cases still need a bounded repo marker in minimal images.
    mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
  }
  writeDummyModels(configHome);

  writeSkill(path.join(configHome, 'skills', 'global-skill'), 'global-skill');
  writeSkill(path.join(workingDir, '.pi', 'skills', 'project-pi-skill'), 'project-pi-skill');
  writeSkill(path.join(workingDir, '.agents', 'skills', 'project-agents-skill'), 'project-agents-skill');
  writeSkill(path.join(repoRoot, '.agents', 'skills', 'ancestor-agents-skill'), 'ancestor-agents-skill');
  // This is the historical scanner path. It must stay a negative control for Pi RPC.
  writeSkill(path.join(workingDir, '.pi', 'agent', 'skills', 'wrong-pi-agent-skill'), 'wrong-pi-agent-skill');

  return {
    root,
    configHome,
    repoRoot,
    workingDir,
    sessionDir,
    normalizedRoots: [
      { root: configHome, label: '<configHome>' },
      { root: path.join(workingDir, '.pi'), label: '<projectPi>' },
      { root: path.join(workingDir, '.agents'), label: '<projectAgents>' },
      { root: path.join(repoRoot, '.agents'), label: '<ancestorAgents>' },
    ],
  };
}

function normalizeBaseDir(value: unknown, roots: Array<{ root: string; label: string }>): string {
  if (typeof value !== 'string' || value.trim().length === 0) return '<missing>';
  const actual = canonicalPath(value);
  for (const { root, label } of roots) {
    const expected = canonicalPath(root);
    if (actual === expected || actual.startsWith(`${expected}${path.sep}`)) return label;
  }
  return '<outside-fixture>';
}

function normalizeSkills(commands: PiCommand[], fixture: Fixture): NormalizedSkill[] {
  return commands
    .filter((command) => command.source === 'skill')
    .map((command) => ({
      name: typeof command.name === 'string' ? command.name : '<missing>',
      description: typeof command.description === 'string' ? command.description : '<missing>',
      source: typeof command.sourceInfo?.source === 'string' ? command.sourceInfo.source : '<missing>',
      scope: typeof command.sourceInfo?.scope === 'string' ? command.sourceInfo.scope : '<missing>',
      baseDir: normalizeBaseDir(command.sourceInfo?.baseDir, fixture.normalizedRoots),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
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

async function runGetCommands(options: RunOptions): Promise<RunResult> {
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

function createFakeNodeScript(root: string, name: string, source: string): string {
  const file = path.join(root, `${name}.mjs`);
  writeFileSync(file, source);
  chmodSync(file, 0o755);
  return file;
}

async function waitForFile(file: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`fixture readiness timed out: ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('Pi RPC resource-discovery harness lifecycle', () => {
  it('reports a missing binary and still lets the fixture clean up', async () => {
    const fixture = await createFixture('pi-rpc-missing-');
    const missing = path.join(fixture.root, 'missing-pi');
    await expect(runGetCommands({
      binaryPath: missing,
      cwd: fixture.workingDir,
      configHome: fixture.configHome,
      sessionDir: fixture.sessionDir,
      approve: false,
    })).rejects.toMatchObject({ code: 'binary_unavailable' });
    expect(existsSync(fixture.configHome)).toBe(true);
    rmSync(fixture.root, { recursive: true, force: true });
    expect(existsSync(fixture.root)).toBe(false);
  });

  it('kills a silent process after the RPC timeout', async () => {
    const fixture = await createFixture('pi-rpc-timeout-');
    const silent = createFakeNodeScript(fixture.root, 'silent-pi', 'setInterval(() => {}, 60_000);\n');
    await expect(runGetCommands({
      binaryPath: process.execPath,
      binaryPrefixArgs: [silent],
      cwd: fixture.workingDir,
      configHome: fixture.configHome,
      sessionDir: fixture.sessionDir,
      approve: false,
      rpcTimeoutMs: 200,
      exitTimeoutMs: 500,
    })).rejects.toMatchObject({ code: 'rpc_timeout' });
  });

  it('reports a startup timeout separately from an RPC timeout', async () => {
    const fixture = await createFixture('pi-rpc-startup-timeout-');
    const neverSpawns = (() => {
      const fakeChild = new EventEmitter() as ChildProcess;
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(fakeChild, {
        stdin,
        stdout,
        stderr,
        exitCode: null,
        signalCode: null,
        kill: () => {
          queueMicrotask(() => fakeChild.emit('close', null, 'SIGTERM'));
          return true;
        },
      });
      return fakeChild;
    }) as typeof spawn;
    await expect(runGetCommands({
      binaryPath: 'fixture-pi',
      cwd: fixture.workingDir,
      configHome: fixture.configHome,
      sessionDir: fixture.sessionDir,
      approve: false,
      spawnProcess: neverSpawns,
      startupTimeoutMs: 10,
      rpcTimeoutMs: 5_000,
      exitTimeoutMs: 50,
    })).rejects.toMatchObject({ code: 'startup_timeout' });
  });

  it.skipIf(process.platform === 'win32')('escalates to SIGKILL when a timed-out process ignores SIGTERM', async () => {
    const fixture = await createFixture('pi-rpc-kill-');
    const marker = path.join(fixture.root, 'process-lifecycle.txt');
    const stubborn = createFakeNodeScript(
      fixture.root,
      'stubborn-pi',
      [
        "import { appendFileSync } from 'node:fs';",
        `const marker = ${JSON.stringify(marker)};`,
        "process.on('SIGTERM', () => appendFileSync(marker, 'sigterm\\n'));",
        "appendFileSync(marker, `started:${process.pid}\\n`);",
        'setInterval(() => {}, 60_000);',
      ].join('\n'),
    );

    await expect(runGetCommands({
      binaryPath: process.execPath,
      binaryPrefixArgs: [stubborn],
      cwd: fixture.workingDir,
      configHome: fixture.configHome,
      sessionDir: fixture.sessionDir,
      approve: false,
      beforeRpcRequest: () => waitForFile(marker),
      rpcTimeoutMs: 200,
      exitTimeoutMs: 500,
    })).rejects.toMatchObject({ code: 'rpc_timeout' });

    const lifecycle = readFileSync(marker, 'utf8').trim().split('\n');
    expect(lifecycle).toHaveLength(2);
    expect(lifecycle[1]).toBe('sigterm');
    const pid = Number(lifecycle[0]?.slice('started:'.length));
    let processLookupError: NodeJS.ErrnoException | undefined;
    try {
      process.kill(pid, 0);
    } catch (error) {
      processLookupError = error as NodeJS.ErrnoException;
    }
    expect(processLookupError?.code).toBe('ESRCH');
  });

  it('reports a process that exits before responding', async () => {
    const fixture = await createFixture('pi-rpc-exit-');
    const exiting = createFakeNodeScript(fixture.root, 'exit-pi', 'process.exit(17);\n');
    await expect(runGetCommands({
      binaryPath: process.execPath,
      binaryPrefixArgs: [exiting],
      cwd: fixture.workingDir,
      configHome: fixture.configHome,
      sessionDir: fixture.sessionDir,
      approve: false,
    })).rejects.toMatchObject({ code: 'process_exited', details: { exitCode: 17 } });
  });

  it('rejects malformed RPC stdout and captures bounded stderr', async () => {
    const fixture = await createFixture('pi-rpc-invalid-');
    const invalid = createFakeNodeScript(
      fixture.root,
      'invalid-pi',
      "process.stderr.write('fixture stderr\\n'); process.stdout.write('not-json\\n'); setInterval(() => {}, 60_000);\n",
    );
    await expect(runGetCommands({
      binaryPath: process.execPath,
      binaryPrefixArgs: [invalid],
      cwd: fixture.workingDir,
      configHome: fixture.configHome,
      sessionDir: fixture.sessionDir,
      approve: false,
      exitTimeoutMs: 500,
    })).rejects.toMatchObject({ code: 'invalid_response', details: { stderr: 'fixture stderr\n' } });
  });
});

describe.skipIf(!existsSync(PI_BINARY))('Pi v0.83.0 RPC resource discovery facts', () => {
  it('records isolated global skills and omits unapproved project resources', async () => {
    const fixture = await createFixture('pi-rpc-no-trust-');
    const result = await runGetCommands({
      binaryPath: PI_BINARY,
      cwd: fixture.workingDir,
      configHome: fixture.configHome,
      sessionDir: fixture.sessionDir,
      approve: false,
    });
    const skills = normalizeSkills(result.commands, fixture);

    const manifest = await capturePiRuntimeCapabilityManifest(
      { request: async () => ({ type: 'response', command: 'get_commands', success: true, data: { commands: result.commands } }) },
      {},
      1,
      'ready',
    );
    expect(manifest.status).toBe('loaded');
    expect(manifest.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'skill:global-skill',
        description: 'fixture global-skill',
        source: 'skill',
        sourceInfo: expect.objectContaining({
          source: 'auto',
          scope: 'user',
          baseDir: fixture.configHome,
        }),
      }),
    ]));

    expect(skills).toEqual([{
      name: 'skill:global-skill',
      description: 'fixture global-skill',
      source: 'auto',
      scope: 'user',
      baseDir: '<configHome>',
    }]);
  });

  it('loads a shared global skill from the user .agents root without project approval', async () => {
    const fixture = await createFixture('pi-rpc-shared-global-');
    const sharedSkill = path.join(
      fixture.root,
      'home',
      '.agents',
      'skills',
      'shared-global-skill',
    );
    writeSkill(sharedSkill, 'shared-global-skill');

    const result = await runGetCommands({
      binaryPath: PI_BINARY,
      cwd: fixture.workingDir,
      configHome: fixture.configHome,
      sessionDir: fixture.sessionDir,
      approve: false,
    });

    expect(result.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'skill:shared-global-skill',
        source: 'skill',
        sourceInfo: expect.objectContaining({
          scope: 'user',
          path: path.join(sharedSkill, 'SKILL.md'),
        }),
      }),
    ]));
  });

  it('scanner superset differs from unapproved runtime only by project trust', async () => {
    const fixture = await createFixture('pi-rpc-scanner-trust-gap-');
    const result = await runGetCommands({
      binaryPath: PI_BINARY,
      cwd: fixture.workingDir,
      configHome: fixture.configHome,
      sessionDir: fixture.sessionDir,
      approve: false,
    });
    const loadedNames = new Set(
      normalizeSkills(result.commands, fixture)
        .filter((skill) => skill.scope === 'project')
        .map((skill) => skill.name),
    );
    const scanned = await scanPiCustomizations({ workingDirs: [fixture.workingDir] });
    const discovered = scanned.items.filter((item) => item.scope === 'repo');
    const discoveredNames = new Set(discovered.map((item) => `skill:${item.name}`));

    expect([...loadedNames].every((name) => discoveredNames.has(name))).toBe(true);
    expect([...discoveredNames].filter((name) => !loadedNames.has(name)).sort()).toEqual([
      'skill:ancestor-agents-skill',
      'skill:project-agents-skill',
      'skill:project-pi-skill',
    ]);
    expect(discovered.every((item) => item.runtimeStatus === 'discovered')).toBe(true);
  });

  it('records project .pi/skills and current/ancestor .agents/skills only with explicit trust', async () => {
    const fixture = await createFixture('pi-rpc-trust-');
    const result = await runGetCommands({
      binaryPath: PI_BINARY,
      cwd: fixture.workingDir,
      configHome: fixture.configHome,
      sessionDir: fixture.sessionDir,
      approve: true,
    });
    const skills = normalizeSkills(result.commands, fixture);
    const scanned = await scanPiCustomizations({ workingDirs: [fixture.workingDir] });
    const discoveredProjectNames = new Set(
      scanned.items
        .filter((item) => item.scope === 'repo')
        .map((item) => `skill:${item.name}`),
    );
    const loadedProjectNames = new Set(
      skills
        .filter((skill) => skill.scope === 'project')
        .map((skill) => skill.name),
    );
    const loadedProjectBaseDirs = new Map(
      result.commands.flatMap((command) => {
        const baseDir = command.sourceInfo?.baseDir;
        if (
          command.source !== 'skill'
          || command.sourceInfo?.scope !== 'project'
          || typeof baseDir !== 'string'
        ) {
          return [];
        }
        return [[command.name, canonicalPath(baseDir)] as const];
      }),
    );
    expect(discoveredProjectNames).toEqual(new Set([
      'skill:ancestor-agents-skill',
      'skill:project-agents-skill',
      'skill:project-pi-skill',
    ]));
    expect([...loadedProjectNames].every((name) => discoveredProjectNames.has(name))).toBe(true);
    expect([...discoveredProjectNames].filter((name) => !loadedProjectNames.has(name))).toEqual([]);
    expect(loadedProjectBaseDirs).toEqual(new Map([
      ['skill:ancestor-agents-skill', canonicalPath(path.join(fixture.repoRoot, '.agents'))],
      ['skill:project-agents-skill', canonicalPath(path.join(fixture.workingDir, '.agents'))],
      ['skill:project-pi-skill', canonicalPath(path.join(fixture.workingDir, '.pi'))],
    ]));

    expect(skills).toEqual([
      {
        name: 'skill:ancestor-agents-skill',
        description: 'fixture ancestor-agents-skill',
        source: 'auto',
        scope: 'project',
        baseDir: '<ancestorAgents>',
      },
      {
        name: 'skill:global-skill',
        description: 'fixture global-skill',
        source: 'auto',
        scope: 'user',
        baseDir: '<configHome>',
      },
      {
        name: 'skill:project-agents-skill',
        description: 'fixture project-agents-skill',
        source: 'auto',
        scope: 'project',
        baseDir: '<projectAgents>',
      },
      {
        name: 'skill:project-pi-skill',
        description: 'fixture project-pi-skill',
        source: 'auto',
        scope: 'project',
        baseDir: '<projectPi>',
      },
    ]);
    expect(skills.some((skill) => skill.name.includes('wrong-pi-agent'))).toBe(false);
  });

  it('keeps two concurrent config homes and resource results isolated', async () => {
    const first = await createFixture('pi-rpc-concurrent-a-');
    const second = await createFixture('pi-rpc-concurrent-b-');
    writeSkill(path.join(first.configHome, 'skills', 'only-first'), 'only-first');
    writeSkill(path.join(second.configHome, 'skills', 'only-second'), 'only-second');

    const [firstResult, secondResult] = await Promise.all([
      runGetCommands({
        binaryPath: PI_BINARY,
        cwd: first.workingDir,
        configHome: first.configHome,
        sessionDir: first.sessionDir,
        approve: false,
      }),
      runGetCommands({
        binaryPath: PI_BINARY,
        cwd: second.workingDir,
        configHome: second.configHome,
        sessionDir: second.sessionDir,
        approve: false,
      }),
    ]);

    const firstNames = normalizeSkills(firstResult.commands, first).map((skill) => skill.name);
    const secondNames = normalizeSkills(secondResult.commands, second).map((skill) => skill.name);
    expect(firstNames).toContain('skill:only-first');
    expect(firstNames).not.toContain('skill:only-second');
    expect(secondNames).toContain('skill:only-second');
    expect(secondNames).not.toContain('skill:only-first');
  });

  it('loads repeated explicit project skills under no-approve and no-skills', async () => {
    const fixture = await createFixture('pi-rpc-explicit-skills-only-');
    const explicitSkills = [
      path.join(fixture.workingDir, '.pi', 'skills', 'project-pi-skill'),
      path.join(fixture.repoRoot, '.agents', 'skills', 'ancestor-agents-skill'),
    ];
    const result = await runGetCommands({
      binaryPath: PI_BINARY,
      cwd: fixture.workingDir,
      configHome: fixture.configHome,
      sessionDir: fixture.sessionDir,
      approve: false,
      extraArgs: [
        '--no-skills',
        '--no-extensions',
        ...explicitSkills.flatMap((skillPath) => ['--skill', skillPath]),
      ],
    });

    expect(normalizeSkills(result.commands, fixture).map((skill) => skill.name)).toEqual([
      'skill:ancestor-agents-skill',
      'skill:project-pi-skill',
    ]);
  });

  it('keeps global discovery while explicit project skills bypass only the project trust gate', async () => {
    const fixture = await createFixture('pi-rpc-explicit-skills-additive-');
    const explicitSkill = path.join(
      fixture.workingDir,
      '.pi',
      'skills',
      'project-pi-skill',
    );
    const result = await runGetCommands({
      binaryPath: PI_BINARY,
      cwd: fixture.workingDir,
      configHome: fixture.configHome,
      sessionDir: fixture.sessionDir,
      approve: false,
      extraArgs: ['--no-extensions', '--skill', explicitSkill],
    });

    expect(normalizeSkills(result.commands, fixture).map((skill) => skill.name)).toEqual([
      'skill:global-skill',
      'skill:project-pi-skill',
    ]);
    expect(result.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'skill:project-pi-skill',
        source: 'skill',
        sourceInfo: expect.objectContaining({
          path: path.join(explicitSkill, 'SKILL.md'),
          source: 'local',
          scope: expectedExplicitProjectSkillScope(fixture),
        }),
      }),
    ]));
  });

  it('loads an explicit immutable skill snapshot from a non-auto-scanned configHome directory', async () => {
    const fixture = await createFixture('pi-rpc-config-home-snapshot-');
    const snapshotSkill = path.join(
      fixture.configHome,
      'project-resources',
      'skills',
      '0',
      'snapshot-skill',
    );
    writeSkill(snapshotSkill, 'snapshot-skill');
    const result = await runGetCommands({
      binaryPath: PI_BINARY,
      cwd: fixture.workingDir,
      configHome: fixture.configHome,
      sessionDir: fixture.sessionDir,
      approve: false,
      extraArgs: ['--no-extensions', '--skill', snapshotSkill],
    });

    expect(result.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'skill:snapshot-skill',
        source: 'skill',
        sourceInfo: expect.objectContaining({
          baseDir: snapshotSkill,
          path: path.join(snapshotSkill, 'SKILL.md'),
          source: 'local',
          scope: 'temporary',
        }),
      }),
    ]));
    expect(result.commands.some((command) => command.name === 'skill:project-pi-skill')).toBe(false);
  });

  it('reports the exact file provenance for an explicit single-file skill', async () => {
    const fixture = await createFixture('pi-rpc-explicit-file-skill-');
    const explicitSkill = path.join(fixture.workingDir, '.pi', 'skills', 'single-file.md');
    writeFileSync(
      explicitSkill,
      '---\nname: single-file\ndescription: fixture single file\n---\nfixture single file\n',
    );
    const result = await runGetCommands({
      binaryPath: PI_BINARY,
      cwd: fixture.workingDir,
      configHome: fixture.configHome,
      sessionDir: fixture.sessionDir,
      approve: false,
      extraArgs: ['--no-extensions', '--skill', explicitSkill],
    });

    expect(result.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'skill:single-file',
        source: 'skill',
        sourceInfo: expect.objectContaining({
          baseDir: path.dirname(explicitSkill),
          path: explicitSkill,
          source: 'local',
          scope: expectedExplicitProjectSkillScope(fixture),
        }),
      }),
    ]));
  });

  it('reports one deterministic runtime command when explicit approved paths share a skill name', async () => {
    const fixture = await createFixture('pi-rpc-explicit-duplicate-name-');
    const first = path.join(fixture.workingDir, '.pi', 'skills', 'duplicate-first');
    const second = path.join(fixture.repoRoot, '.agents', 'skills', 'duplicate-second');
    writeSkill(first, 'duplicate-name');
    writeSkill(second, 'duplicate-name');

    const result = await runGetCommands({
      binaryPath: PI_BINARY,
      cwd: fixture.workingDir,
      configHome: fixture.configHome,
      sessionDir: fixture.sessionDir,
      approve: false,
      extraArgs: [
        '--no-extensions',
        '--skill', first,
        '--skill', second,
      ],
    });

    const duplicates = result.commands.filter((command) => command.name === 'skill:duplicate-name');
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toMatchObject({
      source: 'skill',
      sourceInfo: {
        baseDir: first,
        source: 'local',
        scope: expectedExplicitProjectSkillScope(fixture),
      },
    });
  });

  it('executes only explicit host extensions and never installs or executes project packages/extensions', async () => {
    const fixture = await createFixture('pi-rpc-resource-hard-gates-');
    const trustedExtensionMarker = path.join(fixture.root, 'trusted-extension-loaded');
    const projectExtensionMarker = path.join(fixture.root, 'project-extension-loaded');
    const packageExtensionMarker = path.join(fixture.root, 'package-extension-loaded');
    const npmMarker = path.join(fixture.root, 'npm-invoked');
    const gitTrace = path.join(fixture.root, 'git-trace.log');
    const trustedExtension = path.join(fixture.configHome, 'trusted-extension.ts');
    const projectExtension = path.join(fixture.workingDir, '.pi', 'extensions', 'project.ts');
    const localPackage = path.join(fixture.root, 'local-package');
    const packageExtension = path.join(localPackage, 'extensions', 'package.ts');
    const npmProbe = path.join(fixture.root, 'npm-probe.mjs');

    mkdirSync(path.dirname(projectExtension), { recursive: true });
    mkdirSync(path.dirname(packageExtension), { recursive: true });
    const markerExtension = (marker: string) => [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(marker)}, 'loaded');`,
      'export default function () {}',
    ].join('\n');
    writeFileSync(trustedExtension, markerExtension(trustedExtensionMarker));
    writeFileSync(projectExtension, markerExtension(projectExtensionMarker));
    writeFileSync(packageExtension, markerExtension(packageExtensionMarker));
    writeFileSync(path.join(localPackage, 'package.json'), JSON.stringify({
      name: 'fixture-local-package',
      version: '1.0.0',
      pi: { extensions: ['./extensions/package.ts'] },
    }));
    writeFileSync(
      npmProbe,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(npmMarker)}, 'called'); process.exit(17);\n`,
    );
    writeFileSync(path.join(fixture.workingDir, '.pi', 'settings.json'), JSON.stringify({
      npmCommand: [process.execPath, npmProbe],
      packages: [
        'npm:fixture-must-not-install',
        'git:http://127.0.0.1:9/fixture-must-not-clone',
        localPackage,
      ],
      extensions: [projectExtension],
    }));

    const result = await runGetCommands({
      binaryPath: PI_BINARY,
      cwd: fixture.workingDir,
      configHome: fixture.configHome,
      sessionDir: fixture.sessionDir,
      approve: false,
      offline: false,
      extraEnv: {
        GIT_TRACE: gitTrace,
        GIT_TERMINAL_PROMPT: '0',
      },
      extraArgs: [
        '--no-extensions',
        '--extension', trustedExtension,
        '--skill', path.join(fixture.workingDir, '.pi', 'skills', 'project-pi-skill'),
      ],
    });

    expect(normalizeSkills(result.commands, fixture).map((skill) => skill.name)).toEqual([
      'skill:global-skill',
      'skill:project-pi-skill',
    ]);
    expect(existsSync(trustedExtensionMarker)).toBe(true);
    expect(existsSync(projectExtensionMarker)).toBe(false);
    expect(existsSync(packageExtensionMarker)).toBe(false);
    expect(existsSync(npmMarker)).toBe(false);
    expect(existsSync(path.join(fixture.workingDir, '.pi', 'npm'))).toBe(false);
    expect(existsSync(path.join(fixture.workingDir, '.pi', 'git'))).toBe(false);
    expect(existsSync(gitTrace) ? readFileSync(gitTrace, 'utf8') : '').not.toMatch(/\bclone\b/i);
  });
});
