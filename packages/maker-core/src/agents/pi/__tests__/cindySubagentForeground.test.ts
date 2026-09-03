import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';

import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CINDY_SUBAGENT_RUNNER_SOURCE } from '../cindy-subagent-runner-source.js';
import { recordPiSubagentRunnerFailure } from '../pi-subagent-runs.js';
import {
  CINDY_SUBAGENT_ENV,
  CINDY_SUBAGENT_EXTENSION_SOURCE,
} from '../cindy-subagent-source.js';

const roots: string[] = [];
const children = new Set<ChildProcess>();
const require = createRequire(import.meta.url);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-pi-subagent-foreground-'));
  roots.push(root);
  const configHome = path.join(root, 'pi-home');
  const internalExtensions = path.join(configHome, 'internal-extensions');
  const runRoot = path.join(root, 'runs');
  await mkdir(internalExtensions, { recursive: true });
  await mkdir(runRoot, { recursive: true });
  await writeFile(path.join(configHome, 'models.json'), JSON.stringify({
    providers: { fixture: { models: [{ id: 'fixture-model' }] } },
  }));
  await writeFile(path.join(internalExtensions, 'cindy-bridge.ts'), 'export default function () {}\n');
  const permissionFile = path.join(root, 'permission.json');
  const runtimeFile = path.join(root, 'runtime.json');
  const runnerFile = path.join(root, 'runner.cjs');
  const fakePi = path.join(root, 'fake-pi.cjs');
  const extensionFile = path.join(root, 'extension.cjs');
  await writeFile(permissionFile, '{"mode":"ask"}\n');
  await writeFile(runtimeFile, JSON.stringify({
    provider: 'fixture',
    model: 'fixture-model',
    modelRoutes: {
      'fixture-model': [{ provider: 'fixture', model: 'fixture-model' }],
      'xai/grok-4.6': [
        {
          provider: 'xai', model: 'grok-4.6', sourceProviderId: 'xai',
          proxySessionAuth: true,
        },
        { provider: 'cindy', model: 'xai/grok-4.6' },
      ],
      'claude-fable-5': [
        {
          provider: 'anthropic', model: 'claude-fable-5', sourceProviderId: 'anthropic',
          proxySessionAuth: true,
        },
        { provider: 'cindy', model: 'claude-fable-5' },
      ],
    },
  }) + '\n');
  await writeFile(runnerFile, CINDY_SUBAGENT_RUNNER_SOURCE, { mode: 0o700 });
  await writeFile(fakePi, `
'use strict';
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
    if (command.type === 'prompt') {
      process.stdout.write(JSON.stringify({ type: 'response', command: 'prompt', success: true }) + '\\n');
      process.stdout.write(JSON.stringify({
        type: 'extension_ui_request', id: 'approval-foreground', method: 'input',
        title: 'cindy:permission',
        placeholder: JSON.stringify({ toolName: 'write', input: { path: 'a.txt' } }),
      }) + '\\n');
    }
    if (command.type === 'extension_ui_response' && command.id === 'approval-foreground') {
      if (command.value !== 'allow') process.exit(13);
      process.stdout.write(JSON.stringify({ type: 'tool_execution_start', toolName: 'write' }) + '\\n');
      process.stdout.write(JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'foreground approved result:' + process.env.CINDY_PI_SESSION_TOKEN }], usage: { input: 2, output: 3, cost: { total: 0.02 } } },
      }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`, { mode: 0o700 });
  await Promise.all([chmod(runnerFile, 0o700), chmod(fakePi, 0o700)]);
  const compiled = ts.transpileModule(CINDY_SUBAGENT_EXTENSION_SOURCE, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  await writeFile(extensionFile, compiled);
  return { root, configHome, runRoot, permissionFile, runtimeFile, runnerFile, fakePi, extensionFile };
}

function hostInput(f: Awaited<ReturnType<typeof fixture>>, permission = 'allow') {
  const runners = new Map<string, ChildProcess>();
  return vi.fn(async (title: string, placeholder: string) => {
    if (title !== 'cindy:pi-subagent-runner') return permission;
    const request = JSON.parse(placeholder) as { action: 'launch' | 'terminate' | 'status'; runId: string };
    const runDir = path.join(f.runRoot, request.runId);
    if (request.action === 'status') {
      return JSON.stringify({ ok: true });
    }
    if (request.action === 'terminate') {
      const child = runners.get(request.runId);
      if (child) child.kill('SIGTERM');
      return JSON.stringify({ ok: true });
    }
    const child = spawn(process.execPath, [path.join(runDir, 'runner.cjs'), path.join(runDir, 'config.json')], {
      cwd: f.root,
      env: process.env,
      stdio: 'ignore',
    });
    runners.set(request.runId, child);
    children.add(child);
    child.once('close', (code, signal) => {
      runners.delete(request.runId);
      children.delete(child);
      void recordPiSubagentRunnerFailure(
        runDir,
        `Durable runner exited${signal ? ` with signal ${signal}` : ''}`
          + (typeof code === 'number' ? ` with code ${code}` : ''),
      );
    });
    return new Promise<string>((resolve) => {
      child.once('spawn', () => resolve(JSON.stringify({ ok: true })));
      child.once('error', () => resolve(JSON.stringify({ ok: false })));
    });
  });
}

afterEach(async () => {
  for (const child of children) child.kill('SIGKILL');
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Cindy PI Subagent foreground durable path', () => {
  it.skipIf(process.platform === 'win32')(
    'waits for the runner and forwards Ask approval through the parent UI',
    async () => {
    const f = await fixture();
    const previous = { ...process.env };
    Object.assign(process.env, {
      [CINDY_SUBAGENT_ENV.binary]: process.execPath,
      [CINDY_SUBAGENT_ENV.depth]: '0',
      [CINDY_SUBAGENT_ENV.runtimeFile]: f.runtimeFile,
      [CINDY_SUBAGENT_ENV.runRoot]: f.runRoot,
      [CINDY_SUBAGENT_ENV.runnerFile]: f.runnerFile,
      [CINDY_SUBAGENT_ENV.ownerId]: 'foreground-owner',
      CINDY_PI_PERMISSION_FILE: f.permissionFile,
      CINDY_PI_SESSION_ID: 'parent-session',
      CINDY_PI_SESSION_TOKEN: 'parent-session-token-1234567890abcdef',
      PI_CODING_AGENT_DIR: f.configHome,
    });
    const registered: {
      execute?: (
        toolCallId: string,
        params: unknown,
        signal: AbortSignal,
        onUpdate: (value: unknown) => void,
        context: unknown,
      ) => Promise<{ content: Array<{ text: string }> }>;
    } = {};
    try {
      const expectedRouteToken = createHmac(
        'sha256',
        'parent-session-token-1234567890abcdef',
      ).update('cindy.pi.subagent-route\0anthropic').digest('base64url');
      // The generated runner supports a binary prefix only in tests. Wrap Node
      // so the extension's configured binary launches the fake PI script.
      const wrapper = path.join(f.root, process.platform === 'win32' ? 'pi-wrapper.cmd' : 'pi-wrapper');
      await writeFile(
        wrapper,
        process.platform === 'win32'
          ? `@echo off\r\n"${process.execPath}" "${f.fakePi}" %*\r\n`
          : `#!/bin/sh\nexec "${process.execPath}" "${f.fakePi}" "$@"\n`,
      );
      process.env[CINDY_SUBAGENT_ENV.binary] = wrapper;
      await chmod(wrapper, 0o700);
      const extension = require(f.extensionFile).default as (pi: { registerTool: (tool: unknown) => void }) => Promise<void>;
      await extension({ registerTool: (tool) => Object.assign(registered, tool) });
      expect(registered.execute).toBeTypeOf('function');
      const input = hostInput(f);
      const result = await registered.execute!(
        'tool-foreground',
        { agent: 'worker', task: 'write the fixture', model: 'claude-fable-5' },
        new AbortController().signal,
        () => undefined,
        { ui: { input }, sessionManager: { getBranch: () => [] } },
      );
      expect(input).toHaveBeenCalledWith('cindy:permission', expect.stringContaining('write'));
      expect(result.content[0].text).toContain(
        `foreground approved result:${expectedRouteToken}`,
      );
      const [runId] = await readdir(f.runRoot);
      const configText = await readFile(path.join(f.runRoot, runId, 'config.json'), 'utf8');
      const config = JSON.parse(configText);
      expect(config.tasks[0]).toMatchObject({
        provider: 'anthropic',
        model: 'claude-fable-5',
        displayModel: 'claude-fable-5',
        sourceProviderId: 'anthropic',
        proxySessionAuth: true,
      });
      expect(config.tasks[0]).not.toHaveProperty('proxySessionToken');
      expect(configText).not.toContain('parent-session-token-1234567890abcdef');
      expect(configText).not.toContain(expectedRouteToken);
      expect(await readFile(f.runtimeFile, 'utf8')).not.toContain('Token');
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
    }
    },
    15_000,
  );

  it.skipIf(process.platform === 'win32')(
    'fails promptly when the runner exits before its first status snapshot',
    async () => {
      const f = await fixture();
      await writeFile(f.runnerFile, "'use strict'; process.exit(7);\n", { mode: 0o700 });
      const previous = { ...process.env };
      Object.assign(process.env, {
        [CINDY_SUBAGENT_ENV.binary]: process.execPath,
        [CINDY_SUBAGENT_ENV.depth]: '0',
        [CINDY_SUBAGENT_ENV.runtimeFile]: f.runtimeFile,
        [CINDY_SUBAGENT_ENV.runRoot]: f.runRoot,
        [CINDY_SUBAGENT_ENV.runnerFile]: f.runnerFile,
        [CINDY_SUBAGENT_ENV.ownerId]: 'foreground-owner',
        CINDY_PI_PERMISSION_FILE: f.permissionFile,
        CINDY_PI_SESSION_ID: 'parent-session',
        PI_CODING_AGENT_DIR: f.configHome,
      });
      const registered: { execute?: (...args: unknown[]) => Promise<unknown> } = {};
      try {
        const extension = require(f.extensionFile).default as (pi: { registerTool: (tool: unknown) => void }) => Promise<void>;
        await extension({ registerTool: (tool) => Object.assign(registered, tool) });
        const input = hostInput(f);
        const execution = registered.execute!(
          'tool-runner-exit',
          { agent: 'scout', task: 'inspect the fixture' },
          new AbortController().signal,
          () => undefined,
          { ui: { input }, sessionManager: { getBranch: () => [] } },
        );
        await expect(Promise.race([
          execution,
          new Promise((_, reject) => setTimeout(() => reject(new Error('foreground wait hung')), 5_000)),
        ])).rejects.toThrow(/Durable runner exited.*code 7/i);
      } finally {
        for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
        Object.assign(process.env, previous);
      }
    },
    10_000,
  );

  it.skipIf(process.platform === 'win32')(
    'ends the parent turn on a bounded stop deadline when an aborted runner never answers',
    async () => {
      // Regression: the abort branch consumed the single stopWritten latch
      // without arming a deadline, so the run-deadline branch could never arm
      // one either. A runner that never consumes the control file left the
      // parent turn polling forever with no way to finish cancelling.
      const f = await fixture();
      // Wedged runner: publishes a running status, ignores every control, and
      // stays alive so the "runner exited" fallback cannot rescue the wait.
      await writeFile(f.runnerFile, `
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const now = Date.now();
// Recorded separately: the synthetic terminal status the extension writes on
// give-up replaces status.json, so the pid has to survive that convergence.
fs.writeFileSync(path.join(config.runDir, 'runner-pid'), String(process.pid));
fs.writeFileSync(path.join(config.runDir, 'status.json'), JSON.stringify({
  version: 1, runId: config.runId, taskId: config.taskId,
  parentSessionId: config.parentSessionId, runnerInstanceId: 'wedged-fixture',
  runnerPid: process.pid, state: 'running', startedAt: now, updatedAt: now,
  tasks: config.tasks.map((task) => ({
    childId: task.childId, sessionId: task.sessionId, agent: task.agent, status: 'running',
  })),
}) + '\\n');
setInterval(() => {}, 1000);
setTimeout(() => process.exit(0), 20000).unref();
`, { mode: 0o700 });
      const previous = { ...process.env };
      Object.assign(process.env, {
        [CINDY_SUBAGENT_ENV.binary]: process.execPath,
        [CINDY_SUBAGENT_ENV.depth]: '0',
        [CINDY_SUBAGENT_ENV.runtimeFile]: f.runtimeFile,
        [CINDY_SUBAGENT_ENV.runRoot]: f.runRoot,
        [CINDY_SUBAGENT_ENV.runnerFile]: f.runnerFile,
        [CINDY_SUBAGENT_ENV.ownerId]: 'foreground-owner',
        CINDY_PI_PERMISSION_FILE: f.permissionFile,
        CINDY_PI_SESSION_ID: 'parent-session',
        PI_CODING_AGENT_DIR: f.configHome,
      });
      const registered: { execute?: (...args: unknown[]) => Promise<unknown> } = {};
      const controller = new AbortController();
      try {
        const extension = require(f.extensionFile).default as (pi: { registerTool: (tool: unknown) => void }) => Promise<void>;
        await extension({ registerTool: (tool) => Object.assign(registered, tool) });
        const input = hostInput(f);
        const startedAt = Date.now();
        const execution = registered.execute!(
          'tool-abort-wedged-runner',
          { agent: 'scout', task: 'inspect the fixture' },
          controller.signal,
          () => undefined,
          { ui: { input }, sessionManager: { getBranch: () => [] } },
        );
        setTimeout(() => controller.abort(), 50);
        // The bound is the 5s stop grace, not the run deadline (which is at
        // least 25s out) and not the runner exiting (it does not).
        await expect(Promise.race([
          execution,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('parent turn polled past its stop deadline')), 20_000)),
        ])).rejects.toThrow(/did not acknowledge the cancellation/i);
        expect(Date.now() - startedAt).toBeLessThan(15_000);

        // Giving up on the wait is not enough: the retained runner must really
        // be gone, or it keeps editing the workspace for up to its own 24h
        // bound while the caller reports the task as stopped.
        const runId = (await readdir(f.runRoot))[0]!;
        const runnerPid = Number(await readFile(path.join(f.runRoot, runId, 'runner-pid'), 'utf8'));
        expect(Number.isSafeInteger(runnerPid)).toBe(true);
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try {
            process.kill(runnerPid, 0);
          } catch (error) {
            expect((error as NodeJS.ErrnoException).code).toBe('ESRCH');
            break;
          }
          if (attempt === 99) throw new Error('retained runner process survived the stop deadline');
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        // Durable state converges with the real processes: nothing may be left
        // reading as running, or the panel hides the stop control forever.
        const converged = JSON.parse(
          await readFile(path.join(f.runRoot, runId, 'status.json'), 'utf8'),
        ) as { state: string };
        expect(['failed', 'stopped', 'completed']).toContain(converged.state);
      } finally {
        for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
        Object.assign(process.env, previous);
      }
    },
    30_000,
  );

  it.skipIf(process.platform === 'win32')(
    'delivers abort before the runner has written its first status snapshot',
    async () => {
      const f = await fixture();
      await writeFile(f.runnerFile, `
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let settled = false;
const publishStopped = () => {
  if (settled) return;
  settled = true;
  const now = Date.now();
  const status = {
    version: 1, runId: config.runId, taskId: config.taskId,
    parentSessionId: config.parentSessionId, runnerInstanceId: 'abort-fixture',
    state: 'stopped', startedAt: now, updatedAt: now, endedAt: now,
    tasks: config.tasks.map((task) => ({
      childId: task.childId, sessionId: task.sessionId, agent: task.agent,
      status: 'stopped', error: 'stopped before first status', endedAt: now,
    })),
  };
  fs.writeFileSync(path.join(config.runDir, 'status.json'), JSON.stringify(status) + '\\n');
  process.exit(0);
};
process.on('SIGTERM', publishStopped);
const timer = setInterval(() => {
  let files = [];
  try { files = fs.readdirSync(path.join(config.runDir, 'controls')); } catch {}
  for (const file of files) {
    const control = JSON.parse(fs.readFileSync(path.join(config.runDir, 'controls', file), 'utf8'));
    if (control.action !== 'stop') continue;
    clearInterval(timer);
    publishStopped();
  }
}, 20);
// Publish readiness only after the stop-control poller is installed. Writing
// this before setInterval leaves a small CI race where the parent aborts while
// this fixture is still initializing and observes only the process exit.
fs.writeFileSync(path.join(config.runDir, 'started'), '1');
setTimeout(() => process.exit(2), 5000).unref();
`, { mode: 0o700 });
      const previous = { ...process.env };
      Object.assign(process.env, {
        [CINDY_SUBAGENT_ENV.binary]: process.execPath,
        [CINDY_SUBAGENT_ENV.depth]: '0',
        [CINDY_SUBAGENT_ENV.runtimeFile]: f.runtimeFile,
        [CINDY_SUBAGENT_ENV.runRoot]: f.runRoot,
        [CINDY_SUBAGENT_ENV.runnerFile]: f.runnerFile,
        [CINDY_SUBAGENT_ENV.ownerId]: 'foreground-owner',
        CINDY_PI_PERMISSION_FILE: f.permissionFile,
        CINDY_PI_SESSION_ID: 'parent-session',
        PI_CODING_AGENT_DIR: f.configHome,
      });
      const registered: { execute?: (...args: unknown[]) => Promise<unknown> } = {};
      const controller = new AbortController();
      try {
        const extension = require(f.extensionFile).default as (pi: { registerTool: (tool: unknown) => void }) => Promise<void>;
        await extension({ registerTool: (tool) => Object.assign(registered, tool) });
        const input = hostInput(f);
        const execution = registered.execute!(
          'tool-abort-before-status',
          { agent: 'scout', task: 'inspect the fixture' },
          controller.signal,
          () => undefined,
          { ui: { input }, sessionManager: { getBranch: () => [] } },
        );
        // Abort only after the runner is up. A 50ms timer races spawn and the
        // parent reports "Durable runner exited" instead of the stop status.
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try {
            const runId = (await readdir(f.runRoot))[0];
            if (runId) await readFile(path.join(f.runRoot, runId, 'started'));
            if (runId) break;
          } catch {
            /* not yet */
          }
          if (attempt === 99) throw new Error('runner did not publish started sentinel');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        controller.abort();
        await expect(execution).rejects.toThrow(/stopped before first status/i);
      } finally {
        for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
        Object.assign(process.env, previous);
      }
    },
    10_000,
  );
});
