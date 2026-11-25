// Runs the real staging script on copies of the client files it changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = process.env.CINDY_TEST_CLIENT_SOURCE;
const script = fileURLToPath(new URL('./stage-cloud-overlays.mjs', import.meta.url));
const forge = 'apps/desktop/forge.config.ts', manifest = 'apps/desktop/package.json';
const overlays = ['activity', 'guidance', 'identity', 'maintenance', 'updates', 'window-controls'];
const commit = 'a'.repeat(40);
const version = { CINDY_UPSTREAM_VERSION: '1.2.3', APP_VERSION: '1.2.3-cloud.4', VITE_CINDY_AUTH_REGION: 'cn' };

async function stage(t, { env = {}, sourceCommit = commit, edit = () => {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-cloud-overlays-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'source'), recipe = path.join(dir, 'recipe');
  fs.mkdirSync(recipe);
  fs.writeFileSync(path.join(recipe, 'source-commit'), sourceCommit + '\n');
  const modules = await Promise.all(overlays.map(name => import(`./runtime-${name}/overlay.mjs`)));
  for (const file of new Set([...modules.flatMap(m => m.targets), forge, manifest])) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(source, file), path.join(root, file));
  }
  edit(root);
  const result = spawnSync(process.execPath, [script, root, recipe], { encoding: 'utf8', env: { ...process.env, ...version, ...env } });
  return { root, recipe, ...result };
}

test('every overlay and packaging anchor matches the client source', { skip: !source }, async t => {
  const { status, stderr, root, recipe } = await stage(t);
  assert.equal(status, 0, stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, manifest), 'utf8')).version, '1.2.3-cloud.4');
  assert.ok(fs.readFileSync(path.join(root, forge), 'utf8').includes(`return ${JSON.stringify(commit)};`));
  const records = JSON.parse(fs.readFileSync(path.join(recipe, 'overlay-application.json'), 'utf8'));
  assert.deepEqual([...new Set(records.map(r => r.overlay))].sort(),
    ['activity', 'build-metadata-and-memory-budget', 'guidance', 'identity', 'maintenance', 'package-version', 'updates', 'window']);
});

test('invalid commit, version or region and changed anchors fail the build', { skip: !source }, async t => {
  for (const [options, error] of [
    [{ sourceCommit: 'main' }, /invalid source commit/],
    [{ env: { APP_VERSION: '1.2.4-cloud.1' } }, /CLOUD_APP_VERSION_MISMATCH/],
    [{ env: { CINDY_UPSTREAM_VERSION: 'v1.2.3', APP_VERSION: 'v1.2.3-cloud.1' } }, /CLOUD_APP_VERSION_MISMATCH/],
    [{ env: { VITE_CINDY_AUTH_REGION: 'global' } }, /Cloud main region/],
    [{ edit: root => fs.writeFileSync(path.join(root, forge), fs.readFileSync(path.join(root, forge), 'utf8').replace('packagerConfig: {', 'packager: {')) },
      /forge anchor changed/],
  ]) {
    const { status, stderr } = await stage(t, options);
    assert.notEqual(status, 0);
    assert.match(stderr, error);
  }
});
