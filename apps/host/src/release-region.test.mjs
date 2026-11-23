/**
 * The Host's edition: one release per region, fixed when it is built (region-and-editions.md §2.4).
 *
 * Test value
 * - Production entries and observable results: from source, the desktop modules the Host loads follow
 *   CINDY_HOST_REGION through the loader (loaders/raw-hook.mjs): the active catalog's unverified XD
 *   embedding models (hidden for cn before /models first succeeds), the currency of a zero amount
 *   (regionalMoney.zeroUsageMoney, which localDb/mapper.ts uses for tasks and runs without a cost) and the
 *   voice input default language the web client boots with (profile-settings.mjs). The release builder
 *   (scripts/build.mjs) refuses a missing or unknown --region before any work, and a renderer build of
 *   another region (release-region.mjs assertWebRegion).
 * - Rule: docs/host/personal-migration-release-table.md, the region row (甲类, 2026-11-17): the desktop
 *   constant was always global on the Host, so a mainland China account saw unverified XD models, USD
 *   zero amounts and an automatic voice language.
 * - Coverage gap: no Host test ran a desktop module under another region; the release builder had no region.
 * - Minimal failing input: CINDY_HOST_REGION=cn with the loader's define removed gives 7 embedding
 *   models, USD and auto; `build.mjs --output <dir>` without --region starts building.
 * - Tier: unit (Node test runner, child processes with an empty HOME; no account, network or engine).
 *   The source-mode children load the catalog module (under a second together on this machine); the
 *   builder children exit at argument checking.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { assertWebRegion, readWebRegions, validateDevelopmentEndpoints } from './release-region.mjs';

const exec = promisify(execFile);
const hostDir = fileURLToPath(new URL('..', import.meta.url));

function childEnv(home, region) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' };
  delete env.CINDY_HOST_REGION;
  delete env.NODE_OPTIONS;
  if (region !== undefined) env.CINDY_HOST_REGION = region;
  // A desktop build variable some shells inherit; the Host must not read it.
  env.VITE_CINDY_AUTH_REGION = region === 'cn' ? 'global' : 'cn';
  return env;
}

async function sourceModeReadings(region) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-region-'));
  try {
    const probe = [
      "const { getActiveCatalog } = await import('../desktop/src/main/maker-host/active-catalog.ts');",
      "const { zeroUsageMoney } = await import('../desktop/src/shared/regionalMoney.ts');",
      "const { readProfileSettings } = await import('./src/profile-settings.mjs');",
      "const xd = getActiveCatalog().providers.find(provider => provider.id === 'xd');",
      'console.log(JSON.stringify({ embeddingModels: (xd?.embeddingModels ?? []).length, zeroCurrency: zeroUsageMoney().currency,',
      '  voiceLanguage: readProfileSettings({ dataDir: process.argv[1], ownerId: null }).voiceInput.settings.language }));',
    ].join('\n');
    const { stdout } = await exec(process.execPath, ['--import', 'tsx', '--import', './src/loaders/register-raw.mjs',
      '--input-type=module', '-e', probe, home], { cwd: hostDir, env: childEnv(home, region) });
    return JSON.parse(stdout.trim().split('\n').at(-1));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('from source the desktop modules follow CINDY_HOST_REGION, global when unset', async () => {
  const [cn, unset] = await Promise.all([sourceModeReadings('cn'), sourceModeReadings(undefined)]);
  assert.deepEqual(cn, { embeddingModels: 0, zeroCurrency: 'CNY', voiceLanguage: 'zh-CN' });
  assert.equal(unset.zeroCurrency, 'USD');
  assert.equal(unset.voiceLanguage, 'auto');
  assert.ok(unset.embeddingModels > 0, 'global keeps the unverified XD embedding models');
});

test('a release build needs --region cn or global, checked before any output is written', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-region-build-'));
  try {
    for (const args of [[], ['--region', 'dev']]) {
      const output = path.join(root, 'release');
      await assert.rejects(
        exec(process.execPath, ['scripts/build.mjs', '--output', output, ...args], { cwd: hostDir, env: childEnv(root, undefined) }),
        error => /A Host release needs --region cn or --region global/.test(error.stderr),
      );
      assert.deepEqual(fs.readdirSync(root), [], `nothing written for ${JSON.stringify(args)}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a release only takes the renderer build of its own region', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-region-web-'));
  const web = (name, ...scripts) => {
    const dir = path.join(root, name, 'assets');
    fs.mkdirSync(dir, { recursive: true });
    scripts.forEach((text, index) => fs.writeFileSync(path.join(dir, `chunk-${index}.js`), text));
    return path.dirname(dir);
  };
  try {
    // The shape Vite inlines for the renderer's import.meta.env (brandRegion.ts reads it optionally).
    const cn = web('cn', 'const e={MODE:"production",VITE_CINDY_AUTH_REGION:"cn"};', 'export const x=1;');
    assert.deepEqual(readWebRegions(cn), ['cn']);
    assert.doesNotThrow(() => assertWebRegion(cn, 'cn'));
    assert.throws(() => assertWebRegion(cn, 'global'), /is for cn, not global/);
    assert.throws(() => assertWebRegion(web('none', 'export const x=1;'), 'cn'), /Cannot read the region/);
    assert.throws(() => assertWebRegion(web('mixed', 'a={VITE_CINDY_AUTH_REGION:"cn"}', 'b={VITE_CINDY_AUTH_REGION:"global"}'), 'cn'),
      /is for cn, global, not cn/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a development Host keeps guest registration and the device directory on its own services', () => {
  const manifest = name => ({
    authApiBaseUrl: `https://auth.${name}.example.test`,
    deviceLinkApiBaseUrl: `https://device-link.${name}.example.test`,
    modelAccessApiBaseUrl: `https://model-access.${name}.example.test`,
    cdnBaseUrl: `https://cdn.${name}.example.test/cindy`,
  });
  const dev = manifest('dev');
  const production = [manifest('cn'), manifest('global')];
  validateDevelopmentEndpoints(dev, production);
  for (const other of production) {
    assert.throws(() => validateDevelopmentEndpoints({ ...dev, authApiBaseUrl: other.authApiBaseUrl + '/guest' }, production),
      /separate HTTPS development endpoint for authApiBaseUrl/);
  }
  assert.throws(() => validateDevelopmentEndpoints({ ...dev, deviceLinkApiBaseUrl: 'http://link.example.test' }, production),
    /separate HTTPS development endpoint for deviceLinkApiBaseUrl/);
});
