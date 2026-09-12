import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bundleInputDigest, bundleInputsMatch, recordBundleInputs } from '../../apps/desktop/scripts/remote-bundle-inputs.mjs';

function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-remote-bundle-inputs-'));
  const write = (name, seconds) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fixture');
    fs.utimesSync(file, seconds, seconds);
  };
  try { run(root, write); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function cache(root, write) {
  write('proxy/src/index.ts', 1000);
  write('compat/src/keep.ts', 1000);
  write('compat/src/remove.ts', 1000);
  write('proxy/dist/proxy.mjs', 9000);
  const bundle = path.join(root, 'proxy/dist/proxy.mjs');
  const digest = () => bundleInputDigest(path.join(root, 'proxy'), [path.join(root, 'compat')]);
  recordBundleInputs(bundle, digest());
  assert.equal(bundleInputsMatch(bundle, digest()), true);
  return { bundle, digest };
}

test('deleting dependency source invalidates a newer cached bundle', () => fixture((root, write) => {
  const { bundle, digest } = cache(root, write);
  fs.unlinkSync(path.join(root, 'compat/src/remove.ts'));
  assert.equal(bundleInputsMatch(bundle, digest()), false);
}));

test('consumer source removal and renaming invalidate even with unchanged contents', () => fixture((root, write) => {
  const { bundle, digest } = cache(root, write);
  fs.renameSync(path.join(root, 'proxy/src/index.ts'), path.join(root, 'proxy/src/renamed.ts'));
  assert.equal(bundleInputsMatch(bundle, digest()), false);
  recordBundleInputs(bundle, digest());
  fs.unlinkSync(path.join(root, 'proxy/src/renamed.ts'));
  assert.equal(bundleInputsMatch(bundle, digest()), false);
}));

test('content changes with preserved old timestamps invalidate', () => fixture((root, write) => {
  const { bundle, digest } = cache(root, write);
  const file = path.join(root, 'compat/src/keep.ts');
  fs.writeFileSync(file, 'changed');
  fs.utimesSync(file, 1000, 1000);
  assert.equal(bundleInputsMatch(bundle, digest()), false);
}));

test('license changes invalidate, generated output and timestamp-only changes do not', () => fixture((root, write) => {
  const { bundle, digest } = cache(root, write);
  write('compat/dist/generated.js', 10000);
  fs.utimesSync(path.join(root, 'compat/src/keep.ts'), 11000, 11000);
  assert.equal(bundleInputsMatch(bundle, digest()), true);
  write('compat/LICENSE.opencodex', 1000);
  assert.equal(bundleInputsMatch(bundle, digest()), false);
}));

test('missing/corrupt receipts and changed output rebuild; only recorded successful output is fresh', () => fixture((root, write) => {
  const { bundle, digest } = cache(root, write);
  fs.unlinkSync(`${bundle}.inputs.json`);
  assert.equal(bundleInputsMatch(bundle, digest()), false);
  for (const invalid of ['{broken', 'null', '{}']) {
    fs.writeFileSync(`${bundle}.inputs.json`, invalid);
    assert.equal(bundleInputsMatch(bundle, digest()), false);
  }
  recordBundleInputs(bundle, digest());
  fs.writeFileSync(bundle, 'partial failed build');
  assert.equal(bundleInputsMatch(bundle, digest()), false);
  recordBundleInputs(bundle, digest());
  assert.equal(bundleInputsMatch(bundle, digest()), true);
  fs.unlinkSync(bundle);
  assert.equal(bundleInputsMatch(bundle, digest()), false);
}));

test('missing declared dependency fails instead of accepting stale output', () => fixture((root, write) => {
  write('proxy/src/index.ts', 1000);
  assert.throws(() => bundleInputDigest(path.join(root, 'proxy'), [path.join(root, 'missing')]), /dependency is missing/);
}));
