import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isAuthorized, readOrCreateApiToken } from './api-token.mjs';
import { publishHostEndpoint, readHostEndpoint, readHostProcessStatus, requestHostStop } from './control.mjs';
import { acquireHostServiceLease } from './runtime-lock.ts';

test('creates one owner-only token and reuses it across restarts', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-token-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const first = readOrCreateApiToken(dir);
  assert.ok(first.length >= 32);
  // POSIX permission bits do not exist on Windows; the file lives in the owner's profile there.
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(dir, 'host-api-token')).mode & 0o777, 0o600);
  }
  assert.equal(readOrCreateApiToken(dir), first);
});

test('rejects missing, malformed and wrong bearer tokens', () => {
  const token = 'a'.repeat(43);
  assert.equal(isAuthorized(`Bearer ${token}`, token), true);
  assert.equal(isAuthorized(undefined, token), false);
  assert.equal(isAuthorized(token, token), false);
  assert.equal(isAuthorized('Bearer short', token), false);
  assert.equal(isAuthorized(`Bearer ${'b'.repeat(43)}`, token), false);
  assert.equal(isAuthorized(`Bearer ${token}`, ''), false);
});

test('a profile has one service owner and old cleanup cannot delete its replacement', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-lease-'));
  const leases = [];
  // Windows cannot delete the SQLite lock file while a lease still holds it.
  t.after(() => { for (const lease of leases) lease.release(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.deepEqual(await readHostProcessStatus(dir), { running: false });
  assert.deepEqual(await requestHostStop(dir), { stopping: false, running: false });
  const first = acquireHostServiceLease(dir);
  assert.equal(first.held, true);
  leases.push(first);
  const cleanup = publishHostEndpoint(dir, 'http://127.0.0.1:3456', 'old-instance');
  assert.equal(acquireHostServiceLease(dir).held, false);
  assert.equal(readHostEndpoint(dir).instanceId, 'old-instance');
  first.release();
  const replacement = acquireHostServiceLease(dir);
  assert.equal(replacement.held, true);
  leases.push(replacement);
  const cleanupReplacement = publishHostEndpoint(dir, 'http://127.0.0.1:3457', 'new-instance');
  cleanup();
  assert.equal(readHostEndpoint(dir).instanceId, 'new-instance');
  cleanupReplacement();
  assert.equal(readHostEndpoint(dir), null);
});

test('discovery never sends the profile bearer to a non-loopback or redirected address', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-control-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const baseUrl of ['https://example.com:3456', 'http://localhost:3456', 'http://127.0.0.1:3456/api',
    'http://user@127.0.0.1:3456', 'http://127.0.0.1:3456?redirect=1']) {
    publishHostEndpoint(dir, baseUrl, 'test');
    assert.throws(() => readHostEndpoint(dir), /Invalid local Host endpoint/);
  }
});
