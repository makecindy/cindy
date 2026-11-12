/**
 * Real-process acceptance for the generic IPC route; separate from the unit suite.
 * Never uses a real profile. The isolated profile has no account, so every call
 * stops at the owner gate: this checks the production assembly (manifest from
 * main.ts, route mounted behind the gate, path and header encoding over real
 * HTTP) and that a pinned window proxy never moves to a replacement Host. The
 * signed-in path is covered in-process by src/ipc-route.test.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  HOST_IPC_ENTRIES, HOST_IPC_MANIFEST_PATH, HOST_IPC_PROTOCOL, hostIpcFingerprint, hostIpcPath,
} from '@cindy/maker-shared/host-ipc-registry';
import { readHostEndpoint, requestHostStop } from '../src/control.mjs';
import { createHostIpcProxy } from '../../desktop/src/main/host-ipc-proxy.ts';

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-host-ipc-e2e-'));
const appDir = fileURLToPath(new URL('..', import.meta.url));
const releaseDir = process.env.CINDY_TEST_HOST_RELEASE;
// One port for both processes, so the replacement answers at the window's address.
const port = await new Promise((resolve, reject) => {
  const probe = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const { port: free } = probe.address();
    probe.close(() => resolve(free));
  });
});
const env = { ...process.env, CINDY_HOST_DATA_DIR: profile, CINDY_HOST_PORT: String(port),
  XDT_DEVICE_ID_OVERRIDE: 'cindy-ipc-route-isolated-test' };
env.HOME = path.join(profile, 'home');
env.USERPROFILE = env.HOME;
await fs.mkdir(env.HOME);
for (const key of ['CINDY_HOST_OWNER', 'CINDY_HOST_OWNER_KEY', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
const children = new Set();

function launch() {
  const child = spawn(releaseDir ? path.join(releaseDir, 'bin', process.platform === 'win32' ? 'node.exe' : 'node') : process.execPath,
    releaseDir ? [path.join(releaseDir, 'bin/host.mjs'), 'serve']
      : ['--import', 'tsx', '--import', './src/loaders/register-raw.mjs', 'src/main.ts', 'serve'], {
      cwd: releaseDir ? profile : appDir, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
  children.add(child);
  let output = '';
  const exit = once(child, 'exit').then(([code, signal]) => { children.delete(child); return { code, signal, output }; });
  const listening = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('cindy-host listening on ')) resolve(); });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('exit', () => reject(new Error(`Host exited before listening: ${output}`)));
  });
  listening.catch(() => undefined);
  return { child, exit, listening };
}

async function stop(host) {
  assert.deepEqual(await requestHostStop(profile), { stopping: true });
  assert.equal((await host.exit).code, 0);
  const deadline = Date.now() + 10_000;
  while (readHostEndpoint(profile) && Date.now() < deadline) await delay(25);
  assert.equal(readHostEndpoint(profile), null, 'Host must release its profile');
}

const signedOut = () => ({ dataOwnerId: null, ownerGeneration: 0, canEnterApp: false });

const deadline = setTimeout(() => { for (const child of children) child.kill('SIGTERM'); }, 60_000);
try {
  const first = launch();
  await first.listening;
  const endpoint = readHostEndpoint(profile);
  const token = (await fs.readFile(path.join(profile, 'host-api-token'), 'utf8')).trim();
  const post = (pathname, headers = {}) => fetch(`${endpoint.baseUrl}${pathname}`, { method: 'POST', redirect: 'error',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: 'null' })
    .then(async response => ({ status: response.status, body: await response.json() }));

  // The production assembly offers exactly the registry the window was built with.
  assert.deepEqual(await post(HOST_IPC_MANIFEST_PATH, { 'x-cindy-host-instance': endpoint.instanceId }), { status: 200, body: {
    protocol: HOST_IPC_PROTOCOL, instanceId: endpoint.instanceId,
    entries: HOST_IPC_ENTRIES.map(entry => ({ channel: entry.channel, fingerprint: hostIpcFingerprint(entry) })),
  } });
  assert.deepEqual(await post(HOST_IPC_MANIFEST_PATH), { status: 428, body: { error: 'host_instance_required' } });
  assert.deepEqual(await post(HOST_IPC_MANIFEST_PATH, { 'x-cindy-host-instance': 'host-old' }),
    { status: 409, body: { error: 'host_instance_changed' } });

  // The window proxy over real HTTP: negotiates once, encodes the channel into
  // the path, and reaches the route behind the owner gate (no account here).
  const sent = [];
  const logs = [];
  const recording = (url, init) => {
    sent.push({ path: new URL(url).pathname, instance: init.headers['x-cindy-host-instance'] });
    return fetch(url, init);
  };
  const pinnedProxy = createHostIpcProxy({ baseUrl: endpoint.baseUrl, token, instanceId: endpoint.instanceId, fetch: recording,
    readOwner: signedOut, applyAuthState: () => undefined, log: message => logs.push(message) });
  for (const entry of HOST_IPC_ENTRIES) {
    await assert.rejects(pinnedProxy.invoke(entry, ['e2e-session']), { code: 'PRECONDITION_FAILED' }, entry.channel);
  }
  assert.deepEqual(sent.map(request => request.path), [HOST_IPC_MANIFEST_PATH, ...HOST_IPC_ENTRIES.map(entry => hostIpcPath(entry.channel))]);
  assert.ok(sent.every(request => request.instance === endpoint.instanceId));

  // Replace the Host at the same address: the pinned proxy refuses the new instance.
  await stop(first);
  const replacement = launch();
  await replacement.listening;
  const next = readHostEndpoint(profile);
  assert.equal(next.baseUrl, endpoint.baseUrl);
  assert.notEqual(next.instanceId, endpoint.instanceId);
  sent.length = 0;
  await assert.rejects(pinnedProxy.invoke(HOST_IPC_ENTRIES[0], ['e2e-session']), { code: 'CONNECTION_FAILED' });
  assert.ok(logs.includes('Host instance changed; staying on the pinned instance'), logs.join('\n'));
  assert.ok(sent.every(request => request.instance !== next.instanceId), 'a pinned proxy never stamps the replacement instance');
  assert.ok(sent.some(request => request.path === '/control/attachment'));

  // An unpinned proxy learns the instance but never forwards to a Host that is not ready.
  sent.length = 0;
  const unpinned = createHostIpcProxy({ baseUrl: endpoint.baseUrl, token, fetch: recording, readOwner: signedOut,
    applyAuthState: () => undefined });
  await assert.rejects(unpinned.invoke(HOST_IPC_ENTRIES[0], ['e2e-session']), { code: 'CONNECTION_FAILED' });
  assert.deepEqual(sent.map(request => request.path), ['/control/attachment']);
  await stop(replacement);
  console.log('PASS: production Host offers the window registry; proxy paths, headers and envelope reach the owner gate over real HTTP');
  console.log('PASS: a pinned proxy refuses a replacement Host instance at the same address; an unpinned one never forwards to a Host that is not ready');
} finally {
  clearTimeout(deadline);
  const remaining = [...children];
  const exits = remaining.map(child => (child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, 'exit')));
  for (const child of remaining) child.kill('SIGTERM');
  await Promise.all(exits);
  await fs.rm(profile, { recursive: true, force: true });
}
