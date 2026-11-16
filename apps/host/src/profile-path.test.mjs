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
  resolveHostAppDataDir,
} from './profile-path.mjs';

test('defaults to the global profile and reuses Desktop DB naming', () => {
  assert.equal(resolveHostRegion(), 'global');
  assert.equal(ownerDatabasePath(path.join('/profile', 'CindyGlobal'), 'owner-1'), path.join('/profile', 'CindyGlobal', 'cindy-owner-1.db'));
});

test('accepts only explicit CN or global identities', () => {
  assert.equal(resolveHostRegion('cn'), 'cn');
  assert.throws(() => resolveHostRegion('dev'), /must be "cn" or "global"/);
});

// A release answers the edition it was built for (scripts/build.mjs --region; region row of
// docs/host/personal-migration-release-table.md). A CINDY_HOST_REGION naming the other edition refuses
// rather than being ignored: an operator who kept CINDY_HOST_REGION=global from an old systemd unit
// while installing the cn release must find out. Minimal failing input: release cn with
// CINDY_HOST_REGION=global returning cn (silently ignored) or global (env wins).
test('a release answers its build region and refuses a CINDY_HOST_REGION of the other edition', () => {
  assert.equal(resolveHostRegion(undefined, 'cn'), 'cn');
  assert.equal(resolveHostRegion('cn', 'cn'), 'cn');
  assert.throws(() => resolveHostRegion('global', 'cn'), /HOST_REGION_MISMATCH: this Cindy Host release is the cn edition, but CINDY_HOST_REGION is global/);
  assert.throws(() => resolveHostRegion('cn', 'global'), /HOST_REGION_MISMATCH/);
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

// Release table row 25 (25b): the desktop's Electron appData does not follow $HOME on macOS (measured
// with the repo's Electron under a temp HOME: desktop lock dir outside it, Host lock dir inside), so
// a desktop launching the Host passes its appData and the Host must use exactly that; the Skill
// mutation locks and built-in bundle under <appData>/Cindy depend on it. Gap: no test covered the
// source of the Host's appData. Minimal failure: a passed value ignored in favour of $HOME/APPDATA.
// Tier: unit.
test('the Host uses the app-data root passed by its launcher, refuses a relative one, and computes it otherwise', () => {
  const passed = path.join(os.tmpdir(), 'cindy-passed-app-data');
  assert.equal(resolveHostAppDataDir({ env: { CINDY_HOST_APP_DATA_DIR: passed, APPDATA: path.join(os.tmpdir(), 'other') } }), passed);
  assert.equal(resolveHostDataDir({ env: { CINDY_HOST_APP_DATA_DIR: passed } }), path.join(passed, 'CindyHost', 'global'));
  assert.throws(() => resolveHostAppDataDir({ env: { CINDY_HOST_APP_DATA_DIR: 'relative/app-data' } }), /must be an absolute directory/);
  const computed = path.join(os.tmpdir(), 'cindy-computed-app-data');
  assert.equal(resolveHostAppDataDir({ env: { APPDATA: computed } }), computed);
  assert.equal(resolveHostAppDataDir({ env: { CINDY_HOST_APP_DATA_DIR: '', APPDATA: computed } }), computed);
});
