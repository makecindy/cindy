import type { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { runGetCommands } from './pi-rpc-test-harness.js';

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createFixture(prefix: string) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  fixtureRoots.push(root);
  const configHome = path.join(root, 'config-home');
  const workingDir = path.join(root, 'project');
  const sessionDir = path.join(root, 'sessions');
  // Lifecycle probes only need isolated paths, not a Git repository or Pi resources.
  for (const dir of [configHome, workingDir, sessionDir]) mkdirSync(dir, { recursive: true });
  return { root, configHome, workingDir, sessionDir };
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
    const fixture = createFixture('pi-rpc-missing-');
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
    const fixture = createFixture('pi-rpc-timeout-');
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
    const fixture = createFixture('pi-rpc-startup-timeout-');
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
    const fixture = createFixture('pi-rpc-kill-');
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
    const fixture = createFixture('pi-rpc-exit-');
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
    const fixture = createFixture('pi-rpc-invalid-');
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
