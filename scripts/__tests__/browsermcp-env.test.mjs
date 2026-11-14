// Unit regression for PR #10531: startBrowserMcpEnv must reject spawn failures and
// finish process shutdown before callers remove the profile. No existing benchmark
// tests cover this entry. Minimal inputs: ENOENT, signal exit, ignored SIGTERM,
// and no host discovery. Mock process events/time; never launch a real browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startBrowserMcpEnv } from '../benchmarks/browsermcp-env.mjs';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

for (const scenario of ['spawn-error', 'normal-stop', 'force-stop', 'kill-timeout', 'startup-timeout', 'signal-exit']) {
  test(`BrowserMCP lifecycle: ${scenario}`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-browsermcp-test-'));
    const listeners = process.listenerCount('exit');
    const oldCheckout = process.env.BROWSERMCP_DIR;
    const oldChrome = process.env.BROWSERMCP_CHROME;
    process.env.BROWSERMCP_DIR = dir;
    process.env.BROWSERMCP_CHROME = 'mock-chrome';
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const chrome = Object.assign(new EventEmitter(), {
      pid: scenario === 'spawn-error' ? undefined : 123,
      exitCode: null, signalCode: null, stderr: new EventEmitter(),
    });
    const signals = [];
    const exit = (signal) => { chrome.signalCode = signal; chrome.emit('exit', null, signal); };
    chrome.kill = (signal) => {
      signals.push(signal);
      if (scenario !== 'kill-timeout' && (signal === 'SIGKILL' || scenario === 'normal-stop')) {
        queueMicrotask(() => exit(signal));
      }
      return true;
    };
    const spawnError = Object.assign(new Error('spawn mock-chrome ENOENT'), { code: 'ENOENT' });
    t.mock.method(childProcess, 'spawn', () => {
      queueMicrotask(() => {
        chrome.emit(scenario === 'spawn-error' ? 'error' : 'spawn', spawnError);
        if (scenario === 'signal-exit') exit('SIGSEGV');
      });
      return chrome;
    });
    syncBuiltinESMExports();
    // Discovery is file-based in production; use the actual record for the active paths.
    if (!['spawn-error', 'startup-timeout', 'signal-exit'].includes(scenario)) {
      const run = path.join(dir, 'home/.browsermcp/run');
      fs.mkdirSync(run, { recursive: true });
      fs.writeFileSync(path.join(run, 'host.json'), '{}');
    }
    try {
      const starting = startBrowserMcpEnv(dir);
      if (scenario === 'spawn-error') {
        await assert.rejects(starting, (error) => error === spawnError);
      } else if (scenario === 'signal-exit') {
        await assert.rejects(starting, /Chrome exited/);
      } else if (scenario === 'startup-timeout') {
        const rejected = assert.rejects(starting, /host never connected/);
        await flush();
        t.mock.timers.tick(30_000);
        await flush();
        t.mock.timers.tick(2000);
        await rejected;
        assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
      } else {
        const env = await starting;
        let stopped = false;
        const stopping = env.stop().then(() => { stopped = true; });
        const result = scenario === 'kill-timeout' ? assert.rejects(stopping, /did not exit/) : stopping;
        assert.equal(stopped, false);
        await flush();
        if (scenario !== 'normal-stop') {
          assert.equal(stopped, false);
          t.mock.timers.tick(2000);
          await flush();
          if (scenario === 'kill-timeout') t.mock.timers.tick(2000);
        }
        await result;
        assert.deepEqual(signals, scenario === 'normal-stop' ? ['SIGTERM'] : ['SIGTERM', 'SIGKILL']);
        if (scenario === 'kill-timeout') exit('SIGKILL');
        else await env.stop(); // Already exited: no extra signal, even when exitCode is null.
      }
      await flush();
      assert.equal(process.listenerCount('exit'), listeners);
    } finally {
      process.env.BROWSERMCP_DIR = oldCheckout;
      process.env.BROWSERMCP_CHROME = oldChrome;
      if (oldCheckout === undefined) delete process.env.BROWSERMCP_DIR;
      if (oldChrome === undefined) delete process.env.BROWSERMCP_CHROME;
      t.mock.restoreAll();
      syncBuiltinESMExports();
      t.mock.timers.reset();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
