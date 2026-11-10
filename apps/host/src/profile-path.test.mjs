import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  discoverHostOwner,
  ownerDatabasePath,
  resolveHostDataDir,
  resolveHostRegion,
} from './profile-path.mjs';

test('defaults to the global profile and reuses Desktop DB naming', () => {
  assert.equal(resolveHostRegion(), 'global');
  assert.equal(ownerDatabasePath(path.join('/profile', 'CindyGlobal'), 'owner-1'), path.join('/profile', 'CindyGlobal', 'cindy-owner-1.db'));
});

test('accepts only explicit CN or global identities', () => {
  assert.equal(resolveHostRegion('cn'), 'cn');
  assert.throws(() => resolveHostRegion('dev'), /must be "cn" or "global"/);
});

test('explicit Host data dirs retain Desktop XDT_USER_DATA_DIR semantics', () => {
  const base = { XDG_CONFIG_HOME: path.join('/config-home') };
  assert.equal(resolveHostDataDir({ env: base, appDataDir: '/appdata' }), path.join('/appdata', 'CindyHost', 'global'));
  assert.equal(resolveHostDataDir({ env: { ...base, CINDY_HOST_REGION: 'cn' }, appDataDir: '/appdata' }), path.join('/appdata', 'CindyHost', 'cn'));
  assert.equal(resolveHostDataDir({ env: { ...base, XDT_USER_DATA_DIR: '/data/desktop' }, appDataDir: '/appdata' }), path.resolve('/data/desktop'));
  assert.equal(resolveHostDataDir({ env: { ...base, CINDY_HOST_DATA_DIR: './host-data' }, appDataDir: '/appdata' }), path.resolve('./host-data'));
});

test('owner IDs are mandatory and cannot escape the profile directory', () => {
  assert.throws(() => ownerDatabasePath('/data', ''), /owner id is required/);
  assert.throws(() => ownerDatabasePath('/data', '../escape'), /single safe path segment/);
  assert.throws(() => ownerDatabasePath('/data', 'nested/owner'), /single safe path segment/);
});

test('source and installed Hosts default to an independent profile without taking over Desktop data', () => {
  const options = { packaged: true, appDataDir: '/appdata', env: {} };
  assert.equal(resolveHostDataDir({ ...options, packaged: false }), resolveHostDataDir(options));
  assert.equal(resolveHostDataDir(options), path.join('/appdata', 'CindyHost', 'global'));
  assert.equal(resolveHostDataDir({ ...options, env: { CINDY_HOST_REGION: 'cn' } }), path.join('/appdata', 'CindyHost', 'cn'));
  assert.equal(resolveHostDataDir({ ...options, env: { CINDY_HOST_DATA_DIR: '/isolated/host' } }), path.resolve('/isolated/host'));
});

test('discovers a single-account profile and refuses to guess across accounts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-owner-'));
  try {
    assert.deepEqual(discoverHostOwner(root), { ownerId: null, reason: 'no account database in this profile' });
    fs.writeFileSync(path.join(root, 'cindy-owner-a.db'), '');
    fs.writeFileSync(path.join(root, 'cindy-host-runtime-owner-a.lock.db'), '');
    assert.deepEqual(discoverHostOwner(root), { ownerId: 'owner-a', reason: null });
    fs.writeFileSync(path.join(root, 'cindy-owner-b.db'), '');
    assert.equal(discoverHostOwner(root).ownerId, null);
    assert.match(discoverHostOwner(root).reason, /2 accounts/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
