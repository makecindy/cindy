// Unit: exercise the production private-pipe monitor, not OS permission changes.
// A dead/stale worker must never authorize foreground input as "idle".
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHostPowerMonitor } from './power.mjs';

async function fixture(t, sample = { known: true, idle: 42, state: 'active' }) {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'host-power-unit-'));
  const child = Object.assign(new EventEmitter(), { pid: 1234567, stdin: new PassThrough(), stdout: new PassThrough() });
  const send = value => child.stdout.write(`${JSON.stringify(value)}\n`);
  let hold = false;
  child.stdin.on('data', bytes => {
    const request = JSON.parse(String(bytes));
    if (!hold) send({ id: request.id, result: sample });
  });
  child.kill = () => { child.emit('exit', null, 'SIGTERM'); return true; };
  child.stdin.on('finish', () => child.emit('exit', 0, null));
  const monitor = await createHostPowerMonitor({ profileDir, binary: '/test/trusted-worker', script: '/test/power.cjs',
    spawnImpl: (_binary, _args, options) => {
      assert.equal(options.stdio[0], 'pipe');
      assert.equal(options.env.CINDY_HOST_API, undefined);
      queueMicrotask(() => send({ ready: true, pid: child.pid }));
      return child;
    },
  });
  t.after(async () => { await monitor.close(); await fs.rm(profileDir, { recursive: true, force: true }); });
  return { monitor, child, send, hold: () => { hold = true; } };
}

test('power monitor only exposes fresh OS facts and invalidates them on lock changes', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  const { monitor, send } = await fixture(t);
  assert.throws(() => monitor.assertAvailable(), /STALE/);
  await monitor.refresh();
  assert.equal(monitor.getSystemIdleTime(), 42);
  t.mock.timers.tick(1001);
  assert.throws(() => monitor.getSystemIdleTime(), /STALE/);
  await monitor.refresh();
  let locks = 0;
  monitor.on('lock-screen', () => locks++);
  send({ event: 'lock-screen' });
  assert.equal(locks, 1);
  assert.throws(() => monitor.getSystemIdleState(), /STALE/);
});

test('unknown lock state is not converted into an unlocked desktop', async t => {
  const { monitor } = await fixture(t, { known: false, idle: 10000, state: 'active' });
  await assert.rejects(monitor.refresh(), /STATE_UNKNOWN/);
  assert.throws(() => monitor.assertAvailable(), /STALE/);
});

test('worker exit cancels pending reads without respawning or replaying them', async t => {
  const { monitor, child, hold } = await fixture(t);
  await monitor.refresh();
  hold();
  const pending = monitor.refresh();
  const rejected = assert.rejects(pending, /UNAVAILABLE/);
  child.emit('exit', 1, null);
  await rejected;
  await assert.rejects(monitor.refresh(), /UNAVAILABLE/);
  assert.throws(() => monitor.assertAvailable(), /STALE/);
});


test('a lock event received after a sample prevents the pending refresh from reviving it', async t => {
  const { monitor, child, hold } = await fixture(t);
  hold();
  let request;
  child.stdin.on('data', bytes => { request = JSON.parse(String(bytes)); });
  const refreshing = monitor.refresh();
  const rejected = assert.rejects(refreshing, /STATE_CHANGED/);
  child.stdout.write(`${JSON.stringify({ id: request.id, result: { known: true, idle: 99, state: 'active' } })}\n${JSON.stringify({ event: 'lock-screen' })}\n`);
  await rejected;
  assert.throws(() => monitor.assertAvailable(), /STALE/);
});
