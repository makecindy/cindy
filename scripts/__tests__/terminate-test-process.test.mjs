import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { terminateTestProcess } from '../shared/terminate-test-process.mjs';

test('kills a test probe and its detached browser-like descendant', { timeout: 10_000 }, async () => {
  const probe = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    console.log(descendant.pid);
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'ignore'] });
  let descendant;
  try {
    const [data] = await once(probe.stdout, 'data');
    descendant = Number(String(data).trim());
    assert.ok(Number.isSafeInteger(descendant) && descendant > 0);
    const closed = once(probe, 'close');
    terminateTestProcess(probe);
    await closed;
    const running = () => { try { process.kill(descendant, 0); return true; } catch { return false; } };
    for (let i = 0; i < 100 && running(); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(running(), false);
    terminateTestProcess(probe); // Settled children cannot target a reused PID.
  } finally {
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch {} }
    if (probe.exitCode === null && probe.signalCode === null) probe.kill('SIGKILL');
  }
});
