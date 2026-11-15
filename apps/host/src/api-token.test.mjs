import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isAuthorized, readOrCreateApiToken } from './api-token.mjs';
import { publishHostEndpoint, readHostEndpoint, readHostProcessStatus, requestHostStop } from './control.mjs';
import { existingHost, ensureBackgroundHost } from './background.mjs';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';

test('attachment status rejects a live endpoint with a different authenticated PID', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-identity-'));
  t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
  const token = readOrCreateApiToken(dir);
  let pid = process.pid + 1;
  const server = createServer((req,res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({clientProtocol:1,instanceId:'fixture',pid}));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  publishHostEndpoint(dir,`http://127.0.0.1:${server.address().port}`,'fixture');
  assert.equal((await readHostProcessStatus(dir)).running,null);
  pid = process.pid;
  assert.equal((await readHostProcessStatus(dir)).running,true);
});

// Lifecycle regression (unit): the dev wrapper used to kill its Host when the
// desktop exited. Token/endpoint tests did not exercise launcher ownership.
// Real terminal/process survival is covered separately in lifecycle.e2e.mjs.
test('background attachment authenticates an existing instance and refuses uncertain ownership', async () => {
  const endpoint = { pid: 42, baseUrl: 'http://127.0.0.1:3456', instanceId: 'fixture' };
  const deps = { readEndpoint: () => endpoint, processExists: () => true,
    status: async () => ({ ...endpoint, running: true, clientProtocol: 1 }) };
  assert.equal((await existingHost('/fixture', deps)).instanceId, 'fixture');
  for (const status of [{ running: null }, { ...endpoint, running: true, instanceId: 'replacement' }]) {
    await assert.rejects(existingHost('/fixture', { ...deps, status: async () => status }), /could not be verified/);
  }
  assert.equal(await existingHost('/fixture', { ...deps, processExists: () => false }), null);
  await assert.rejects(existingHost('/fixture', { ...deps, readEndpoint: () => ({ ...endpoint, instanceId: null }) }), /no instance identity/);
  await assert.rejects(existingHost('/fixture', { ...deps, status: async () => ({...endpoint,running:true}) }), /pinned client attachment/);
});

test('background launcher detaches stdio and preserves the Host on timeout, error and reuse', async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-background-unit-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  let launched, unrefs = 0, signals = 0, tick = 0, reads = 0;
  const child = Object.assign(new EventEmitter(), { pid: 42, exitCode: null, signalCode: null,
    unref() { unrefs++; }, kill() { signals++; } });
  const options = { profile, command: '/fixture/node', args: ['host'], cwd: profile, timeoutMs: 10,
    env: { CINDY_PERSONAL_MONITOR_DIR: '/live-monitor', CINDY_PERSONAL_GENERATION: 'live', CINDY_HOST_API: 'old' } };
  const ready = { running: true, pid: 42, baseUrl: 'http://127.0.0.1:3456', instanceId: 'fixture' };
  const deps = { existingHost: async () => ++reads > 1 ? ready : null,
    spawn: (_command, _args, value) => { launched = value; return child; }, now: () => tick,
    wait: async () => { tick += 10; } };
  assert.equal((await ensureBackgroundHost(options, deps)).started, true);
  assert.equal(unrefs, 1);
  assert.equal(launched.detached, true);
  assert.equal(launched.stdio[0], 'ignore');
  assert.equal(launched.env.CINDY_PERSONAL_MONITOR_DIR, undefined);
  assert.equal(launched.env.CINDY_PERSONAL_GENERATION, undefined);
  assert.equal(launched.env.CINDY_HOST_API, undefined);
  assert.equal(launched.env.CINDY_HOST_DATA_DIR, profile);
  assert.equal((await ensureBackgroundHost(options, { ...deps, existingHost: async () => ready,
    spawn() { assert.fail('must reuse'); } })).started, false);
  await assert.rejects(ensureBackgroundHost(options, { ...deps, existingHost: async () => null }), /timed out/);
  child.exitCode = 1;
  await assert.rejects(ensureBackgroundHost(options, { ...deps, existingHost: async () => null }), /exited before readiness/);
  assert.equal(signals, 0);
});
import { acquireHostServiceLease } from './runtime-lock.ts';

test('creates one owner-only token and reuses it across restarts', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-token-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const first = readOrCreateApiToken(dir);
  assert.ok(first.length >= 32);
  // POSIX permission bits do not exist on Windows; the file lives in the owner's profile there.
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(dir, 'host-api-token')).mode & 0o777, 0o600);
  }
  assert.equal(readOrCreateApiToken(dir), first);
});

test('rejects missing, malformed and wrong bearer tokens', () => {
  const token = 'a'.repeat(43);
  assert.equal(isAuthorized(`Bearer ${token}`, token), true);
  assert.equal(isAuthorized(undefined, token), false);
  assert.equal(isAuthorized(token, token), false);
  assert.equal(isAuthorized('Bearer short', token), false);
  assert.equal(isAuthorized(`Bearer ${'b'.repeat(43)}`, token), false);
  assert.equal(isAuthorized(`Bearer ${token}`, ''), false);
});

test('a profile has one service owner and old cleanup cannot delete its replacement', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-lease-'));
  const leases = [];
  // Windows cannot delete the SQLite lock file while a lease still holds it.
  t.after(() => { for (const lease of leases) lease.release(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.deepEqual(await readHostProcessStatus(dir), { running: false });
  assert.deepEqual(await requestHostStop(dir), { stopping: false, running: false });
  const first = acquireHostServiceLease(dir);
  assert.equal(first.held, true);
  leases.push(first);
  const cleanup = publishHostEndpoint(dir, 'http://127.0.0.1:3456', 'old-instance');
  assert.equal(acquireHostServiceLease(dir).held, false);
  assert.equal(readHostEndpoint(dir).instanceId, 'old-instance');
  first.release();
  const replacement = acquireHostServiceLease(dir);
  assert.equal(replacement.held, true);
  leases.push(replacement);
  const cleanupReplacement = publishHostEndpoint(dir, 'http://127.0.0.1:3457', 'new-instance');
  cleanup();
  assert.equal(readHostEndpoint(dir).instanceId, 'new-instance');
  cleanupReplacement();
  assert.equal(readHostEndpoint(dir), null);
});

test('discovery never sends the profile bearer to a non-loopback or redirected address', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-control-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const baseUrl of ['https://example.com:3456', 'http://localhost:3456', 'http://127.0.0.1:3456/api',
    'http://user@127.0.0.1:3456', 'http://127.0.0.1:3456?redirect=1']) {
    publishHostEndpoint(dir, baseUrl, 'test');
    assert.throws(() => readHostEndpoint(dir), /Invalid local Host endpoint/);
  }
});
