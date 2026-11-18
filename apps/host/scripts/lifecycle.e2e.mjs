/** Real-process acceptance; separate from the unit suite. Never uses a real profile. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { readHostEndpoint, readHostProcessStatus, requestHostStop } from '../src/control.mjs';

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-host-lifecycle-'));
const appDir = fileURLToPath(new URL('..', import.meta.url));
const releaseDir = process.env.CINDY_TEST_HOST_RELEASE;
const env = { ...process.env, CINDY_HOST_DATA_DIR: profile, CINDY_HOST_PORT: '0',
  XDT_DEVICE_ID_OVERRIDE: 'cindy-lifecycle-isolated-test' };
env.HOME = path.join(profile, 'home');
env.USERPROFILE = env.HOME;
await fs.mkdir(env.HOME);
delete env.CINDY_HOST_OWNER;
delete env.CINDY_HOST_OWNER_KEY;
delete env.NODE_OPTIONS;
delete env.NODE_PATH;
const children = new Set();
let background;
async function stopBackground() {
  await requestHostStop(profile);
  const deadline = Date.now() + 10_000;
  while (readHostEndpoint(profile) && Date.now() < deadline) await delay(25);
  assert.equal(readHostEndpoint(profile), null, 'Host must release its profile before removing the fixture');
  background = null;
}
async function attachFromShortLivedLauncher() {
  const options = { profile, command: releaseDir
    ? path.join(releaseDir, 'bin', process.platform === 'win32' ? 'node.exe' : 'node') : process.execPath,
    args: releaseDir ? [path.join(releaseDir, 'bin/host.mjs'), 'serve']
      : ['--import', 'tsx', '--import', './src/loaders/register-raw.mjs', 'src/main.ts', 'serve'],
    cwd: releaseDir ? profile : appDir, timeoutMs: 20_000 };
  // A real launcher exits completely; no parent object can keep its child alive.
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    'const {ensureBackgroundHost}=await import(process.argv[1]); console.log(JSON.stringify(await ensureBackgroundHost(JSON.parse(process.argv[2]))));',
    new URL('../src/background.mjs', import.meta.url).href, JSON.stringify(options)],
    { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  child.once('exit', () => children.delete(child));
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout);
}
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
const deadline = setTimeout(() => {
  for (const child of children) child.kill('SIGTERM');
}, 30_000);
try {
  const first = launch();
  await first.listening;
  const endpoint = readHostEndpoint(profile);
  assert.equal(endpoint.pid, first.child.pid);
  assert.equal((await readHostProcessStatus(profile)).running, true);
  if (releaseDir) {
    // A copied release must serve its compiled adapter without esbuild, tsx,
    // a development cwd, or a neighboring Desktop renderer directory.
    const shim = await fetch(`${endpoint.baseUrl}/shim.js`);
    assert.equal(shim.status, 200);
    assert.match(shim.headers.get('content-type'), /javascript/);
    assert.match(await shim.text(), /electronAPI/);
  }
  const second = launch();
  const secondExit = await second.exit;
  assert.notEqual(secondExit.code, 0);
  assert.match(secondExit.output, /profile is busy/);
  assert.deepEqual(readHostEndpoint(profile), endpoint);
  assert.deepEqual(await requestHostStop(profile), { stopping: true });
  assert.equal((await first.exit).code, 0);
  assert.equal(readHostEndpoint(profile), null);
  assert.deepEqual(await readHostProcessStatus(profile), { running: false });
  // The operating-system lease must be reusable after an orderly stop.
  const replacement = launch();
  await replacement.listening;
  assert.notEqual(readHostEndpoint(profile).instanceId, endpoint.instanceId);
  replacement.child.kill('SIGTERM');
  assert.equal((await replacement.exit).code, 0);
  assert.equal(readHostEndpoint(profile), null);
  background = await attachFromShortLivedLauncher();
  assert.equal(background.started, true);
  assert.equal((await readHostProcessStatus(profile)).instanceId, background.instanceId);
  // New launcher (possibly from a new source checkout) reuses the live backend.
  const reattached = await attachFromShortLivedLauncher();
  assert.equal(reattached.started, false);
  assert.equal(reattached.pid, background.pid);
  assert.equal(reattached.instanceId, background.instanceId);
  await stopBackground();
  console.log(`PASS: ${releaseDir ? 'installed' : 'source'} Host start, duplicate exclusion, authenticated managed stop, signal shutdown and restart`);
  console.log('PASS: background Host survives launcher exit; replacement launcher attaches to the same process and instance');
} finally {
  clearTimeout(deadline);
  const remaining = [...children];
  const exits = remaining.map(child => child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve() : once(child, 'exit'));
  for (const child of remaining) child.kill('SIGTERM');
  await Promise.all(exits);
  // A detached child can have published its endpoint before the launcher fails
  // to return its receipt. The private fixture profile remains the authority.
  if (background || readHostEndpoint(profile)) await stopBackground();
  await fs.rm(profile, { recursive: true, force: true });
}
