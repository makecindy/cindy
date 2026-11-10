import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isAuthorized, readOrCreateApiToken } from './api-token.mjs';

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
