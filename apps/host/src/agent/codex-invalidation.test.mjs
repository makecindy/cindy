// Unit: a server-rejected native OpenAI login is invalidated only in the profile's own
// codex-home, only when the rejected credential is still the current one, and in the
// desktop's order. Every file and token is synthetic and lives in a new temporary
// profile; HOME points at an empty directory that must stay empty.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { invalidateHostCodexLogin } from './codex-invalidation.ts';
import { createCodexLocalCliAuth } from './runtime.ts';
import { configureHostOwner } from './claude-auth.mjs';
import {
  bindNativeProviderAuth, isNativeProviderAuthBound, isNativeProviderAuthRevoked,
} from '../../../desktop/src/main/maker-host/nativeProviderAuthBinding.ts';
import {
  getCodexAuthInvalidationMarkerPath, readInvalidatedSystemCodexAuthMarker, writeInvalidatedSystemCodexAuthMarker,
} from '../../../desktop/src/main/maker-host/codex-auth-invalidation.ts';
import { currentCodexCredentialGeneration } from '../../../desktop/src/main/maker-host/codexCredentialRead.ts';
import { createHostCodexCredentials } from './codex-credentials.ts';

const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'host-codex-invalidation-home-'));
const originalHome = process.env.HOME;
process.env.HOME = emptyHome;
test.after(() => {
  process.env.HOME = originalHome;
  fs.rmSync(emptyHome, { recursive: true, force: true });
});

const isLink = file => { try { return fs.lstatSync(file).isSymbolicLink(); } catch { return false; } };

function profile(t, token = 'fixture-token-1') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-codex-invalidation-'));
  const codexHome = path.join(dir, 'codex-home');
  fs.mkdirSync(codexHome);
  configureHostOwner({ userDataDir: dir, ownerId: 'invalidation-owner' });
  const authPath = path.join(codexHome, 'auth.json');
  const write = value => fs.writeFileSync(authPath, JSON.stringify({ tokens: { access_token: value, account_id: 'fixture-workspace' } }), { mode: 0o600 });
  write(token);
  fs.writeFileSync(path.join(codexHome, 'models_cache.json'), '{"models":[]}');
  bindNativeProviderAuth('openai', { instanceIsolated: true });
  t.after(() => {
    configureHostOwner({ userDataDir: dir, ownerId: null });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, codexHome, authPath, write, auth: createCodexLocalCliAuth(null, undefined, codexHome) };
}

test('the rejected current login is marked, unbound and removed, then announced', async t => {
  const p = profile(t);
  const rejected = currentCodexCredentialGeneration(p.authPath);
  const steps = [];
  const result = await invalidateHostCodexLogin({
    codexHome: p.codexHome, reason: 'token_revoked', failedAccessToken: 'fixture-token-1',
    credentialGeneration: JSON.stringify(rejected),
    disposeLocalHost: async () => {
      steps.push(['dispose', fs.existsSync(p.authPath), fs.existsSync(path.join(p.codexHome, 'models_cache.json'))]);
    },
    onInvalidated: scope => steps.push(['announce', scope, readInvalidatedSystemCodexAuthMarker(p.codexHome)?.reason]),
  });
  assert.equal(result, 'invalidated');
  // Host retired after the credential is gone, before the account-less cache is dropped.
  assert.deepEqual(steps, [['dispose', false, true], ['announce', 'instance-isolated', 'token_revoked']]);
  const marker = readInvalidatedSystemCodexAuthMarker(p.codexHome);
  assert.equal(marker.credentialScope, 'instance-isolated');
  assert.equal(marker.localSha256, rejected.sha256);
  assert.equal(marker.localIno, Number(rejected.ino));
  assert.equal(marker.recoveryOwnerId, undefined);
  assert.equal(marker.unprovenCredentialAttribution, undefined);
  assert.equal(fs.existsSync(path.join(p.codexHome, 'models_cache.json')), false);
  assert.equal(isNativeProviderAuthBound('openai'), false);
  assert.equal(isNativeProviderAuthRevoked('openai'), false, 'a server invalidation is not a user disconnect');
  assert.deepEqual(await p.auth.getState({ providerId: 'openai' }),
    { authenticated: false, errorReason: 'token_revoked', credentialScope: 'instance-isolated' });

  // A new explicit login replaces the rejected credential and reads as signed in.
  p.write('fixture-token-2');
  bindNativeProviderAuth('openai', { instanceIsolated: true });
  assert.equal((await p.auth.getState({ providerId: 'openai' })).authSource, 'oauth');
});

test('a credential replaced before the failure arrived is left alone', async t => {
  for (const late of [
    { failedAccessToken: 'fixture-token-old' },
    { credentialGeneration: JSON.stringify({ dev: '1', ino: '1', size: 1, mtimeMs: 1, sha256: 'f'.repeat(64) }) },
  ]) {
    const p = profile(t);
    const before = fs.readFileSync(p.authPath, 'utf8');
    let called = false;
    const result = await invalidateHostCodexLogin({ codexHome: p.codexHome, reason: 'token_revoked', ...late,
      disposeLocalHost: async () => { called = true; }, onInvalidated: () => { called = true; } });
    assert.equal(result, 'stale');
    assert.equal(called, false);
    assert.equal(fs.readFileSync(p.authPath, 'utf8'), before);
    assert.equal(fs.existsSync(getCodexAuthInvalidationMarkerPath(p.codexHome)), false);
    assert.equal(isNativeProviderAuthBound('openai'), true);
  }
});

test('independent accounts and logged-out profiles change nothing', async t => {
  const p = profile(t);
  const before = fs.readFileSync(p.authPath, 'utf8');
  let called = false;
  const result = await invalidateHostCodexLogin({ codexHome: p.codexHome, reason: 'token_revoked',
    providerId: 'openai-account-fixture', failedAccessToken: 'fixture-token-1',
    disposeLocalHost: async () => { called = true; }, onInvalidated: () => { called = true; } });
  assert.equal(result, 'not-native');
  assert.equal(called, false);
  assert.equal(fs.readFileSync(p.authPath, 'utf8'), before);
  assert.equal(fs.existsSync(getCodexAuthInvalidationMarkerPath(p.codexHome)), false);
  assert.equal(isNativeProviderAuthBound('openai'), true);
  fs.rmSync(p.authPath);
  assert.equal(await invalidateHostCodexLogin({ codexHome: p.codexHome, reason: 'token_revoked' }), 'stale');
  assert.equal(fs.existsSync(getCodexAuthInvalidationMarkerPath(p.codexHome)), false);
});

test('an unattributed failure suppresses the current login without touching it', async t => {
  const p = profile(t);
  const before = fs.readFileSync(p.authPath, 'utf8');
  const steps = [];
  const result = await invalidateHostCodexLogin({ codexHome: p.codexHome, reason: 'token_revoked', credentialAttribution: 'unproven',
    loginInProgress: () => false,
    disposeLocalHost: async () => { steps.push('dispose'); },
    onInvalidated: scope => steps.push(['announce', scope]) });
  assert.equal(result, 'unproven');
  // As the desktop: no logout cleanup, only the broadcast.
  assert.deepEqual(steps, [['announce', 'instance-isolated']]);
  assert.equal(fs.readFileSync(p.authPath, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(p.codexHome, 'models_cache.json')), true);
  assert.equal(isNativeProviderAuthBound('openai'), true);
  const marker = readInvalidatedSystemCodexAuthMarker(p.codexHome);
  assert.equal(marker.unprovenCredentialAttribution, true);
  assert.equal(marker.credentialScope, 'instance-isolated');
  assert.deepEqual(await p.auth.getState({ providerId: 'openai' }),
    { authenticated: false, errorReason: 'token_revoked', credentialScope: 'instance-isolated' });
  const credentials = createHostCodexCredentials(p.dir, { codexAccountState: () => ({ authenticated: false }), codexAccountHome: () => { throw new Error('unexpected'); } });
  assert.equal(credentials.hasLogin(), false, 'the suppressed credential is not dispatched');

  p.write('fixture-token-2');
  assert.equal((await p.auth.getState({ providerId: 'openai' })).authSource, 'oauth');
  assert.equal(credentials.hasLogin(), true);
});

test('an unattributed failure during a login or after a disconnect changes nothing', async t => {
  const during = profile(t);
  let called = false;
  assert.equal(await invalidateHostCodexLogin({ codexHome: during.codexHome, reason: 'token_revoked', credentialAttribution: 'unproven',
    loginInProgress: () => true, onInvalidated: () => { called = true; } }), 'stale');
  assert.equal(fs.existsSync(getCodexAuthInvalidationMarkerPath(during.codexHome)), false);

  const after = profile(t);
  assert.equal(writeInvalidatedSystemCodexAuthMarker(after.codexHome, path.join(after.codexHome, 'missing-system-auth.json'),
    'user_disconnected', after.authPath), true);
  const marker = fs.readFileSync(getCodexAuthInvalidationMarkerPath(after.codexHome), 'utf8');
  assert.equal(await invalidateHostCodexLogin({ codexHome: after.codexHome, reason: 'token_revoked', credentialAttribution: 'unproven',
    loginInProgress: () => false, onInvalidated: () => { called = true; } }), 'stale');
  assert.equal(fs.readFileSync(getCodexAuthInvalidationMarkerPath(after.codexHome), 'utf8'), marker);
  assert.equal(called, false);
});

test('a late failure after an explicit disconnect does not reopen the sign-in prompt', async t => {
  const p = profile(t);
  assert.equal(writeInvalidatedSystemCodexAuthMarker(p.codexHome, path.join(p.codexHome, 'missing-system-auth.json'),
    'user_disconnected', p.authPath), true);
  const marker = fs.readFileSync(getCodexAuthInvalidationMarkerPath(p.codexHome), 'utf8');
  let called = false;
  const result = await invalidateHostCodexLogin({ codexHome: p.codexHome, reason: 'token_revoked', failedAccessToken: 'fixture-token-1',
    onInvalidated: () => { called = true; } });
  assert.equal(result, 'stale');
  assert.equal(called, false);
  assert.equal(fs.readFileSync(getCodexAuthInvalidationMarkerPath(p.codexHome), 'utf8'), marker);
});

test('an unwritable marker falls back to revoking the native authorization', async t => {
  const p = profile(t);
  // A non-empty directory where the marker belongs makes the atomic rename fail.
  fs.mkdirSync(path.join(getCodexAuthInvalidationMarkerPath(p.codexHome), 'occupied'), { recursive: true });
  let scope = null;
  const result = await invalidateHostCodexLogin({ codexHome: p.codexHome, reason: 'token_revoked', failedAccessToken: 'fixture-token-1',
    onInvalidated: value => { scope = value; } });
  assert.equal(result, 'invalidated');
  assert.equal(scope, 'unknown');
  assert.equal(isNativeProviderAuthRevoked('openai'), true);
  assert.equal(fs.existsSync(p.authPath), false);
  assert.equal((await p.auth.getState({ providerId: 'openai' })).authenticated, false);
});

test('a login linked to a file outside the profile: neither invalidation changes that file', async t => {
  for (const link of ['hard', 'symbolic']) {
    for (const attribution of ['attributed', 'unattributed']) {
      const p = profile(t);
      // A migrated profile: codex-home/auth.json is a link to a login kept elsewhere.
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'host-codex-linked-login-'));
      t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
      const target = path.join(outside, 'auth.json');
      fs.writeFileSync(target, JSON.stringify({ tokens: { access_token: 'linked-token', account_id: 'fixture-workspace' } }), { mode: 0o600 });
      fs.rmSync(p.authPath);
      if (link === 'hard') fs.linkSync(target, p.authPath); else fs.symlinkSync(target, p.authPath);
      const before = { bytes: fs.readFileSync(target, 'utf8'), stat: fs.statSync(target) };
      const result = await invalidateHostCodexLogin({ codexHome: p.codexHome, reason: 'token_revoked',
        ...(attribution === 'attributed' ? { failedAccessToken: 'linked-token' } : { credentialAttribution: 'unproven', loginInProgress: () => false }) });
      assert.equal(result, attribution === 'attributed' ? 'invalidated' : 'unproven', `${link}/${attribution}`);
      const after = fs.statSync(target);
      assert.equal(fs.readFileSync(target, 'utf8'), before.bytes, `${link}/${attribution}: content`);
      assert.equal(after.ino, before.stat.ino, `${link}/${attribution}: inode`);
      assert.equal(after.mtimeMs, before.stat.mtimeMs, `${link}/${attribution}: modification time`);
      assert.deepEqual(fs.readdirSync(outside), ['auth.json'], `${link}/${attribution}: nothing else written beside it`);
      // Only the profile's own entry goes, and only for an attributed invalidation.
      assert.equal(fs.existsSync(p.authPath) || isLink(p.authPath), attribution === 'unattributed', `${link}/${attribution}: profile entry`);
    }
  }
});

test('HOME stays empty: the system Codex login is never read or written', () => {
  assert.deepEqual(fs.readdirSync(emptyHome), []);
});
