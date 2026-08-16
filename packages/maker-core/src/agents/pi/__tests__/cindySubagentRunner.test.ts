import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CINDY_SUBAGENT_RUNNER_SOURCE } from '../cindy-subagent-runner-source.js';
import {
  controlPiSubagentRuns,
  listPiSubagentRuns,
  resumePiSubagentRun,
  stopAndRemovePiSubagentRuns,
} from '../pi-subagent-runs.js';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-pi-runner-'));
  roots.push(root);
  return root;
}

async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() >= deadline) throw new Error('timed out waiting for runner state');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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
  modelError?: boolean;
  retryThenSucceed?: boolean;
  hangOnMessage?: string;
  delayExitAfterInputEndMs?: number;
} = {}) {
  const root = await tempRoot();
  const runId = randomUUID();
  const runDir = path.join(root, runId);
  const sessions = path.join(runDir, 'sessions');
  const childConfigHome = path.join(runDir, 'pi-home');
  await mkdir(sessions, { recursive: true });
  await mkdir(childConfigHome, { recursive: true });
  await writeFile(path.join(childConfigHome, 'models.json'), '{"providers":{}}\n');
  const runnerFile = path.join(root, 'runner.cjs');
  const fakePiFile = path.join(root, 'fake-pi.cjs');
  const bridgeFile = path.join(runDir, 'cindy-bridge.ts');
  const permissionFile = path.join(runDir, 'permission.json');
  const argsFile = path.join(root, 'args.jsonl');
  const promptsFile = path.join(root, 'prompts.jsonl');
  const commandsFile = path.join(root, 'commands.jsonl');
  const stdinEndedFile = path.join(root, 'stdin-ended');
  const tokensFile = path.join(root, 'tokens.jsonl');
  await writeFile(runnerFile, CINDY_SUBAGENT_RUNNER_SOURCE, { mode: 0o700 });
  await chmod(runnerFile, 0o700);
  await writeFile(bridgeFile, 'export default function () {}\n');
  await writeFile(permissionFile, '{"mode":"ask"}\n');
  const fixtureOutput = JSON.stringify(options.outputText ?? 'fixture result');
  const fixtureLifecycle = options.hang
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
const subagentRunDir = process.env.CINDY_PI_SUBAGENT_RUN_DIR;
if (!subagentRunDir || path.dirname(subagentRunDir) !== ${JSON.stringify(root)} ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(path.basename(subagentRunDir))) {
  process.exit(12);
}
fs.appendFileSync(process.env.CINDY_TEST_PI_ARGS, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.CINDY_TEST_PI_TOKENS) {
  fs.appendFileSync(process.env.CINDY_TEST_PI_TOKENS, JSON.stringify(process.env.CINDY_PI_SESSION_TOKEN || null) + '\\n');
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
    ? `process.stdout.write(JSON.stringify({ type: 'extension_ui_request', id: 'approval-1', method: 'confirm', title: 'cindy:permission', message: JSON.stringify({ toolName: 'write', input: { path: 'a.txt' } }) }) + '\\n');`
    : `${options.hangOnMessage ? `if (command.message !== ${JSON.stringify(options.hangOnMessage)}) {` : ''}
      process.stdout.write(JSON.stringify({ type: 'tool_execution_start', toolName: 'read' }) + '\\n');
      ${fixtureLifecycle}
      ${options.hangOnMessage ? '}' : ''}`}
    }
    if (command.type === 'extension_ui_response' && command.id === 'approval-1') {
      if (command.confirmed) {
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
  setTimeout(() => process.exit(0), ${Math.max(0, options.delayExitAfterInputEndMs ?? 0)});
});
`, { mode: 0o700 });
  await chmod(fakePiFile, 0o700);
  const count = options.tasks ?? 1;
  const config = {
    version: 1,
    runId,
    taskId: 'tool-fixture',
    parentSessionId: 'parent-fixture',
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
      sessionDir: sessions,
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
  const child = spawn(process.execPath, [runnerFile, configPath], {
    cwd: root,
    env: {
      ...process.env,
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
  return {
    root, runId, runDir, argsFile, promptsFile, commandsFile, stdinEndedFile, tokensFile,
    child, stderr: () => stderr,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Cindy durable PI Subagent runner', () => {
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
    expect((await readFile(fixture.tokensFile, 'utf8')).trim().split('\n').map(JSON.parse)).toEqual([null, null]);
    await waitForClose(fixture.child, fixture.stderr);
  });

  it('records a zero-exit model failure as failed instead of completed with empty usage', async () => {
    const fixture = await makeFixture({ modelError: true });
    const failed = await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.state === 'failed' ? run : null;
    });
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

  it('resumes a terminal generation with the same PI child session id', async () => {
    const fixture = await makeFixture();
    const first = await waitFor(async () => {
      const runs = await listPiSubagentRuns(fixture.root);
      return runs.find((run) => run.runId === fixture.runId && run.state === 'completed') ?? null;
    });
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
        runnerFallbackFile: path.join(fixture.root, 'runner.cjs'),
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
        runnerFallbackFile: path.join(fixture.root, 'runner.cjs'),
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
        runnerFallbackFile: path.join(fixture.root, 'runner.cjs'),
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
        runnerFallbackFile: path.join(fixture.root, 'runner.cjs'),
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
      runnerFallbackFile: path.join(fixture.root, 'runner.cjs'),
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
      const commands = (await readFile(fixture.commandsFile, 'utf8'))
        .trim().split('\n').map((line) => JSON.parse(line) as { type?: string; message?: string });
      return commands.some((command) => command.type === 'steer' && command.message === 'still deliver this')
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

  it('bounds control dedupe and abandoned receipts without replaying the legacy mailbox', async () => {
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
      const commands = (await readFile(fixture.commandsFile, 'utf8'))
        .trim().split('\n').map((line) => JSON.parse(line) as { type?: string; message?: string });
      return commands.some((command) => command.type === 'steer' && command.message === 'legacy direction once')
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
    await waitFor(async () => (await readdir(controlsDir)).length === 0 ? true : null);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const commands = (await readFile(fixture.commandsFile, 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line) as { type?: string; message?: string });
    expect(commands.filter((command) => (
      command.type === 'steer' && command.message === 'legacy direction once'
    ))).toHaveLength(1);
    expect(await readdir(path.join(fixture.runDir, 'control-receipts'))).toHaveLength(512);

    await expect(controlPiSubagentRuns(fixture.root, running.runId, 'stop')).resolves.toBe(1);
    await waitFor(async () => {
      const [run] = await listPiSubagentRuns(fixture.root);
      return run?.state === 'stopped' ? run : null;
    });
    await waitForClose(fixture.child, fixture.stderr);
  });

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
    });
    const commands = (await readFile(fixture.commandsFile, 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line) as { type?: string; message?: string });
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
