import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CINDY_SUBAGENT_RUNNER_SOURCE } from '../cindy-subagent-runner-source.js';

/**
 * Every case here spawns a real runner process (and that runner spawns a fake
 * pi per child). Vitest's 5s default is a Linux-shaped budget: on the Windows
 * CI runner process creation alone eats most of it, which is why this whole
 * file went red there while staying green on Linux. The waits inside the tests
 * are the real bound — they poll durable state and fail with a readable
 * message — so this only has to be comfortably above them.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
/**
 * Wait budget for the one case that queues a 513-request control backlog.
 *
 * Everything else here waits on an event; that case waits on I/O throughput,
 * and the suite default is a per-event budget. The case carries a matching
 * per-test override, since the file-level 60s cannot contain a wait that is
 * allowed to run this long. It does not run on Windows at all — see the skip
 * at its call site.
 */
const CONTROL_BACKLOG_WAIT_MS = 90_000;
const CONTROL_BACKLOG_TEST_TIMEOUT_MS = 120_000;
import {
  controlPiSubagentRuns,
  isPiSubagentTerminal,
  stopPiSubagentRunsForAccountBoundary as stopForAccountBoundary,
  listPiSubagentRuns,
  resumePiSubagentRun,
  stopAndRemovePiSubagentRuns,
} from '../pi-subagent-runs.js';

const roots: string[] = [];

/**
 * `runner.cjs` is byte-identical for every fixture and by far the biggest file
 * each one writes. Writing it once for the suite keeps ~30 real file creations
 * (and, on Windows, ~30 realtime-scanner passes over a freshly written script)
 * off the per-test path. It is stateless, so sharing cannot leak between tests;
 * the runner reads all of its state from the config path it is given.
 */
let sharedRunnerFilePromise: Promise<string> | null = null;

function sharedRunnerFile(): Promise<string> {
  sharedRunnerFilePromise ??= (async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cindy-pi-runner-shared-'));
    const file = path.join(dir, 'runner.cjs');
    await writeFile(file, CINDY_SUBAGENT_RUNNER_SOURCE, { mode: 0o700 });
    await chmod(file, 0o700);
    return file;
  })();
  return sharedRunnerFilePromise;
}

/**
 * Read the fake child's command log, or null while it does not exist yet.
 *
 * `commands.jsonl` is created by the fake pi *after* it starts, which on Windows
 * trails the runner publishing `state === 'running'` by a whole spawn (2-4s).
 * `waitFor` does not catch read errors, so the first poll threw ENOENT and took
 * the case down instead of polling again. This is a fixture race, not a product
 * contract: nothing in production writes or reads this file.
 */
async function readCommandsIfPresent(
  file: string,
): Promise<Array<{ type?: string; message?: string }> | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.split('\n').map((line) => JSON.parse(line) as { type?: string; message?: string });
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-pi-runner-'));
  roots.push(root);
  return root;
}

/**
 * Poll a real runner's durable state until `read` returns a value.
 *
 * `what` is only used to make a CI timeout readable: without it the failure
 * surfaces later as a confusing assertion on a half-written record instead of
 * "the child never reached this state".
 *
 * The default window has to match the suite budget, not a Linux stopwatch: the
 * heavier cases incubate several real child processes in sequence and a single
 * spawn costs 2-4s on the Windows CI runner, so a 10s window expired inside
 * this helper while the run was still healthy. 30s leaves room under the 60s
 * per-test budget for the poll to fail with its readable message first.
 */
async function waitFor<T>(
  read: () => Promise<T | null>,
  timeoutMs = 30_000,
  what: string | (() => string) = 'runner state',
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${typeof what === 'function' ? what() : what}\n${await activeFixtureDiagnostics()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Why a durable-state wait timed out, on platforms we cannot reproduce on.
 *
 * `listPiSubagentRuns` hides corrupt *and* stale records, so "the run never
 * reached this state" is indistinguishable from "it published the state but the
 * record was rejected" and "the runner died and the record went stale". Reading
 * status.json raw, next to the runner's own stderr, separates those three on the
 * first CI run instead of costing another round trip.
 *
 * Attached to every wait in this suite through the live-fixture registry rather
 * than per call site, so a case that starts timing out on Windows next month is
 * self-explaining without anyone remembering to opt in.
 */
const activeFixtures: Array<{ runDir: string; stderr: () => string }> = [];

async function activeFixtureDiagnostics(): Promise<string> {
  if (activeFixtures.length === 0) return '(no live runner fixture)';
  const blocks = await Promise.all(activeFixtures.map(async (fixture, index) => {
    const parts = [`fixture[${index}] runDir=${fixture.runDir}`];
    try {
      parts.push(`  status.json: ${await readFile(path.join(fixture.runDir, 'status.json'), 'utf8')}`);
    } catch (error) {
      parts.push(`  status.json unreadable: ${String(error)}`);
    }
    const stderr = fixture.stderr().trim();
    parts.push(stderr ? `  runner stderr: ${stderr.slice(-4000)}` : '  runner stderr: (empty)');
    return parts.join('\n');
  }));
  return blocks.join('\n');
}

async function waitForClose(child: ReturnType<typeof spawn>, stderr: () => string): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    if (child.exitCode === 0) return;
    throw new Error(stderr());
  }
  await new Promise<void>((resolve, reject) => {
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(stderr())));
  });
}

async function makeFixture(options: {
  hang?: boolean;
  tasks?: number;
  concurrency?: number;
  timeoutMs?: number;
  outputText?: string;
  chain?: boolean;
  approval?: boolean;
  approvalMethod?: 'confirm' | 'input';
  modelError?: boolean;
  retryThenSucceed?: boolean;
  outputThenHang?: boolean;
  hangOnMessage?: string;
  delayExitAfterInputEndMs?: number;
  runtimeOwnerId?: string;
  /** Point this task's sessionDir at an existing *file* so launchTask throws. */
  poisonSessionDirIndex?: number;
  /**
   * Keep the child alive after its stdin closes. Without this the fake pi exits
   * as soon as the runner dies and its pipes close, which would silently stand
   * in for the runner actually reaping it.
   */
  surviveStdinEnd?: boolean;
  /** Model a wedged runner: publish status, never consume the stop mailbox. */
  ignoreStopControl?: boolean;
  /**
   * Hold a finishing child's turn until this many child pids are on disk.
   *
   * Sequencing tool for cases whose premise is "a sibling child is already
   * running when X happens". Spawn order alone does not give that: a lane can
   * finish its own task and move on before a sibling's freshly spawned process
   * has even reached its first line, so the assertions would race a real
   * process launch. Bounded — see `waitForPidCount` in the generated child.
   */
  gateFinishOnPidCount?: number;
  /**
   * Occupy `result.json` with a directory before the runner starts.
   *
   * Renaming a file onto an existing directory fails persistently (EISDIR /
   * ENOTDIR, or EPERM on Windows after the transient retries), which is the
   * portable way to make the result artifact unwritable without touching
   * permissions or mocking fs.
   */
  poisonResultPath?: boolean;
} = {}) {
  const root = await tempRoot();
  const runId = randomUUID();
  const runDir = path.join(root, runId);
  const sessions = path.join(runDir, 'sessions');
  const childConfigHome = path.join(runDir, 'pi-home');
  await mkdir(sessions, { recursive: true });
  await mkdir(childConfigHome, { recursive: true });
  await writeFile(path.join(childConfigHome, 'models.json'), '{"providers":{}}\n');
  // A wedged runner: publishes a heartbeating running status and never reads
  // the control mailbox. Written *into the run dir* so its argv path carries the
  // run UUID, exactly as the production runner does — that path is the identity
  // the host verifies before signalling.
  const runnerFile = options.ignoreStopControl
    ? path.join(runDir, 'runner.cjs')
    : await sharedRunnerFile();
  const fakePiFile = path.join(root, 'fake-pi.cjs');
  const bridgeFile = path.join(runDir, 'cindy-bridge.ts');
  const permissionFile = path.join(runDir, 'permission.json');
  const argsFile = path.join(root, 'args.jsonl');
  const promptsFile = path.join(root, 'prompts.jsonl');
  const commandsFile = path.join(root, 'commands.jsonl');
  const stdinEndedFile = path.join(root, 'stdin-ended');
  const tokensFile = path.join(root, 'tokens.jsonl');
  const pidsFile = path.join(root, 'child-pids.jsonl');
  const poisonedSessionDir = path.join(root, 'poisoned-session-dir');
  if (options.ignoreStopControl) {
    await writeFile(runnerFile, `
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
function publish() {
  const now = Date.now();
  fs.writeFileSync(path.join(config.runDir, 'status.json'), JSON.stringify({
    version: 1,
    runId: config.runId,
    taskId: config.taskId,
    parentSessionId: config.parentSessionId,
    runtimeOwnerId: config.runtimeOwnerId,
    runnerInstanceId: 'wedged-runner',
    runnerPid: process.pid,
    runnerScript: process.argv[1],
    state: 'running',
    startedAt: now,
    updatedAt: now,
    tasks: config.tasks.map((task) => ({
      childId: task.childId, sessionId: task.sessionId, agent: task.agent, status: 'running',
    })),
  }) + '\\n');
}
publish();
setInterval(publish, 1000);
setTimeout(() => process.exit(0), 60000).unref();
`, { mode: 0o700 });
    await chmod(runnerFile, 0o700);
  }
  await writeFile(bridgeFile, 'export default function () {}\n');
  await writeFile(permissionFile, '{"mode":"ask"}\n');
  const fixtureOutput = JSON.stringify(options.outputText ?? 'fixture result');
  const approvalMethod = options.approvalMethod ?? 'confirm';
  const fixtureLifecycle = options.outputThenHang
    ? `process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: ${fixtureOutput} }], usage: { input: 3, output: 2, cost: { total: 0.01 } } } }) + '\\n');`
    : options.hang
      ? ''
    : options.modelError
      ? `process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'socket closed before response', usage: { input: 0, output: 0 } } }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');`
      : options.retryThenSucceed
        ? `process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'temporary socket failure', usage: { input: 1, output: 0 } } }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'auto_retry_start', attempt: 1, maxAttempts: 2, delayMs: 0, errorMessage: 'temporary socket failure' }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: ${fixtureOutput} }], usage: { input: 3, output: 2, cost: { total: 0.01 } } } }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');`
        : `process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: ${fixtureOutput} }], usage: { input: 3, output: 2, cost: { total: 0.01 } } } }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');`;
  await writeFile(fakePiFile, `
'use strict';
const fs = require('node:fs');
const path = require('node:path');
if (!process.env.PI_CODING_AGENT_DIR || !fs.existsSync(path.join(process.env.PI_CODING_AGENT_DIR, 'models.json'))) {
  process.exit(9);
}
if (Object.keys(process.env).some((key) => key.startsWith('CINDY_PI_REMOTE_MCP_SECRET_'))) {
  process.exit(10);
}
if (Object.keys(process.env).some((key) =>
  key.startsWith('CINDY_PI_SUBAGENT_') && key !== 'CINDY_PI_SUBAGENT_RUN_DIR')) {
  process.exit(11);
}
if (!process.env.PI_CODING_AGENT_DIR ||
    process.env.CINDY_PI_BASH_PACKAGE_HOME !== path.posix.join(process.env.PI_CODING_AGENT_DIR, 'bash-package-home')) {
  process.exit(13);
}
const subagentRunDir = process.env.CINDY_PI_SUBAGENT_RUN_DIR;
if (!subagentRunDir || path.dirname(subagentRunDir) !== ${JSON.stringify(root)} ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(path.basename(subagentRunDir))) {
  process.exit(12);
}
fs.appendFileSync(process.env.CINDY_TEST_PI_ARGS, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.CINDY_TEST_PI_PIDS) {
  fs.appendFileSync(process.env.CINDY_TEST_PI_PIDS, String(process.pid) + '\\n');
}
if (process.env.CINDY_TEST_PI_TOKENS) {
  fs.appendFileSync(process.env.CINDY_TEST_PI_TOKENS, JSON.stringify(process.env.CINDY_PI_SESSION_TOKEN || null) + '\\n');
}
// Block this child's turn until \`count\` children have recorded their pid.
// Synchronous on purpose: this process has nothing else to do, and the caller
// needs the guarantee *before* it answers the prompt. Bounded so a sibling that
// never starts turns into the case's own readable assertion failure instead of
// a hang.
function waitForPidCount(count) {
  const deadline = Date.now() + 20000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let seen = 0;
    try {
      seen = fs.readFileSync(process.env.CINDY_TEST_PI_PIDS, 'utf8').split('\\n').filter(Boolean).length;
    } catch (_) { /* not created yet */ }
    if (seen >= count || Date.now() >= deadline) return;
    Atomics.wait(sleeper, 0, 0, 20);
  }
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    fs.appendFileSync(process.env.CINDY_TEST_PI_COMMANDS, JSON.stringify(command) + '\\n');
    if (command.type === 'prompt') {
      fs.appendFileSync(process.env.CINDY_TEST_PI_PROMPTS, JSON.stringify(command.message) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'response', command: 'prompt', success: true }) + '\\n');
      ${options.approval
    ? `process.stdout.write(JSON.stringify({ type: 'extension_ui_request', id: 'approval-1', method: ${JSON.stringify(approvalMethod)}, title: 'cindy:permission', ${approvalMethod === 'input' ? 'placeholder' : 'message'}: JSON.stringify({ toolName: 'write', input: { path: 'a.txt' } }) }) + '\\n');`
    : `${options.hangOnMessage ? `if (command.message !== ${JSON.stringify(options.hangOnMessage)}) {` : ''}
      ${options.gateFinishOnPidCount ? `waitForPidCount(${options.gateFinishOnPidCount});` : ''}
      process.stdout.write(JSON.stringify({ type: 'tool_execution_start', toolName: 'read' }) + '\\n');
      ${fixtureLifecycle}
      ${options.hangOnMessage ? '}' : ''}`}
    }
    if (command.type === 'extension_ui_response' && command.id === 'approval-1') {
      if (command.confirmed || command.value === 'allow') {
        process.stdout.write(JSON.stringify({ type: 'tool_execution_start', toolName: 'write' }) + '\\n');
        process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: ${fixtureOutput} }], usage: { input: 3, output: 2, cost: { total: 0.01 } } } }) + '\\n');
      }
      process.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');
    }
  }
});
process.stdin.on('end', () => {
  if (process.env.CINDY_TEST_PI_STDIN_ENDED) {
    fs.writeFileSync(process.env.CINDY_TEST_PI_STDIN_ENDED, '1');
  }
  ${options.surviveStdinEnd
    ? 'setInterval(() => {}, 1000);'
    : `setTimeout(() => process.exit(0), ${Math.max(0, options.delayExitAfterInputEndMs ?? 0)});`}
});
`, { mode: 0o700 });
  await chmod(fakePiFile, 0o700);
  const count = options.tasks ?? 1;
  const config = {
    version: 1,
    runId,
    taskId: 'tool-fixture',
    parentSessionId: 'parent-fixture',
    ...(options.runtimeOwnerId ? { runtimeOwnerId: options.runtimeOwnerId } : {}),
    runDir,
    cwd: root,
    binary: process.execPath,
    binaryPrefixArgs: [fakePiFile],
    childConfigHome,
    bridgeExtension: bridgeFile,
    permissionFile,
    depth: 1,
    mode: options.chain ? 'chain' : count > 1 ? 'parallel' : 'single',
    context: 'fresh',
    title: 'fixture',
    description: 'runner fixture',
    concurrency: options.concurrency ?? 4,
    timeoutMs: options.timeoutMs ?? 10_000,
    tasks: Array.from({ length: count }, (_, index) => ({
      childId: `${runId}-${index + 1}`,
      stepId: `step-${index + 1}`,
      dependsOn: options.chain && index > 0 ? [`step-${index}`] : [],
      sessionId: `${runId}-${index + 1}`,
      sessionDir: options.poisonSessionDirIndex === index ? poisonedSessionDir : sessions,
      agent: 'scout',
      title: `scout ${index + 1}`,
      task: `task ${index + 1}`,
      tools: 'read,grep,find,ls',
      profilePrompt: 'fixture prompt',
      provider: 'fixture',
      model: 'fixture-model',
      thinking: 'high',
      cwd: root,
    })),
  };
  const configPath = path.join(runDir, 'config.json');
  await writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  if (options.poisonSessionDirIndex !== undefined) {
    // A plain file where the runner expects to mkdir a session directory: the
    // launch throws mid-flight, after sibling lanes have already spawned.
    await writeFile(poisonedSessionDir, 'not a directory\n', { mode: 0o600 });
  }
  // Before the spawn, so the artifact is already unwritable on the run's very
  // first terminal write — no race with a fast child.
  if (options.poisonResultPath) await mkdir(path.join(runDir, 'result.json'), { recursive: true });
  const child = spawn(process.execPath, [runnerFile, configPath], {
    cwd: root,
    env: {
      ...process.env,
      CINDY_TEST_PI_PIDS: pidsFile,
      CINDY_TEST_PI_ARGS: argsFile,
      CINDY_TEST_PI_PROMPTS: promptsFile,
      CINDY_TEST_PI_COMMANDS: commandsFile,
      CINDY_TEST_PI_STDIN_ENDED: stdinEndedFile,
      CINDY_TEST_PI_TOKENS: tokensFile,
      CINDY_PI_SESSION_TOKEN: 'parent-session-token-must-not-reach-direct-child',
      CINDY_PI_REMOTE_MCP_SECRET_FIXTURE: 'must-not-reach-child',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const fixture = {
    root, runId, runDir, runnerFile, argsFile, promptsFile, commandsFile, stdinEndedFile,
    tokensFile, pidsFile,
    child, stderr: () => stderr,
  };
  activeFixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  activeFixtures.splice(0);
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    // Windows: a runner or fake child that has not fully exited still holds its
    // cwd and open handles, so the first rmdir comes back EBUSY/EPERM. Node's
    // own retry loop is the standard remedy, and this is teardown only.
    maxRetries: 10,
    retryDelay: 100,
  })));
});

describe('Cindy durable PI Subagent runner', () => {
  /**
   * result.json is an attachment, not the verdict. Nothing in the product reads
   * it back; status.json is what the Host converges on. So a failure to write it
   * must not be able to change what the run reports — the old code let the throw
   * from the success path land in the failure handler, which rewrote the state
   * to `failed` and republished, and a throw from the failure handler escaped it
   * entirely so the terminal status was never published at all.
   */
  describe('result artifact failures', () => {
    it('publishes the real terminal state when the result artifact cannot be written', async () => {
      const fixture = await makeFixture({ poisonResultPath: true });

      const completed = await waitFor(
        async () => {
          const [run] = await listPiSubagentRuns(fixture.root);
          return run?.state === 'completed' ? run : null;
        },
        undefined,
        'the run to publish completed despite the unwritable result artifact',
      );
      expect(completed.tasks[0]).toMatchObject({ status: 'completed', output: 'fixture result' });
      // Never advertise an artifact that is not there.
      expect(completed.resultPath).toBeUndefined();
      await waitFor(
        async () => (/result artifact write failed/.test(fixture.stderr()) ? true : null),
        undefined,
        'the runner to report the artifact failure on stderr',
      );
    });

    it('still advertises the artifact on the normal path', async () => {
      const fixture = await makeFixture();
      const completed = await waitFor(async () => {
        const [run] = await listPiSubagentRuns(fixture.root);
        return run?.state === 'completed' ? run : null;
      });
      expect(completed.resultPath).toBe(path.join(fixture.runDir, 'result.json'));
      expect(JSON.parse(await readFile(completed.resultPath!, 'utf8'))).toMatchObject({
        state: 'completed',
      });
      await waitForClose(fixture.child, fixture.stderr);
    });
  });

  it('uses unique exact child session ids and persists terminal output/usage', async () => {
    const fixture = await makeFixture({ tasks: 2 });
    const completed = await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.state === 'completed' ? run : null;
    });
    expect(completed.tasks).toHaveLength(2);
    expect(new Set(completed.tasks.map((task) => task.sessionId)).size).toBe(2);
    expect(completed.tasks.every((task) => task.output === 'fixture result')).toBe(true);
    expect(completed.totalTokens).toBe(10);
    const argLines = (await readFile(fixture.argsFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[]);
    expect(argLines).toHaveLength(2);
    for (const args of argLines) {
      expect(args).toContain('--session-id');
      expect(args).not.toContain('--session');
      expect(args).toContain('--provider');
      expect(args).toContain('fixture');
      expect(args).toContain('--model');
      expect(args).toContain('fixture-model');
      expect(args).toContain('--thinking');
      expect(args).toContain('high');
    }
    expect(await readFile(path.join(fixture.runDir, 'result.json'), 'utf8')).toContain('fixture result');
    expect(await readFile(path.join(fixture.runDir, 'transcript.jsonl'), 'utf8')).toContain('child_event');
    expect(
      (await readFile(fixture.tokensFile, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([null, null]);
    await waitForClose(fixture.child, fixture.stderr);
  });

  it('records a zero-exit model failure as failed instead of completed with empty usage', async () => {
    const fixture = await makeFixture({ modelError: true });
    const failed = await waitFor(
      async () => {
        const [run] = await listPiSubagentRuns(fixture.root);
        return run?.state === 'failed' ? run : null;
      },
      undefined,
      'the zero-exit model failure to be recorded as failed',
    );
    expect(failed.tasks[0]).toMatchObject({
      status: 'failed',
      error: 'socket closed before response',
    });
    expect(failed.tasks[0]?.output).toBe('');
    await waitForClose(fixture.child, fixture.stderr);
  });

  it('waits through agent_end and completes after a successful automatic retry', async () => {
    const fixture = await makeFixture({ retryThenSucceed: true });
    const completed = await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.state === 'completed' ? run : null;
    });
    expect(completed.tasks[0]).toMatchObject({
      status: 'completed',
      output: 'fixture result',
    });
    expect(completed.totalTokens).toBe(6);
    await waitForClose(fixture.child, fixture.stderr);
  });

  it('rejects controls after the child RPC input has closed but before process exit', async () => {
    const fixture = await makeFixture({ delayExitAfterInputEndMs: 750 });
    await waitFor(async () => {
      try {
        await readFile(fixture.stdinEndedFile, 'utf8');
        return true;
      } catch {
        return null;
      }
    });
    const [closing] = await listPiSubagentRuns(fixture.root);
    expect(closing && closing.state !== 'completed' && closing.state !== 'failed').toBe(true);
    await expect(controlPiSubagentRuns(fixture.root, closing!.runId, 'follow_up', {
      message: 'too late for this generation',
    })).resolves.toBe(0);
    await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.state === 'completed' ? run : null;
    });
    await waitForClose(fixture.child, fixture.stderr);
  });

  it('feeds each durable chain result into the next isolated child', async () => {
    const fixture = await makeFixture({ tasks: 2, concurrency: 2, chain: true });
    const completed = await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.state === 'completed' ? run : null;
    });
    const prompts = (await readFile(fixture.promptsFile, 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line) as string);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toBe('task 1');
    expect(prompts[1]).toContain('Previous workflow results:');
    expect(prompts[1]).toContain('fixture result');
    expect(completed.tasks[1]?.task).toBe('task 2');
    await waitForClose(fixture.child, fixture.stderr);
  });

  /**
   * The in-process promise map only serialises resumes inside one Cindy. Two
   * instances sharing `pi-agent-home` could read the same terminal generation,
   * both pass the "no active run" check, and each launch a runner over the same
   * Pi session dir and session id.
   */
  describe('cross-process resume claim', () => {
    /** A completed run whose config is valid to resume. */
    async function resumableFixture(options: Parameters<typeof makeFixture>[0] = {}) {
      const fixture = await makeFixture(options);
      const first = await waitFor(async () => {
        const runs = await listPiSubagentRuns(fixture.root);
        return runs.find((run) => run.runId === fixture.runId && run.state === 'completed') ?? null;
      });
      await waitForClose(fixture.child, fixture.stderr);
      return { fixture, first };
    }

    function resumeLaunch(fixture: Awaited<ReturnType<typeof makeFixture>>) {
      return {
        nodeExecutable: process.execPath,
        runtimeOwnerId: 'resume-owner',
        runnerFallbackFile: fixture.runnerFile,
        env: {
          ...process.env,
          CINDY_TEST_PI_ARGS: fixture.argsFile,
          CINDY_TEST_PI_PROMPTS: fixture.promptsFile,
          CINDY_TEST_PI_COMMANDS: fixture.commandsFile,
        },
        permissionSnapshot: { mode: 'ask' as const, readOnlyRoots: [] as string[] },
        runtimeSnapshot: {
          modelsJson: Buffer.from('{"providers":{}}\n'),
          bridgeSource: Buffer.from('export default function bridge() {}\n'),
          runnerSource: Buffer.from(CINDY_SUBAGENT_RUNNER_SOURCE),
        },
      };
    }

    it('refuses when a live instance already holds the claim', async () => {
      const { fixture, first } = await resumableFixture();
      // process.ppid is certainly alive and is not us.
      await writeFile(
        path.join(fixture.root, first.runId, 'resume.claim'),
        `${JSON.stringify({ version: 1, hostPid: process.ppid, claimedAt: Date.now() })}\n`,
        { mode: 0o600 },
      );

      await expect(resumePiSubagentRun(
        fixture.root, first.runId, 'continue', resumeLaunch(fixture),
      )).rejects.toThrow(/already resuming this Subagent generation/i);
    });

    it('takes over a claim whose pid is live but belongs to another process', async () => {
      // The pid is alive, but the claim says its holder started at the epoch —
      // so the pid was recycled and the real holder is gone. Without the start
      // time this reads as a live holder and resume is wedged forever.
      // Spawn a same-user child rather than probing process.ppid: GHA Windows
      // often cannot read the runner parent's StartTime (probe null →
      // conservative "still held"), which is not the product contract.
      const { fixture, first } = await resumableFixture();
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      const childPid = child.pid;
      try {
        if (!Number.isSafeInteger(childPid) || !childPid) {
          throw new Error('failed to spawn a live foreign process for the claim');
        }
        const claimPath = path.join(fixture.root, first.runId, 'resume.claim');
        await writeFile(
          claimPath,
          `${JSON.stringify({
            version: 1,
            hostPid: childPid,
            hostStartTimeSec: 1,
            claimedAt: Date.now(),
          })}\n`,
          { mode: 0o600 },
        );

        const resumedRunId = await resumePiSubagentRun(
          fixture.root, first.runId, 'continue', resumeLaunch(fixture),
        );
        expect(typeof resumedRunId).toBe('string');
        await waitFor(
          async () => {
            const runs = await listPiSubagentRuns(fixture.root);
            return runs.find((run) => run.runId === resumedRunId && isPiSubagentTerminal(run.state)) ?? null;
          },
          undefined,
          'the resumed generation to settle',
        );
      } finally {
        child.kill();
        await new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
          }, 2_000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    });

    it('takes over a claim left behind by a dead instance', async () => {
      const { fixture, first } = await resumableFixture();
      const claimPath = path.join(fixture.root, first.runId, 'resume.claim');
      // 2^22 is above every OS pid_max, so this owner is provably gone.
      await writeFile(
        claimPath,
        `${JSON.stringify({ version: 1, hostPid: 4_194_303, claimedAt: 1 })}\n`,
        { mode: 0o600 },
      );

      const resumedRunId = await resumePiSubagentRun(
        fixture.root, first.runId, 'continue', resumeLaunch(fixture),
      );
      expect(typeof resumedRunId).toBe('string');
      await waitFor(
        async () => {
          const runs = await listPiSubagentRuns(fixture.root);
          return runs.find((run) => run.runId === resumedRunId && isPiSubagentTerminal(run.state)) ?? null;
        },
        undefined,
        'the resumed generation to settle',
      );
      // The claim is released once the new generation exists on disk.
      await expect(readFile(claimPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    /**
     * The state a racer leaves behind between creating the claim and writing its
     * payload. An empty claim is indistinguishable from a corrupt one by reading
     * alone, so taking over on the first failed parse hands two live instances
     * the same PI child session — duplicate follow-ups on one conversation.
     */
    it('does not take over a claim that has been created but not written yet', async () => {
      const { fixture, first } = await resumableFixture();
      const claimPath = path.join(fixture.root, first.runId, 'resume.claim');
      await writeFile(claimPath, '', { mode: 0o600 });

      const attempt = resumePiSubagentRun(
        fixture.root, first.runId, 'continue', resumeLaunch(fixture),
      );
      // The racer completes its write inside the re-read budget. Late enough
      // that a single-read implementation has certainly already given up on it,
      // early enough to land before the budget expires.
      await new Promise((resolve) => setTimeout(resolve, 250));
      await writeFile(
        claimPath,
        // process.ppid is certainly alive and is not us.
        `${JSON.stringify({ version: 1, hostPid: process.ppid, claimedAt: Date.now() })}\n`,
        { mode: 0o600 },
      );

      await expect(attempt).rejects.toThrow(/already resuming this Subagent generation/i);
      // The decisive part: no second generation was launched over that session.
      const runs = await listPiSubagentRuns(fixture.root);
      expect(runs.filter((run) => run.taskId === first.taskId)).toHaveLength(1);
    });

    it('takes over a claim that stays unreadable past the budget', async () => {
      // The other half of the contract: waiting must not become a wedge for a
      // record that is genuinely corrupt or left by an older build.
      const { fixture, first } = await resumableFixture();
      const claimPath = path.join(fixture.root, first.runId, 'resume.claim');
      await writeFile(claimPath, '', { mode: 0o600 });

      const resumedRunId = await resumePiSubagentRun(
        fixture.root, first.runId, 'continue', resumeLaunch(fixture),
      );
      expect(typeof resumedRunId).toBe('string');
      await waitFor(
        async () => {
          const runs = await listPiSubagentRuns(fixture.root);
          return runs.find((run) => run.runId === resumedRunId && isPiSubagentTerminal(run.state)) ?? null;
        },
        undefined,
        'the resumed generation to settle',
      );
      await expect(readFile(claimPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('lets exactly one of two concurrent instances resume a generation', async () => {
      // The resumed child hangs on the follow-up, so the winner's generation is
      // still non-terminal when the loser re-checks under the claim. Without
      // that the fake pi can finish first and the second resume becomes a
      // legitimate *sequential* resume — which is allowed, and would make this
      // assertion flaky rather than wrong.
      const { fixture, first } = await resumableFixture({ hangOnMessage: 'continue' });
      // A symlinked root keeps `path.resolve` distinct, so the two calls land in
      // different in-process serialisation buckets and race on disk exactly the
      // way two Cindy processes would.
      const aliasRoot = path.join(path.dirname(fixture.root), `alias-${randomUUID()}`);
      await symlink(fixture.root, aliasRoot, 'dir');
      roots.push(aliasRoot);

      const settled = await Promise.allSettled([
        resumePiSubagentRun(fixture.root, first.runId, 'continue', resumeLaunch(fixture)),
        resumePiSubagentRun(aliasRoot, first.runId, 'continue', resumeLaunch(fixture)),
      ]);
      const started = settled.filter(
        (outcome) => outcome.status === 'fulfilled' && typeof outcome.value === 'string',
      );
      // Mutual exclusion is the claim under test, and it is asserted without
      // assuming *which* racer wins. Either may now finish: the containment
      // guard resolves both sides canonically, so a symlinked root is no longer
      // rejected as an escape. Asserting "exactly one fulfilled" instead would
      // still be a coin flip on which racer got there first.
      // Windows CI saw this set come back empty, which no local ordering
      // reproduces. Dump both outcomes verbatim so the next run names the cause
      // instead of only reporting the count.
      const describeOutcomes = (): string => JSON.stringify(settled.map((outcome) => (
        outcome.status === 'fulfilled'
          ? { fulfilled: outcome.value }
          : { rejected: String((outcome.reason as Error)?.stack ?? outcome.reason) }
      )), null, 2);
      const refusedTheClaim = settled.filter((outcome) => (
        outcome.status === 'rejected'
        && /already resuming this Subagent generation/i.test(String(outcome.reason?.message ?? ''))
      ));
      expect(refusedTheClaim, `resume outcomes: ${describeOutcomes()}`).toHaveLength(1);
      expect(started.length).toBeLessThanOrEqual(1);
      // Whoever got through, there is never a second live generation over the
      // same PI child session — that is what a lost claim has to prevent.
      const runs = await listPiSubagentRuns(fixture.root);
      const resumedRuns = runs.filter((run) => run.taskId === first.taskId && run.runId !== first.runId);
      expect(resumedRuns).toHaveLength(started.length);

      if (started.length === 1) {
        const resumedRunId = (started[0] as PromiseFulfilledResult<string>).value;
        await controlPiSubagentRuns(fixture.root, resumedRunId, 'stop');
        await waitFor(
          async () => {
            const settledRuns = await listPiSubagentRuns(fixture.root);
            const resumed = settledRuns.find((run) => run.runId === resumedRunId);
            return resumed && isPiSubagentTerminal(resumed.state) ? resumed : null;
          },
          undefined,
          'the hung resumed generation to stop',
        );
      }
    });
  });

  it('resumes a terminal generation with the same PI child session id', async () => {
    const fixture = await makeFixture();
    const first = await waitFor(
      async () => {
        const runs = await listPiSubagentRuns(fixture.root);
        return runs.find((run) => run.runId === fixture.runId && run.state === 'completed') ?? null;
      },
      undefined,
      'the first generation to complete',
    );
    await waitForClose(fixture.child, fixture.stderr);
    const resumeTokenCanary = 'resume-parent-token-canary-1234567890';
    const priorConfigPath = path.join(fixture.runDir, 'config.json');
    const priorConfig = JSON.parse(await readFile(priorConfigPath, 'utf8')) as {
      tasks: Array<Record<string, unknown>>;
    };
    Object.assign(priorConfig.tasks[0]!, {
      proxySessionAuth: true,
      sourceProviderId: 'fixture',
    });
    await writeFile(priorConfigPath, `${JSON.stringify(priorConfig)}\n`, { mode: 0o600 });
    const currentModelsJson = Buffer.from('{"providers":{"current-parent":{}}}\n');
    const currentBridgeSource = Buffer.from('export default function currentParentBridge() {}\n');
    const currentRunnerSource = Buffer.from(CINDY_SUBAGENT_RUNNER_SOURCE);
    const resumedRunId = await resumePiSubagentRun(
      fixture.root,
      first.runId,
      'continue from the prior result',
      {
        nodeExecutable: process.execPath,
        runtimeOwnerId: 'resume-owner',
        runnerFallbackFile: fixture.runnerFile,
        env: {
          ...process.env,
          CINDY_PI_SESSION_TOKEN: resumeTokenCanary,
          CINDY_TEST_PI_ARGS: fixture.argsFile,
          CINDY_TEST_PI_PROMPTS: fixture.promptsFile,
          CINDY_TEST_PI_COMMANDS: fixture.commandsFile,
        },
        permissionSnapshot: { mode: 'ask', readOnlyRoots: ['/current-parent'] },
        runtimeSnapshot: {
          modelsJson: currentModelsJson,
          bridgeSource: currentBridgeSource,
          runnerSource: currentRunnerSource,
        },
      },
    );
    expect(resumedRunId).toEqual(expect.any(String));
    const resumed = await waitFor(async () => {
      const runs = await listPiSubagentRuns(fixture.root);
      return runs.find((run) => run.runId === resumedRunId && run.state === 'completed') ?? null;
    });
    expect(resumed.tasks[0]?.sessionId).toBe(first.tasks[0]?.sessionId);
    expect(resumed.runtimeOwnerId).toBe('resume-owner');
    await expect(readFile(path.join(fixture.root, resumedRunId!, 'permission.json'), 'utf8'))
      .resolves.toContain('/current-parent');
    await expect(readFile(path.join(fixture.root, resumedRunId!, 'pi-home', 'models.json')))
      .resolves.toEqual(currentModelsJson);
    await expect(readFile(path.join(fixture.root, resumedRunId!, 'cindy-bridge.ts')))
      .resolves.toEqual(currentBridgeSource);
    await expect(readFile(path.join(fixture.root, resumedRunId!, 'runner.cjs')))
      .resolves.toEqual(currentRunnerSource);
    const durableResumeFiles = await Promise.all([
      'config.json',
      'status.json',
      'permission.json',
      path.join('pi-home', 'models.json'),
    ].map((relative) => readFile(path.join(fixture.root, resumedRunId!, relative), 'utf8')));
    expect(durableResumeFiles.every((text) => !text.includes(resumeTokenCanary))).toBe(true);
    const prompts = (await readFile(fixture.promptsFile, 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line) as string);
    expect(prompts.at(-1)).toBe('continue from the prior result');

    const secondResumedRunId = await resumePiSubagentRun(
      fixture.root,
      resumedRunId!,
      'continue for a second resumed generation',
      {
        nodeExecutable: process.execPath,
        runtimeOwnerId: 'resume-owner',
        runnerFallbackFile: fixture.runnerFile,
        env: {
          ...process.env,
          CINDY_PI_SESSION_TOKEN: resumeTokenCanary,
          CINDY_TEST_PI_ARGS: fixture.argsFile,
          CINDY_TEST_PI_PROMPTS: fixture.promptsFile,
          CINDY_TEST_PI_COMMANDS: fixture.commandsFile,
        },
        permissionSnapshot: { mode: 'ask', readOnlyRoots: ['/current-parent'] },
        runtimeSnapshot: {
          modelsJson: currentModelsJson,
          bridgeSource: currentBridgeSource,
          runnerSource: currentRunnerSource,
        },
      },
      resumed.tasks[0]!.childId,
    );
    const secondResumed = await waitFor(async () => {
      const runs = await listPiSubagentRuns(fixture.root);
      return runs.find((run) => run.runId === secondResumedRunId && run.state === 'completed') ?? null;
    });
    expect(secondResumed.tasks[0]?.sessionId).toBe(first.tasks[0]?.sessionId);
    const resumedPrompts = (await readFile(fixture.promptsFile, 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line) as string);
    expect(resumedPrompts.at(-1)).toBe('continue for a second resumed generation');
  });

  it.skipIf(process.platform === 'win32')('refuses a resume catalog redirected through a symlink', async () => {
    const fixture = await makeFixture();
    const first = await waitFor(async () => {
      const runs = await listPiSubagentRuns(fixture.root);
      return runs.find((run) => run.runId === fixture.runId && run.state === 'completed') ?? null;
    });
    await waitForClose(fixture.child, fixture.stderr);
    const outside = path.join(fixture.root, 'outside-pi-home');
    await mkdir(outside);
    await writeFile(path.join(outside, 'models.json'), '{"providers":{"redirected":{}}}\n');
    await rm(path.join(fixture.runDir, 'pi-home'), { recursive: true });
    await symlink(outside, path.join(fixture.runDir, 'pi-home'), 'dir');

    await expect(resumePiSubagentRun(
      fixture.root,
      first.runId,
      'continue from redirected catalog',
      {
        nodeExecutable: process.execPath,
        runtimeOwnerId: 'resume-owner',
        runnerFallbackFile: fixture.runnerFile,
        env: process.env,
        permissionSnapshot: { mode: 'ask', readOnlyRoots: [] },
      },
    )).rejects.toThrow(/runtime artifacts escaped/);
    expect((await listPiSubagentRuns(fixture.root)).map((run) => run.runId)).toEqual([first.runId]);
  });

  it('removes a partially staged resume generation when a private snapshot cannot be serialized', async () => {
    const fixture = await makeFixture();
    const first = await waitFor(async () => {
      const runs = await listPiSubagentRuns(fixture.root);
      return runs.find((run) => run.runId === fixture.runId && run.state === 'completed') ?? null;
    });
    await waitForClose(fixture.child, fixture.stderr);

    await expect(resumePiSubagentRun(
      fixture.root,
      first.runId,
      'continue without leaving partial staging',
      {
        nodeExecutable: process.execPath,
        runtimeOwnerId: 'resume-owner',
        runnerFallbackFile: fixture.runnerFile,
        env: process.env,
        permissionSnapshot: { unserializable: 1n },
      },
    )).rejects.toThrow(/BigInt/);
    const runDirectories = (await readdir(fixture.root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^[0-9a-f-]{36}$/i.test(entry.name))
      .map((entry) => entry.name);
    expect(runDirectories).toEqual([first.runId]);
  });

  it('serializes concurrent resume requests and refuses a second active generation', async () => {
    const followUp = 'hold this resumed generation';
    const fixture = await makeFixture({ hangOnMessage: followUp });
    const first = await waitFor(async () => {
      const runs = await listPiSubagentRuns(fixture.root);
      return runs.find((run) => run.runId === fixture.runId && run.state === 'completed') ?? null;
    });
    await waitForClose(fixture.child, fixture.stderr);
    const launch = {
      nodeExecutable: process.execPath,
      runtimeOwnerId: 'resume-owner',
      runnerFallbackFile: fixture.runnerFile,
      env: {
        ...process.env,
        CINDY_TEST_PI_ARGS: fixture.argsFile,
        CINDY_TEST_PI_PROMPTS: fixture.promptsFile,
        CINDY_TEST_PI_COMMANDS: fixture.commandsFile,
      },
      permissionSnapshot: { mode: 'ask', readOnlyRoots: [] },
    };

    const results = await Promise.all([
      resumePiSubagentRun(fixture.root, first.runId, followUp, launch),
      resumePiSubagentRun(fixture.root, first.taskId, followUp, launch),
    ]);
    const resumedRunId = results.find((value): value is string => typeof value === 'string');
    expect(results.filter((value) => value === null)).toHaveLength(1);
    expect(resumedRunId).toEqual(expect.any(String));
    await waitFor(async () => {
      const run = (await listPiSubagentRuns(fixture.root)).find((entry) => entry.runId === resumedRunId);
      return run?.state === 'running' ? run : null;
    });
    await expect(controlPiSubagentRuns(fixture.root, resumedRunId!, 'stop')).resolves.toBe(1);
    await waitFor(async () => {
      const run = (await listPiSubagentRuns(fixture.root)).find((entry) => entry.runId === resumedRunId);
      return run && (run.state === 'stopped' || run.state === 'failed') ? run : null;
    });
  });

  it('bounds terminal output by UTF-8 bytes before writing status and result files', async () => {
    const fixture = await makeFixture({ outputText: '界'.repeat(200_000) });
    const completed = await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.state === 'completed' ? run : null;
    });
    expect(completed.tasks[0]?.outputTruncated).toBe(true);
    expect(Buffer.byteLength(completed.tasks[0]?.output ?? '', 'utf8')).toBeLessThanOrEqual(256 * 1024);
    expect((completed.tasks[0]?.output ?? '').endsWith('\ud800')).toBe(false);
    await waitForClose(fixture.child, fixture.stderr);
  });

  it('does not launch queued children after the run timeout fires', async () => {
    const fixture = await makeFixture({
      hang: true,
      tasks: 2,
      concurrency: 1,
      timeoutMs: 200,
    });
    const failed = await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.state === 'failed' ? run : null;
    });
    expect(failed.tasks.map((task) => task.status)).toEqual(['failed', 'failed']);
    expect(failed.tasks[1]?.error).toBe('Timed out before launch.');
    const argLines = (await readFile(fixture.argsFile, 'utf8')).trim().split('\n');
    expect(argLines).toHaveLength(1);
    await waitForClose(fixture.child, fixture.stderr);
  });

  it('forwards a child approval response through runner-owned RPC stdin', async () => {
    const fixture = await makeFixture({ approval: true });
    const pending = await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.tasks[0]?.pendingApproval ? run : null;
    });
    expect(pending.tasks[0]?.pendingApproval).toMatchObject({
      id: 'approval-1', method: 'confirm', title: 'cindy:permission',
    });
    await expect(controlPiSubagentRuns(fixture.root, 'tool-fixture', 'approval', {
      childId: pending.tasks[0]?.childId,
      approvalId: 'approval-1',
      confirmed: true,
    })).resolves.toBe(1);
    const completed = await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.state === 'completed' ? run : null;
    });
    expect(completed.tasks[0]?.output).toBe('fixture result');
    await waitForClose(fixture.child, fixture.stderr);
  });

  it('honours a stop that shares a batch with an earlier approval', async () => {
    // The Host cannot decide this ordering. An approval that already passed its
    // account-boundary gate is an fs write in flight, and the teardown's drain
    // waits for it *so that* the sweep can see it — which puts the stop after
    // it on disk. Consumed in write order, the child executed the pending tool
    // call and only then honoured the stop.
    //
    // Written straight into the mailbox rather than through
    // `controlPiSubagentRuns`, because the point is one poll round seeing both:
    // two separate calls let the runner consume the approval in between.
    const fixture = await makeFixture({ approval: true });
    const pending = await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.tasks[0]?.pendingApproval ? run : null;
    });
    const controlsDir = path.join(fixture.runDir, 'controls');
    await mkdir(controlsDir, { recursive: true });
    const write = async (control: Record<string, unknown>): Promise<void> => {
      const requestId = randomUUID();
      await writeFile(
        path.join(controlsDir, `${requestId}.json`),
        `${JSON.stringify({ version: 1, requestId, ...control })}\n`,
        { mode: 0o600 },
      );
    };
    // Approval first by every ordering key the runner sorts on.
    await write({
      seq: 1,
      requestedAt: 1,
      action: 'approval',
      childId: pending.tasks[0]?.childId,
      approvalId: 'approval-1',
      confirmed: true,
    });
    await write({ seq: 2, requestedAt: 2, action: 'stop' });

    const stopped = await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.state === 'stopped' ? run : null;
    });

    // The child never got the go-ahead, so it never produced its result. Same
    // guard covers steer and follow_up: once a stop is applied, every later
    // control for that scope is refused.
    expect(stopped.tasks[0]?.output ?? '').toBe('');
    const commands = (await readCommandsIfPresent(fixture.commandsFile)) ?? [];
    expect(commands).not.toContainEqual(
      expect.objectContaining({ type: 'extension_ui_response', id: 'approval-1' }),
    );
    await waitForClose(fixture.child, fixture.stderr);
  });

  it('refuses to forward an approval once a stop is already waiting', async () => {
    // The batch partition orders one scan; a scan is a snapshot. A stop written
    // while the batch was still executing sits unseen on disk until the next
    // poll — by which time the approval has been forwarded and the child may
    // already be running the command. What is forwarded cannot be recalled, so
    // the sweep's verified kill stays the backstop; this closes the window
    // between consuming a control and acting on it.
    //
    // Written in the order that reproduces it: the approval carries the earlier
    // seq, so the partition would still hand it to the child first — only a
    // fresh look at the mailbox can catch the stop.
    const fixture = await makeFixture({ approval: true });
    const pending = await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.tasks[0]?.pendingApproval ? run : null;
    });
    const controlsDir = path.join(fixture.runDir, 'controls');
    await mkdir(controlsDir, { recursive: true });
    const stopId = randomUUID();
    await writeFile(
      path.join(controlsDir, `${stopId}.json`),
      `${JSON.stringify({ version: 1, requestId: stopId, seq: 2, requestedAt: 2, action: 'stop' })}\n`,
      { mode: 0o600 },
    );
    const approvalId = randomUUID();
    await writeFile(
      path.join(controlsDir, `${approvalId}.json`),
      `${JSON.stringify({
        version: 1,
        requestId: approvalId,
        seq: 1,
        requestedAt: 1,
        action: 'approval',
        childId: pending.tasks[0]?.childId,
        approvalId: 'approval-1',
        confirmed: true,
      })}\n`,
      { mode: 0o600 },
    );

    const stopped = await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.state === 'stopped' ? run : null;
    });

    expect(stopped.tasks[0]?.output ?? '').toBe('');
    const commands = (await readCommandsIfPresent(fixture.commandsFile)) ?? [];
    expect(commands).not.toContainEqual(
      expect.objectContaining({ type: 'extension_ui_response', id: 'approval-1' }),
    );
    await waitForClose(fixture.child, fixture.stderr);
  });

  it('forwards a source-aware child approval value through the durable mailbox', async () => {
    const fixture = await makeFixture({ approval: true, approvalMethod: 'input' });
    const pending = await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.tasks[0]?.pendingApproval ? run : null;
    });
    expect(pending.tasks[0]?.pendingApproval).toMatchObject({
      id: 'approval-1',
      method: 'input',
      title: 'cindy:permission',
      placeholder: expect.stringContaining('"toolName":"write"'),
    });
    await expect(controlPiSubagentRuns(fixture.root, 'tool-fixture', 'approval', {
      childId: pending.tasks[0]?.childId,
      approvalId: 'approval-1',
      value: 'allow',
    })).resolves.toBe(1);
    const completed = await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.state === 'completed' ? run : null;
    });
    expect(completed.tasks[0]?.output).toBe('fixture result');
    await waitForClose(fixture.child, fixture.stderr);
  });

  it('fails closed at the run timeout when no host approval resolver ever responds', async () => {
    const fixture = await makeFixture({ approval: true, timeoutMs: 200 });
    const failed = await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.state === 'failed' ? run : null;
    });
    expect(failed.timedOut).toBe(true);
    expect(failed.tasks[0]).toMatchObject({ status: 'failed' });
    expect(failed.tasks[0]?.error).toMatch(/timed out/i);
    await waitForClose(fixture.child, fixture.stderr);
  });

  it('discards one corrupt mailbox entry without blocking later controls', async () => {
    const fixture = await makeFixture({ hang: true });
    const running = await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.state === 'running' ? run : null;
    });
    const controlsDir = path.join(fixture.runDir, 'controls');
    await mkdir(controlsDir, { recursive: true });
    await writeFile(path.join(controlsDir, `${randomUUID()}.json`), '{not-json', { mode: 0o600 });

    await expect(controlPiSubagentRuns(fixture.root, running.runId, 'steer', {
      message: 'still deliver this',
    })).resolves.toBe(1);
    await waitFor(async () => {
      const commands = await readCommandsIfPresent(fixture.commandsFile);
      return commands?.some((command) => command.type === 'steer' && command.message === 'still deliver this')
        ? true
        : null;
    });
    await expect(controlPiSubagentRuns(fixture.root, running.runId, 'stop')).resolves.toBe(1);
    await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.state === 'stopped' ? run : null;
    });
    await waitForClose(fixture.child, fixture.stderr);
  });

  it('keeps completed output immutable and requires follow-up instead of late steer', async () => {
    const fixture = await makeFixture({ outputThenHang: true });
    // The precondition under test is the *durable status* carrying the child's
    // finished output while the run is still live. Waiting on transcript.jsonl
    // instead raced that write: under CI load the transcript line landed first
    // and the very next assertion read an output that was still undefined.
    // Poll the same record the assertion reads, and let the explicit timeout
    // say what never happened.
    const running = await waitFor(
      async () => {
        const [run] = await listPiSubagentRuns(fixture.root);
        if (run?.state !== 'running') return null;
        return run.tasks[0]?.output === 'fixture result' ? run : null;
      },
      undefined,
      'the child result to land in durable status while the run is still live',
    );
    expect(running.tasks[0]?.output).toBe('fixture result');
    await expect(controlPiSubagentRuns(fixture.root, running.runId, 'steer', {
      childId: running.tasks[0]?.childId,
      message: 'late correction',
    })).resolves.toBe(0);
    await expect(controlPiSubagentRuns(fixture.root, running.runId, 'follow_up', {
      childId: running.tasks[0]?.childId,
      message: 'continue from the completed result',
    })).resolves.toBe(1);
    const commands = (await readCommandsIfPresent(fixture.commandsFile)) ?? [];
    expect(commands).not.toContainEqual(expect.objectContaining({ type: 'steer', message: 'late correction' }));
    expect(commands).toContainEqual(expect.objectContaining({
      type: 'follow_up', message: 'continue from the completed result',
    }));
    await expect(controlPiSubagentRuns(fixture.root, running.runId, 'stop')).resolves.toBe(1);
    const stopped = await waitFor(
      async () => {
        const [run] = await listPiSubagentRuns(fixture.root);
        return run?.state === 'stopped' ? run : null;
      },
      undefined,
      'the stop request to land the run in a stopped state',
    );
    expect(stopped.tasks[0]?.output).toBe('fixture result');
    await waitForClose(fixture.child, fixture.stderr);
  });

  /**
   * POSIX only, after four rounds of budget calibration on the Windows runner:
   * 366 receipts at 90s, 414 at 240s, 456 at 120s, 479 at 240s — a rate that
   * wandered between ~1.7 and ~4 acks/s across runs with no budget reliably
   * covering 512. The runner was healthy every time (stderr empty, the control
   * backlog fully drained); what it cannot do on that disk is complete 513
   * atomic receipt writes, each a temp file plus a rename carrying the Windows
   * share-violation retry, inside any budget worth paying for. Raising it
   * further only lengthens the feedback loop for everyone.
   *
   * Nothing platform-specific is lost. What this pins is the eviction contract
   * — retention bounded at MAX_CONTROL_RECEIPTS, the legacy mailbox not
   * replayed, receipts surviving a drained backlog — and that logic is plain
   * bookkeeping in the runner with no OS-dependent branch. Every POSIX run
   * exercises it in full.
   */
  it.skipIf(process.platform === 'win32')('bounds control dedupe and abandoned receipts without replaying the legacy mailbox', async () => {
    const fixture = await makeFixture({ hang: true });
    const running = await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.state === 'running' ? run : null;
    });
    const legacyRequestId = randomUUID();
    await writeFile(path.join(fixture.runDir, 'control.json'), `${JSON.stringify({
      version: 1,
      seq: Date.now() * 1000,
      requestId: legacyRequestId,
      action: 'steer',
      message: 'legacy direction once',
      requestedAt: Date.now(),
    })}\n`, { mode: 0o600 });
    await waitFor(async () => {
      const commands = await readCommandsIfPresent(fixture.commandsFile);
      return commands?.some((command) => command.type === 'steer' && command.message === 'legacy direction once')
        ? true
        : null;
    });

    const controlsDir = path.join(fixture.runDir, 'controls');
    await Promise.all(Array.from({ length: 513 }, async () => {
      const requestId = randomUUID();
      await writeFile(path.join(controlsDir, `${requestId}.json`), `${JSON.stringify({
        version: 1,
        seq: Date.now() * 1000,
        requestId,
        action: 'unsupported',
        acknowledge: true,
        requestedAt: Date.now(),
      })}\n`, { mode: 0o600 });
    }));
    // Both waits below are bounded by throughput, not by an event: the runner
    // consumes 513 control files one at a time and writes a receipt for each,
    // every one an atomic write (temp file + rename, with the Windows
    // share-violation retry on top). At the 50-100ms per write a Windows CI disk
    // with a realtime scanner attached delivers, that is 26-51s of pure I/O — the
    // suite's 30s default expired mid-pipeline while the runner was healthy.
    await waitFor(
      async () => (await readdir(controlsDir)).length === 0 ? true : null,
      CONTROL_BACKLOG_WAIT_MS,
      'the runner to drain every queued control request',
    );
    // Draining the mailbox is not the same event as publishing the receipts:
    // the runner writes each receipt after consuming its request, so a fixed
    // sleep raced the tail of that work on a loaded runner (CI saw 441/512).
    // 512 is the retained-receipt bound, so waiting for it is deterministic —
    // the cap is what stops the count from ever going past it.
    const receiptsDir = path.join(fixture.runDir, 'control-receipts');
    // Count what the runner itself counts. `readdir` also sees the `.tmp-*`
    // staging files of an atomic write in flight (and any a failed rename left
    // behind on Windows), and those would hold the total off 512 forever.
    const countReceipts = async (): Promise<number> =>
      (await readdir(receiptsDir)).filter((file) => /^[0-9a-f-]{36}\.json$/i.test(file)).length;
    let lastReceiptCount = -1;
    await waitFor(
      async () => {
        lastReceiptCount = await countReceipts();
        return lastReceiptCount === 512 ? true : null;
      },
      CONTROL_BACKLOG_WAIT_MS,
      () => `the retained control receipts to settle at the 512 bound (last count: ${lastReceiptCount})`,
    );

    const commands = (await readCommandsIfPresent(fixture.commandsFile)) ?? [];
    expect(commands.filter((command) => (
      command.type === 'steer' && command.message === 'legacy direction once'
    ))).toHaveLength(1);
    expect(await countReceipts()).toBe(512);

    await expect(controlPiSubagentRuns(fixture.root, running.runId, 'stop')).resolves.toBe(1);
    await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.state === 'stopped' ? run : null;
    });
    await waitForClose(fixture.child, fixture.stderr);
  }, CONTROL_BACKLOG_TEST_TIMEOUT_MS);

  it('stops this owner\'s detached runner at an account boundary and keeps its durable files', async () => {
    const fixture = await makeFixture({ hang: true, runtimeOwnerId: 'owner-a' });
    await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.state === 'running' ? run : null;
    });

    await expect(stopForAccountBoundary(fixture.root, {
      runtimeOwnerId: 'owner-a',
    })).resolves.toBe(true);

    const [stopped] = await listPiSubagentRuns(fixture.root);
    expect(stopped?.state).toBe('stopped');
    // Logout is an ownership boundary, not a data-removal boundary.
    expect(await readFile(path.join(fixture.runDir, 'status.json'), 'utf8')).toContain('"stopped"');
    await waitForClose(fixture.child, fixture.stderr);
  });

  it('leaves a run owned by another runtime alone at an account boundary', async () => {
    const fixture = await makeFixture({ hang: true, runtimeOwnerId: 'owner-a' });
    await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.state === 'running' ? run : null;
    });

    await expect(stopForAccountBoundary(fixture.root, {
      runtimeOwnerId: 'owner-b',
      timeoutMs: 300,
    })).resolves.toBe(true);
    const [untouched] = await listPiSubagentRuns(fixture.root);
    expect(untouched?.state).toBe('running');

    await expect(controlPiSubagentRuns(fixture.root, untouched!.runId, 'stop')).resolves.toBe(1);
    await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.state === 'stopped' ? run : null;
    });
    await waitForClose(fixture.child, fixture.stderr);
  });

  it('kills every launched child before publishing a mid-flight failure terminal', async () => {
    // A parallel lane rejects (poisoned session dir) after a sibling lane has
    // already spawned. Publishing `failed` first would hand the run back to the
    // Host — stop controls ignored, proxy lease released — while that detached
    // child keeps running against the workspace.
    // Lane A runs task 1 to completion, then picks up the poisoned task 3 and
    // throws. Lane B is still parked on task 2's hanging child at that moment,
    // so a real, running child exists when the failure is published.
    //
    // `gateFinishOnPidCount` is what makes that premise a fact rather than a
    // hope: task 1's child does not answer until two children have recorded
    // their pid, so lane A cannot reach the poisoned task before task 2's
    // process is up and on disk. Without it CI saw one pid — task 2 had been
    // spawned (the terminal snapshot records it) but was killed before its
    // freshly booted process wrote anything.
    const fixture = await makeFixture({
      tasks: 3,
      concurrency: 2,
      hangOnMessage: 'task 2',
      poisonSessionDirIndex: 2,
      gateFinishOnPidCount: 2,
    });

    const failed = await waitFor(
      async () => {
        const [run] = await listPiSubagentRuns(fixture.root);
        return run?.state === 'failed' ? run : null;
      },
      undefined,
      'the runner to publish its mid-flight failure terminal',
    );

    // The terminal snapshot itself proves the ordering: the still-running child
    // is already recorded as terminated, which only happens in the kill step
    // that runs before the status is flushed.
    expect(failed.tasks[1]).toMatchObject({ status: 'failed' });
    expect(failed.tasks[1]?.error).toMatch(/Runner failed before this child finished/i);
    expect(failed.tasks.every((task) => task.status !== 'running')).toBe(true);

    const pids = (await readFile(fixture.pidsFile, 'utf8'))
      .trim().split('\n').filter(Boolean).map((line) => Number(line));
    // task 1 ran to completion and task 2 was launched and hung; task 3 never
    // spawned because its launch is what threw.
    expect(pids.length).toBeGreaterThanOrEqual(2);
    await waitFor(
      async () => pids.every((pid) => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'ESRCH';
        }
      }) ? true : null,
      undefined,
      'every launched child process to be gone after the failure terminal',
    );

    // The runner must also stop itself. A launch throw used to leave the task
    // scheduled-but-queued, so every other lane spun on its 10ms retry forever:
    // the run read as finished while this process stayed alive.
    await waitFor(
      async () => (fixture.child.exitCode !== null || fixture.child.signalCode !== null ? true : null),
      undefined,
      'the runner process to exit after publishing its failure terminal',
    );
    expect(fixture.child.exitCode).toBe(1);
  });

  it.skipIf(process.platform === 'win32')(
    'reaps its children and publishes a terminal status when SIGTERMed',
    async () => {
      // This is the link the extension's give-up teardown depends on. Children
      // are spawned into their own process groups, so signalling the runner's
      // group cannot reach them, and their pids are deliberately never written
      // to disk for anyone else to signal. Node also does not run 'exit'
      // handlers for a default-disposition signal — so without an explicit
      // SIGTERM listener the runner dies and its children are orphaned.
      const fixture = await makeFixture({ hang: true, surviveStdinEnd: true });
      await waitFor(
        async () => {
          const [run] = await listPiSubagentRuns(fixture.root);
          return run?.state === 'running' ? run : null;
        },
        undefined,
        'the runner to launch its hanging child',
      );
      const childPid = Number((await readFile(fixture.pidsFile, 'utf8')).trim().split('\n')[0]);
      expect(Number.isSafeInteger(childPid)).toBe(true);

      process.kill(fixture.child.pid!, 'SIGTERM');

      await waitFor(
        async () => {
          try {
            process.kill(childPid, 0);
            return null;
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'ESRCH' ? true : null;
          }
        },
        undefined,
        'the SIGTERMed runner to reap its own child',
      );

      const stopped = await waitFor(
        async () => {
          const [run] = await listPiSubagentRuns(fixture.root);
          return run?.state === 'stopped' ? run : null;
        },
        undefined,
        'the SIGTERMed runner to publish a terminal status',
      );
      expect(stopped.tasks[0]?.error).toMatch(/stopped by SIGTERM/i);
      await waitForClose(fixture.child, fixture.stderr);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'kills an unresponsive runner at the account boundary once its identity checks out',
    async () => {
      // Credential-safety boundary: a durable child inherits direct BYOM
      // credentials that no token revocation reaches, so a runner that stops
      // consuming its stop mailbox cannot just be logged and left running.
      const fixture = await makeFixture({ hang: true, ignoreStopControl: true, runtimeOwnerId: 'owner-a' });
      const running = await waitFor(
        async () => {
          const [run] = await listPiSubagentRuns(fixture.root);
          return run?.state === 'running' ? run : null;
        },
        undefined,
        'the unresponsive runner to publish a running status',
      );
      // Identity is recorded and is the generated script inside this run's dir.
      expect(running.runnerScript).toContain(fixture.runId);
      expect(running.runnerPid).toBe(fixture.child.pid);

      await expect(stopForAccountBoundary(fixture.root, {
        runtimeOwnerId: 'owner-a',
        timeoutMs: 500,
      })).resolves.toBe(true);

      await waitFor(
        async () => {
          try {
            process.kill(fixture.child.pid!, 0);
            return null;
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'ESRCH' ? true : null;
          }
        },
        undefined,
        'the unresponsive runner process to be gone',
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses to signal when the recorded pid is no longer that runner',
    async () => {
      // The pid-reuse guard: a stale record pointing at an unrelated live
      // process must never be signalled. The boundary still *completes* — the
      // recorded runner is provably no longer at that pid, so there is nothing
      // attributable left to reclaim, and reporting failure forever would wedge
      // every logout behind a record that can never be satisfied.
      const fixture = await makeFixture({ hang: true, ignoreStopControl: true, runtimeOwnerId: 'owner-a' });
      await waitFor(
        async () => {
          const [run] = await listPiSubagentRuns(fixture.root);
          return run?.state === 'running' ? run : null;
        },
        undefined,
        'the unresponsive runner to publish a running status',
      );
      // An unrelated live process stands in for a recycled pid.
      const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      });
      try {
        const statusPath = path.join(fixture.runDir, 'status.json');
        const status = JSON.parse(await readFile(statusPath, 'utf8')) as Record<string, unknown>;
        status.runnerPid = bystander.pid;
        await writeFile(statusPath, `${JSON.stringify(status)}\n`, { mode: 0o600 });

        await expect(stopForAccountBoundary(fixture.root, {
          runtimeOwnerId: 'owner-a',
          timeoutMs: 500,
        })).resolves.toBe(true);

        // The invariant that matters, and the one that must never move: the
        // bystander survived, because identity did not match and nothing was
        // sent to that pid.
        expect(() => process.kill(bystander.pid!, 0)).not.toThrow();
      } finally {
        bystander.kill('SIGKILL');
        try { process.kill(fixture.child.pid!, 'SIGKILL'); } catch { /* already gone */ }
      }
    },
  );

  it('stops all owned children before removing durable files on parent deletion', async () => {
    const fixture = await makeFixture({ hang: true, tasks: 2 });
    await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.state === 'running' ? run : null;
    });
    await expect(stopAndRemovePiSubagentRuns(fixture.root)).resolves.toBe(true);
    await expect(listPiSubagentRuns(fixture.root)).resolves.toEqual([]);
    await waitForClose(fixture.child, fixture.stderr);
  });

  it('stops one parallel child without stopping its siblings', async () => {
    const fixture = await makeFixture({ hang: true, tasks: 2 });
    const running = await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.tasks.every((task) => task.status === 'running') ? run : null;
    });
    const firstChildId = running.tasks[0]?.childId;
    const secondChildId = running.tasks[1]?.childId;
    await expect(controlPiSubagentRuns(fixture.root, running.runId, 'stop', {
      childId: firstChildId,
    })).resolves.toBe(1);
    const partial = await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.tasks[0]?.status === 'stopped' && run.tasks[1]?.status === 'running'
        ? run
        : null;
    });
    expect(partial.stopRequested).toBeUndefined();
    await expect(controlPiSubagentRuns(fixture.root, running.runId, 'stop', {
      childId: secondChildId,
    })).resolves.toBe(1);
    await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.state === 'stopped' ? run : null;
    });
    await waitForClose(fixture.child, fixture.stderr);
  });

  it('queues direction for a not-yet-launched child and delivers it after the prompt', async () => {
    const fixture = await makeFixture({ hang: true, tasks: 2, concurrency: 1 });
    const running = await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.tasks[0]?.status === 'running' && run.tasks[1]?.status === 'queued' ? run : null;
    });
    const firstChildId = running.tasks[0]!.childId;
    const secondChildId = running.tasks[1]!.childId;
    await expect(controlPiSubagentRuns(fixture.root, running.runId, 'steer', {
      childId: secondChildId,
      message: 'queued direction',
    })).resolves.toBe(1);
    await expect(controlPiSubagentRuns(fixture.root, running.runId, 'stop', {
      childId: firstChildId,
    })).resolves.toBe(1);
    await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.tasks[1]?.status === 'running' ? run : null;
    }, undefined, 'the queued child to launch');
    // "child is running" and "its queued direction has been written" are two
    // different events; wait for the one the assertions below actually read.
    const commands = await waitFor(
      async () => {
        const parsed = await readCommandsIfPresent(fixture.commandsFile);
        return parsed?.some((command) => command.type === 'steer' && command.message === 'queued direction')
          ? parsed
          : null;
      },
      undefined,
      'the queued direction to reach the child after its prompt',
    );
    const secondPrompt = commands.findIndex((command) => command.type === 'prompt' && command.message === 'task 2');
    const queuedSteer = commands.findIndex((command) => command.type === 'steer' && command.message === 'queued direction');
    expect(secondPrompt).toBeGreaterThan(-1);
    expect(queuedSteer).toBeGreaterThan(secondPrompt);
    await expect(controlPiSubagentRuns(fixture.root, running.runId, 'stop', {
      childId: secondChildId,
    })).resolves.toBe(1);
    await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.state === 'stopped' ? run : null;
    });
    await waitForClose(fixture.child, fixture.stderr);
  });

  it('stops a queued child without ever launching it', async () => {
    const fixture = await makeFixture({ hang: true, tasks: 2, concurrency: 1 });
    const running = await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.tasks[0]?.status === 'running' && run.tasks[1]?.status === 'queued' ? run : null;
    });
    await expect(controlPiSubagentRuns(fixture.root, running.runId, 'stop', {
      childId: running.tasks[1]!.childId,
    })).resolves.toBe(1);
    await expect(controlPiSubagentRuns(fixture.root, running.runId, 'stop', {
      childId: running.tasks[0]!.childId,
    })).resolves.toBe(1);
    const stopped = await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.state === 'stopped' ? run : null;
    });
    expect(stopped.tasks[1]).toMatchObject({ status: 'stopped', error: 'Stopped before launch.' });
    const argLines = (await readFile(fixture.argsFile, 'utf8')).trim().split('\n');
    expect(argLines).toHaveLength(1);
    await waitForClose(fixture.child, fixture.stderr);
  });

  it('stops through the control protocol and records stopped instead of failed', async () => {
    const fixture = await makeFixture({ hang: true });
    await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.state === 'running' ? run : null;
    });
    await expect(controlPiSubagentRuns(fixture.root, 'tool-fixture', 'stop')).resolves.toBe(1);
    const stopped = await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.state === 'stopped' ? run : null;
    });
    expect(stopped.stopRequested).toBe(true);
    expect(stopped.tasks[0]?.status).toBe('stopped');
    await waitForClose(fixture.child, fixture.stderr);
  });
});
