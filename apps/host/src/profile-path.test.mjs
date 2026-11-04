import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { ownerDatabasePath, resolveHostDataDir, resolveHostRegion } from './profile-path.mjs';

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
  assert.equal(resolveHostDataDir({ env: base, appDataDir: '/appdata' }), '/appdata/CindyGlobal');
  assert.equal(resolveHostDataDir({ env: { ...base, CINDY_HOST_REGION: 'cn' }, appDataDir: '/appdata' }), '/appdata/Cindy');
  assert.equal(resolveHostDataDir({ env: { ...base, XDT_USER_DATA_DIR: '/data/desktop' }, appDataDir: '/appdata' }), '/data/desktop');
  assert.equal(resolveHostDataDir({ env: { ...base, CINDY_HOST_DATA_DIR: './host-data' }, appDataDir: '/appdata' }), path.resolve('./host-data'));
});

test('owner IDs are mandatory and cannot escape the profile directory', () => {
  assert.throws(() => ownerDatabasePath('/data', ''), /owner id is required/);
  assert.throws(() => ownerDatabasePath('/data', '../escape'), /single safe path segment/);
  assert.throws(() => ownerDatabasePath('/data', 'nested/owner'), /single safe path segment/);
});
