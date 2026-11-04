import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPreparedLinuxCredentialStore, SafeStorageUnavailableError } from './store.mjs';
import { decryptOsCryptPayload, deriveLinuxOsCryptKey, encryptOsCryptPayload } from './oscrypt.mjs';

// Fixed synthetic keyring password: the codec is exercised without touching the
// real user keyring, while the production path was measured separately against
// an actual Desktop ciphertext.
const TEST_SECRET = 'test-only-keyring-secret';
const testKey = () => deriveLinuxOsCryptKey(TEST_SECRET);

function tempProfile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-credentials-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('round-trips a v11 payload and rejects a foreign key', () => {
  const payload = encryptOsCryptPayload('token-value', testKey());
  assert.equal(decryptOsCryptPayload(payload, testKey()), 'token-value');
  assert.throws(() => decryptOsCryptPayload(payload, deriveLinuxOsCryptKey('other')));
  assert.throws(() => decryptOsCryptPayload(Buffer.from('v10abc').toString('base64'), testKey()), /prefix/);
});

test('writes the same base64 v11 layout Desktop uses, with owner-only permissions', async (t) => {
  const userDataDir = tempProfile(t);
  const store = await createPreparedLinuxCredentialStore({ userDataDir, keyPromise: Promise.resolve(testKey()) });
  store.write('session', 'secret-value');

  const file = path.join(userDataDir, 'safe-storage', 'session.enc');
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(Buffer.from(raw, 'base64').subarray(0, 3).toString('latin1'), 'v11');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(store.read('session'), 'secret-value');
  assert.equal(store.read('missing'), null);

  store.remove('session');
  assert.equal(store.read('session'), null);
  store.remove('session');
});

test('replaces an existing record atomically instead of leaving a truncated file', async (t) => {
  const userDataDir = tempProfile(t);
  const store = await createPreparedLinuxCredentialStore({ userDataDir, keyPromise: Promise.resolve(testKey()) });
  store.write('session', 'first');
  store.write('session', 'second');
  assert.equal(store.read('session'), 'second');
  const leftovers = fs.readdirSync(path.join(userDataDir, 'safe-storage')).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

test('missing Secret Service fails explicitly instead of degrading to plaintext', async (t) => {
  const userDataDir = tempProfile(t);
  await assert.rejects(
    createPreparedLinuxCredentialStore({
      userDataDir,
      keyPromise: Promise.reject(new Error('Secret Service is not available')),
    }),
    (error) => error instanceof SafeStorageUnavailableError && error.code === 'CREDENTIAL_STORE_UNAVAILABLE',
  );
  assert.equal(fs.existsSync(path.join(userDataDir, 'safe-storage', 'session.enc')), false);
});

test('payload produced here decodes with the measured Desktop parameters', () => {
  // Guards the constants that were verified against real ciphertext: 16-byte
  // AES-128 key from one PBKDF2-SHA1 round, 16-space IV, "v11" prefix.
  const key = testKey();
  assert.equal(key.length, 16);
  const payload = Buffer.from(encryptOsCryptPayload('x', key), 'base64');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  assert.equal(
    Buffer.concat([decipher.update(payload.subarray(3)), decipher.final()]).toString('utf8'),
    'x',
  );
});
