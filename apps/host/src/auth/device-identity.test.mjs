import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serializeAuthSessionRecord } from '@cindy/auth-client';
import { AUTH_SESSION_KEY } from '../../../desktop/src/main/authCredentialKeys.ts';
import { getOrCreateHostDeviceId, resolveSessionDevice, serializeHostSession, readSessionDeviceId, canRegisterHostDevice } from './device-identity.mjs';
import { refreshHostSession } from './refresh.mjs';

// Real files, synthetic credentials: a separate server must not disconnect the
// desktop by registering its physical device identity, including after restart.
test('Host identity persists per profile and differs between installations', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-device-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = getOrCreateHostDeviceId(path.join(root, 'a'), '');
  assert.equal(getOrCreateHostDeviceId(path.join(root, 'a'), ''), a);
  assert.notEqual(getOrCreateHostDeviceId(path.join(root, 'b'), ''), a);
  const raw = serializeHostSession('global', 'synthetic-refresh', a);
  assert.equal(resolveSessionDevice(raw, () => 'desktop', ''), a);
  assert.equal(canRegisterHostDevice(raw, () => 'desktop', ''), true);
  assert.throws(() => resolveSessionDevice(raw, () => 'desktop', 'other'), /identity changed/);
});
test('legacy records remain refreshable but cannot displace a desktop connection', () => {
  const raw = serializeAuthSessionRecord('cn', 'synthetic-old-refresh');
  assert.equal(resolveSessionDevice(raw, () => 'physical', ''), 'physical');
  assert.equal(canRegisterHostDevice(raw, () => 'physical', ''), false);
  assert.equal(canRegisterHostDevice(raw, () => 'physical', 'physical'), false);
  assert.equal(canRegisterHostDevice(raw, () => 'physical', 'isolated-preview'), true);
});
test('refresh rotation preserves the identity bound at login', async () => {
  let raw = serializeHostSession('global', 'synthetic-old-refresh', 'host-test');
  const store = { read: key => { assert.equal(key, AUTH_SESSION_KEY); return raw; }, write: (key, value) => { assert.equal(key, AUTH_SESSION_KEY); raw = value; } };
  await refreshHostSession({ store, refresh: async () => ({ accessToken: 'synthetic-access', refreshToken: 'synthetic-new-refresh' }) });
  assert.equal(readSessionDeviceId(raw), 'host-test');
  assert.equal(JSON.parse(raw).refreshToken, 'synthetic-new-refresh');
});
test('corrupt identity fails closed without replacing the profile identity', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-device-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'host-device.json');
  fs.writeFileSync(file, '{incomplete');
  assert.throws(() => getOrCreateHostDeviceId(root, ''));
  assert.equal(fs.readFileSync(file, 'utf8'), '{incomplete');
  assert.throws(() => readSessionDeviceId(JSON.stringify({ version: 1, realm: 'global', refreshToken: 'synthetic', hostDeviceId: '../bad' })), /Invalid/);
});
