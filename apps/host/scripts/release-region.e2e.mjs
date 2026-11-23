/**
 * Packaged acceptance for the Host's edition: one release per region (region-and-editions.md §2.4).
 * Separate from the unit suite: it needs one release of each region, built by scripts/build.mjs.
 *
 *   CINDY_TEST_HOST_RELEASE_CN=<cn release> CINDY_TEST_HOST_RELEASE_GLOBAL=<global release> \
 *     node scripts/release-region.e2e.mjs        (from apps/host)
 *
 * For each release, signed out, in a new empty profile and HOME (never a real profile):
 * - release.json and `cindy-host status --json` give its build region;
 * - the web client it serves is the renderer of that region, and boots with that region's voice input
 *   default language (zh-CN for cn, automatic for global), read by the packaged desktop module;
 * - started with CINDY_HOST_REGION naming the other edition, it refuses with HOST_REGION_MISMATCH and
 *   publishes no endpoint.
 * Takes about 10 s for both releases on an Apple Silicon Mac.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readHostEndpoint, requestHostStop } from '../src/control.mjs';
import { readWebRegions } from '../src/release-region.mjs';

const RELEASES = { cn: process.env.CINDY_TEST_HOST_RELEASE_CN, global: process.env.CINDY_TEST_HOST_RELEASE_GLOBAL };
for (const [region, dir] of Object.entries(RELEASES)) {
  if (!dir) throw new Error(`Set CINDY_TEST_HOST_RELEASE_${region.toUpperCase()} to a ${region} release built by scripts/build.mjs`);
}
const VOICE_LANGUAGE = { cn: 'zh-CN', global: 'auto' };
const other = region => (region === 'cn' ? 'global' : 'cn');

function releaseCommand(release, args) {
  return [path.join(release, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'), [path.join(release, 'bin', 'host.mjs'), ...args]];
}

function isolatedEnv(profile) {
  const env = { ...process.env, CINDY_HOST_DATA_DIR: profile, CINDY_HOST_PORT: '0',
    XDT_DEVICE_ID_OVERRIDE: 'cindy-release-region-isolated-test', HOME: path.join(profile, 'home') };
  env.USERPROFILE = env.HOME;
  for (const key of ['CINDY_HOST_REGION', 'VITE_CINDY_AUTH_REGION', 'CINDY_HOST_OWNER', 'CINDY_HOST_OWNER_KEY', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
  return env;
}

async function run(release, args, env, timeoutMs = 20_000) {
  const [command, argv] = releaseCommand(release, args);
  const child = spawn(command, argv, { cwd: env.CINDY_HOST_DATA_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  const [code] = await once(child, 'exit');
  clearTimeout(timer);
  return { code, stdout, stderr };
}

async function checkRelease(region, release) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `cindy-host-release-${region}-`));
  fs.mkdirSync(path.join(profile, 'home'));
  const env = isolatedEnv(profile);
  let serve;
  try {
    assert.equal(JSON.parse(fs.readFileSync(path.join(release, 'release.json'), 'utf8')).region, region, 'release.json region');
    assert.deepEqual(readWebRegions(path.join(release, 'resources', 'web')), [region], 'packaged renderer region');

    const refused = await run(release, ['serve'], { ...env, CINDY_HOST_REGION: other(region) });
    assert.equal(refused.code, 1, `serve with CINDY_HOST_REGION=${other(region)} must fail: ${refused.stderr}`);
    assert.match(refused.stderr, new RegExp(`HOST_REGION_MISMATCH: this Cindy Host release is the ${region} edition`));
    assert.equal(readHostEndpoint(profile), null, 'a refused Host publishes no endpoint');

    const [command, argv] = releaseCommand(release, ['serve']);
    serve = spawn(command, argv, { cwd: profile, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    serve.stdout.on('data', chunk => { output += chunk; });
    serve.stderr.on('data', chunk => { output += chunk; });
    const deadline = Date.now() + 30_000;
    while (!readHostEndpoint(profile)) {
      if (serve.exitCode !== null || Date.now() > deadline) throw new Error(`${region} Host did not start:\n${output}`);
      await delay(100);
    }
    const status = await run(release, ['status', '--json'], env);
    assert.equal(status.code, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).region, region, 'status --json region');

    // The local API token stands in for a paired browser (server.mjs isWebAuthorized); unpaired, / is the connect page.
    const token = fs.readFileSync(path.join(profile, 'host-api-token'), 'utf8').trim();
    const page = await fetch(readHostEndpoint(profile).baseUrl + '/', { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    assert.equal(page.status, 200);
    const boot = /window\.__cindyBoot=(\{.*?\});<\/script>/s.exec(await page.text());
    assert.ok(boot, 'the web client page carries its boot values');
    assert.equal(JSON.parse(boot[1]).voiceInput.settings.language, VOICE_LANGUAGE[region], 'voice input default language');
    console.log(`PASS ${region}: release.json, status and packaged renderer say ${region}; voice default ${VOICE_LANGUAGE[region]}; `
      + `CINDY_HOST_REGION=${other(region)} refused`);
  } finally {
    if (serve && serve.exitCode === null) {
      await requestHostStop(profile).catch(() => undefined);
      const stopped = once(serve, 'exit');
      const timer = setTimeout(() => serve.kill(), 15_000);
      await stopped;
      clearTimeout(timer);
    }
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

for (const [region, release] of Object.entries(RELEASES)) await checkRelease(region, path.resolve(release));
