import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCredentialStore, createPreparedLinuxCredentialStore, SafeStorageUnavailableError } from './store.mjs';
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
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
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

test('projects an adopted Desktop login without exposing the refresh token', async () => {
  const { projectAdoptedSession } = await import('./session.mjs');
  const { AUTH_SESSION_KEY } = await import('../../../desktop/src/main/authCredentialKeys.ts');

  const records = new Map([[AUTH_SESSION_KEY, JSON.stringify({ version: 1, realm: 'cn', refreshToken: 'r' })]]);
  const state = projectAdoptedSession({ read: (key) => records.get(key) ?? null });
  assert.deepEqual(state, { authenticated: true, realm: 'cn' });
  assert.equal(JSON.stringify(state).includes('refreshToken'), false);

  assert.deepEqual(projectAdoptedSession({ read: () => null }), { authenticated: false, realm: null });
  assert.deepEqual(
    projectAdoptedSession({ read: () => JSON.stringify({ version: 1, realm: 'global' }) }),
    { authenticated: false, realm: null },
  );
});

// PR #9246 native credential adapter (integration, isolated files + injected OS
// process): existing Linux tests did not cover identity or secret transport.
// Minimal regressions: CRLF CindyDev marker, truncated marker, helper failure.
test('macOS and Windows retain Desktop keychain identity and pass secrets only on stdin', async (t) => {
  for (const platform of ['darwin', 'win32']) {
    const userDataDir = tempProfile(t);
    fs.writeFileSync(path.join(userDataDir, 'keychain-identity'), 'CindyDev\r\n');
    const calls = [];
    const store = await createCredentialStore({ userDataDir, platform, electronBinary: 'test-electron',
      run: (binary, args, options) => {
        calls.push({ binary, args, options });
        const { operation, value } = JSON.parse(options.input);
        return { status: 0, stdout: JSON.stringify({ value: operation === 'encrypt' ? `sealed:${value}` : value.slice(7) }) };
      },
    });
    store.write('synthetic', 'test-only-secret');
    assert.equal(store.read('synthetic'), 'test-only-secret');
    assert.equal(calls.length, 2);
    for (const { args, options } of calls) {
      assert.equal(options.env.CINDY_HOST_CREDENTIAL_APP, 'CindyDev');
      assert.equal(options.env.CINDY_HOST_DATA_DIR, userDataDir);
      assert.equal(JSON.stringify(args).includes('test-only-secret'), false);
      assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined);
      assert.equal(options.env.NODE_OPTIONS, undefined);
    }
    assert.throws(() => store.write('../outside', 'x'), /invalid credential key/);
  }
});

test('native codec rejects an incomplete identity and does not replace a record when encryption fails', async (t) => {
  const userDataDir = tempProfile(t);
  const options = { userDataDir, platform: 'win32', electronBinary: 'test-electron',
    run: () => ({ status: 1, stderr: 'test-only-secret', stdout: '' }),
  };
  fs.writeFileSync(path.join(userDataDir, 'keychain-identity'), 'Cindy');
  await assert.rejects(createCredentialStore(options), /CREDENTIAL_IDENTITY_UNAVAILABLE/);
  fs.writeFileSync(path.join(userDataDir, 'keychain-identity'), 'Cindy\n');
  const store = await createCredentialStore(options);
  const storageDir = path.join(userDataDir, 'safe-storage');
  fs.mkdirSync(storageDir);
  fs.writeFileSync(path.join(storageDir, 'synthetic.enc'), 'existing ciphertext');
  assert.throws(() => store.write('synthetic', 'replacement'), /^Error: CREDENTIAL_STORE_UNAVAILABLE$/);
  assert.equal(fs.readFileSync(path.join(storageDir, 'synthetic.enc'), 'utf8'), 'existing ciphertext');
  assert.deepEqual(fs.readdirSync(storageDir), ['synthetic.enc']);
});
