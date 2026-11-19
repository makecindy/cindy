// Acceptance for the Chromium proxy helper (release table row 28, 28c) with the repository's real Electron:
// src/chromium-proxy-worker.cjs and its Host side, src/chromium-proxy.ts. macOS and Windows only (the platforms
// whose Host release carries Electron); elsewhere it says so and exits 0.
//
// Changes no system settings and reads none: every helper started here uses a PAC script served from loopback
// (CINDY_PROXY_WORKER_TEST_CONFIG, session.setProxy) and Chromium's --no-proxy-server, plus --use-mock-keychain.
// Those are test switches; the production launcher passes none of them (guarded in
// hostDesktopSourceContracts.guard.test.ts), and the macOS comparison workflow starts it the production way.
//
// usage (from apps/host): node --import tsx --import ./src/loaders/register-raw.mjs scripts/chromium-proxy-worker.e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { createChromiumProxyHelper, FIRST_BACKOFF_MS } from '../src/chromium-proxy.ts';

if (process.platform !== 'darwin' && process.platform !== 'win32') {
  console.log('The Chromium proxy helper runs on macOS and Windows only; nothing to check here.');
  process.exit(0);
}

const hostDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const electron = createRequire(path.join(hostDir, '../desktop/package.json'))('electron');
const script = path.join(hostDir, 'src/chromium-proxy-worker.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-proxy-helper-e2e-'));
const diagnostics = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'cindy-proxy-helper-logs-'));
console.log(`Chromium proxy helper diagnostics: ${diagnostics}`);
const TEST_ARGS = ['--use-mock-keychain', '--no-proxy-server'];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const STDERR_MODE = 'pipe';
const TAIL_LINES = 50;

// The PAC file arrives after 400 ms, so a helper that answered before loading it would answer DIRECT.
const PAC = 'function FindProxyForURL(url, host) { if (dnsDomainIs(host, ".intranet.test")) return "DIRECT"; return "PROXY 127.0.0.1:9"; }';
const pacServer = createServer((_request, response) => setTimeout(() => {
  response.writeHead(200, { 'content-type': 'application/x-ns-proxy-autoconfig' });
  response.end(PAC);
}, 400));
await new Promise(resolve => pacServer.listen(0, '127.0.0.1', resolve));
const testConfig = JSON.stringify({ mode: 'pac_script', pacScript: `http://127.0.0.1:${pacServer.address().port}/proxy.pac` });

/** The production launcher's spawn, with the test configuration and switches added. */
const testSpawn = (binary, args, options) => spawn(binary, [...args, ...TEST_ARGS],
  { ...options, env: { ...options.env, CINDY_PROXY_WORKER_TEST_CONFIG: testConfig } });

const checks = [];
async function check(name, run) {
  const started = Date.now();
  try {
    await run();
    checks.push(`ok   ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    checks.push(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pid, ms) {
  for (const until = Date.now() + ms; Date.now() < until; await delay(100)) if (!isAlive(pid)) return true;
  return !isAlive(pid);
}

async function waitForRound(condition, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (!condition() && Date.now() < until) await delay(20);
  return condition();
}

async function checkStartupRound(run) {
  const profile = path.join(root, `race-${run}`);
  fs.mkdirSync(profile);
  const env = { ...process.env, CINDY_PROXY_WORKER_PROFILE: profile, CINDY_PROXY_WORKER_TEST_CONFIG: testConfig };
  delete env.ELECTRON_RUN_AS_NODE;
  const name = `round-${String(run).padStart(2, '0')}`;
  const logFile = path.join(diagnostics, `${name}.chromium.log`);
  const started = performance.now();
  const child = spawn(electron, [script, ...TEST_ARGS, '--enable-logging=file', `--log-file=${logFile}`],
    { stdio: ['pipe', 'pipe', STDERR_MODE], env });
  let exit = null;
  let closed = false;
  let streamError = null;
  let forcedStop = false;
  const stderr = [];
  const running = () => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
  child.once('exit', (code, signal) => { exit = { code, signal, elapsedMs: Math.round(performance.now() - started) }; });
  child.once('close', () => { closed = true; });
  const onError = error => { streamError ??= error; };
  child.on('error', onError);
  child.stdin.on('error', onError);
  const errors = createInterface({ input: child.stderr });
  errors.on('error', onError);
  errors.on('line', line => {
    stderr.push(line.slice(-4096));
    if (stderr.length > TAIL_LINES) stderr.shift();
  });

  const answers = [];
  let readyAt = null;
  let id = 0;
  const replies = createInterface({ input: child.stdout });
  replies.on('error', onError);
  replies.on('line', (line) => {
    // Electron's stdout can also contain lines outside the worker protocol.
    let value;
    try { value = JSON.parse(line); } catch { return; }
    if (!value || typeof value !== 'object') return;
    if (value.ready === true && value.pid === child.pid) readyAt = answers.length;
    else if (Number.isSafeInteger(value.id) && value.id > 0 && value.id <= id) answers.push(value);
  });
  const ask = setInterval(() => {
    if (!running() || streamError || !child.stdin.writable || child.stdin.destroyed) return;
    child.stdin.write(`${JSON.stringify({ id: ++id, method: 'resolve', url: 'https://api.example.test/v1' })}\n`);
  }, 20);
  try {
    await waitForRound(() => exit || closed || streamError ||
      (readyAt !== null && answers.slice(readyAt).some(a => a.result)), 15_000);
  } finally {
    clearInterval(ask);
    if (child.stdin.writable && !child.stdin.destroyed) child.stdin.end();
    if (!await waitForRound(() => closed, 1500)) {
      forcedStop = true;
      if (running()) child.kill('SIGKILL');
      if (!await waitForRound(() => closed, 1500)) {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
    }
  }

  const summary = { run, pid: child.pid ?? null, stderrMode: STDERR_MODE,
    exitCode: exit?.code ?? null, signal: exit?.signal ?? null, elapsedMs: exit?.elapsedMs ?? null,
    stdioClosed: closed, forcedStop, streamError: streamError?.code ?? streamError?.message ?? null };
  console.log(`Chromium proxy helper ${JSON.stringify(summary)}`);
  fs.appendFileSync(path.join(diagnostics, 'rounds.jsonl'), `${JSON.stringify(summary)}\n`);
  fs.writeFileSync(path.join(diagnostics, `${name}.stderr.log`), stderr.join('\n'));

  try {
    assert.notEqual(readyAt, null, `run ${run}: ready`);
    const before = answers.slice(0, readyAt);
    assert.ok(before.length > 0, `run ${run}: received at least one answer before ready`);
    assert.ok(before.every(a => a.error === 'not_ready'), `run ${run}: before ready only not_ready (${JSON.stringify(before.slice(0, 3))})`);
    assert.ok(!answers.some(a => typeof a.result === 'string' && /DIRECT/.test(a.result)), `run ${run}: never DIRECT`);
    assert.ok(answers.some(a => a.result === 'PROXY 127.0.0.1:9'), `run ${run}: the PAC result`);
    if (streamError) throw streamError;
    if (forcedStop) throw new Error('helper did not close after stdin ended');
  } catch (error) {
    const logTail = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trimEnd().split(/\r?\n/).slice(-TAIL_LINES).join('\n') : '';
    console.error(`Chromium proxy helper run ${run} failed (stderr=${STDERR_MODE}): ${error.message}\n` +
      `stderr tail:\n${stderr.join('\n') || '(empty)'}\nChromium log tail:\n${logTail || '(empty or missing)'}`);
    throw error;
  }
}

try {
  // The Electron the Host release copies (scripts/build.mjs) is this one: cookie encryption must be off, so that the
  // helper's Chromium never sets up Safe Storage (a keychain item on macOS).
  await check('the Electron the Host ships has cookie encryption off', async () => {
    const fuses = createRequire(path.join(hostDir, '../desktop/package.json'))('@electron/fuses');
    const wire = await fuses.getCurrentFuseWire(process.platform === 'darwin' ? path.resolve(electron, '../../..') : electron);
    assert.equal(String.fromCharCode(wire[fuses.FuseV1Options.EnableCookieEncryption]), '0');
  });

  // The helper's own promise, asked over its line protocol from the moment it starts: before it is ready every
  // answer is not_ready, never DIRECT, and once ready it answers what the PAC script says.
  await check('20 starts: no answer before ready, never DIRECT, then the PAC result', async () => {
    const failed = [];
    for (let run = 1; run <= 20; run++) {
      try { await checkStartupRound(run); }
      catch (error) { failed.push(`run ${run}: ${error.message}`); }
    }
    if (failed.length) throw new Error(failed.join('; '));
  });

  await check('the Host side answers through Chromium and the PAC script, per host', async () => {
    const home = path.join(root, 'host-side');
    fs.mkdirSync(home);
    const helper = createChromiumProxyHelper({ profileDir: home,
      spawnImpl: (binary, args, options) => testSpawn(binary, args, { ...options, env: {
        ...options.env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
      } }),
    });
    await helper.warmUp();
    assert.equal(await helper.resolveProxy('https://api.example.test/v1'), 'PROXY 127.0.0.1:9');
    assert.equal(await helper.resolveProxy('https://wiki.intranet.test/'), 'DIRECT');
    assert.equal(helper.state(), 'ready');
    // In memory: no cookie store or partition on disk under the helper's own directory.
    const files = fs.readdirSync(path.join(root, 'host-side', 'proxy-helper'), { recursive: true }).map(String);
    assert.ok(!files.some(file => /(^|[\\/])Cookies$/.test(file) || file.includes('cindy-proxy-helper')), files.join(', '));
    await helper.close();
    assert.equal(helper.state(), 'stopped');
    assert.deepEqual(fs.readdirSync(home), ['proxy-helper'], 'no caches, logs or saved state elsewhere in HOME');
  });

  await check('a crashed helper: no answer meanwhile, started again after the backoff', async () => {
    const children = [];
    const helper = createChromiumProxyHelper({ profileDir: path.join(root, 'crash'),
      spawnImpl: (...args) => { const child = testSpawn(...args); children.push(child); return child; } });
    for (const until = Date.now() + 15_000; Date.now() < until; await delay(100)) {
      if (await helper.resolveProxy('https://api.example.test/').catch(() => null)) break;
    }
    children[0].kill('SIGKILL');
    await new Promise(resolve => children[0].once('exit', resolve));
    await delay(50);
    assert.equal(helper.state(), 'backoff');
    await assert.rejects(helper.resolveProxy('https://api.example.test/'), /restarting/);
    await delay(FIRST_BACKOFF_MS + 100);
    let answer;
    for (const until = Date.now() + 15_000; Date.now() < until && !answer; await delay(100)) {
      answer = await helper.resolveProxy('https://api.example.test/').catch(() => undefined);
    }
    assert.equal(answer, 'PROXY 127.0.0.1:9');
    assert.equal(children.length, 2);
    await helper.close();
  });

  await check('the helper does not outlive a Host that is killed', async () => {
    const parentScript = path.join(root, 'parent.mjs');
    fs.writeFileSync(parentScript, `
      import { spawn } from 'node:child_process';
      const { createChromiumProxyHelper } = await import(${JSON.stringify(new URL('../src/chromium-proxy.ts', import.meta.url).href)});
      let pid;
      const helper = createChromiumProxyHelper({ profileDir: ${JSON.stringify(path.join(root, 'orphan'))},
        spawnImpl: (binary, args, options) => { const c = spawn(binary, [...args, ${TEST_ARGS.map(a => JSON.stringify(a)).join(', ')}],
          { ...options, env: { ...options.env, CINDY_PROXY_WORKER_TEST_CONFIG: ${JSON.stringify(testConfig)} } }); pid = c.pid; return c; } });
      for (let i = 0; i < 150; i++) { if (await helper.resolveProxy('https://api.example.test/').catch(() => null)) break; await new Promise(r => setTimeout(r, 100)); }
      console.log(JSON.stringify({ pid }));
      setInterval(() => {}, 1000);
    `);
    const parent = spawn(process.execPath, ['--import', 'tsx', '--import', './src/loaders/register-raw.mjs', parentScript],
      { cwd: hostDir, stdio: ['ignore', 'pipe', 'inherit'] });
    const line = await new Promise((resolve, reject) => {
      createInterface({ input: parent.stdout }).once('line', resolve);
      parent.once('exit', () => reject(new Error('the parent exited early')));
    });
    const { pid } = JSON.parse(line);
    assert.ok(isAlive(pid), 'the helper runs');
    parent.kill('SIGKILL');
    assert.ok(await gone(pid, 10_000), 'the helper quit after its Host was killed');
  });
} finally {
  pacServer.close();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(checks.join('\n'));
console.log(process.exitCode ? 'Chromium proxy helper acceptance FAILED' : 'Chromium proxy helper acceptance passed');
