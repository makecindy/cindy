import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { newestBundleInputMtime } from '../../apps/desktop/scripts/remote-bundle-inputs.mjs';

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

test('a compatibility dependency update invalidates a newer consumer bundle', () => fixture((root, write) => {
  write('proxy/src/index.ts', 1000);
  write('proxy/dist/proxy.mjs', 1500);
  write('compat/src/upstream/provider.ts', 2000);
  const newest = newestBundleInputMtime(path.join(root, 'proxy'), [path.join(root, 'compat')]);
  assert.equal(newest, 2000000);
  assert.ok(newest > fs.statSync(path.join(root, 'proxy/dist/proxy.mjs')).mtimeMs);
}));

test('license changes invalidate the single-file remote artifact, generated output does not', () => fixture((root, write) => {
  write('proxy/src/index.ts', 1000);
  write('proxy/dist/proxy.mjs', 9000);
  write('compat/src/index.ts', 2000);
  write('compat/LICENSE.opencodex', 3000);
  assert.equal(newestBundleInputMtime(path.join(root, 'proxy'), [path.join(root, 'compat')]), 3000000);
}));

test('missing declared dependency does not leave a stale bundle silently marked fresh', () => fixture((root, write) => {
  write('proxy/src/index.ts', 1000);
  assert.throws(() => newestBundleInputMtime(path.join(root, 'proxy'), [path.join(root, 'missing')]), /dependency is missing/);
}));
