// Shared-handler integration with a controlled CLI adapter. No real login or
// credential is used; exercises controller ownership and account invalidation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHostAgentAuth } from './auth-service.ts';
import { configureHostOwner } from './claude-auth.mjs';

function fixture() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'host-login-controllers-'));
  configureHostOwner({ userDataDir: profile, ownerId: 'login-owner' });
  let complete;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pushes = [];
  let logins = 0;
  let cancellations = 0;
  const service = createHostAgentAuth({ readApiKey: () => null, publish: (...args) => pushes.push(args), maker: {
    triggerAgentLogin: async () => { logins++; entered(); return new Promise(resolve => { complete = resolve; }); },
    cancelAgentLogin: async () => { cancellations++; complete({ authenticated: false, errorReason: 'login_cancelled' }); },
    getAgentAuthState: async () => ({ authenticated: false }),
    refreshAgentLocalModels: async () => false,
    logoutAgent: async () => {},
  } });
  return { profile, service, pushes, started, get logins() { return logins; }, get cancellations() { return cancellations; },
    complete: state => complete(state),
    close() { service.close(); configureHostOwner({ userDataDir: profile, ownerId: null }); fs.rmSync(profile, { recursive: true, force: true }); },
  };
}

test('one controller cannot release another controller login and disconnecting one preserves the other', async () => {
  const f = fixture();
  try {
    const first = f.service.invoke('maker:auth:trigger-login', ['codex', { mode: 'device-code', ownerId: 'tab-a' }], 'web:a');
    await f.started;
    const second = f.service.invoke('maker:auth:trigger-login', ['codex', { mode: 'device-code', ownerId: 'tab-b' }], 'device:b');
    assert.equal(f.logins, 1);
    await f.service.invoke('maker:auth:cancel-login', ['codex', { releaseOwner: true, ownerId: 'tab-a' }], 'device:b');
    assert.equal(f.cancellations, 0);
    f.service.releaseCaller('web:a');
    assert.equal(f.cancellations, 0);
    f.service.releaseCaller('device:b');
    const results = await Promise.all([first, second]);
    assert.equal(f.cancellations, 1);
    assert.ok(results.every(result => result.authenticated === false));
  } finally { f.close(); }
});

test('a login result from the previous account is rejected and never broadcast to the new owner', async () => {
  const f = fixture();
  try {
    const pending = f.service.invoke('maker:auth:trigger-login', ['codex', { mode: 'device-code', ownerId: 'tab-a' }], 'web:a');
    await f.started;
    configureHostOwner({ userDataDir: f.profile, ownerId: 'another-owner' });
    f.complete({ authenticated: true, authSource: 'oauth' });
    await assert.rejects(pending, /AUTH_OWNER_CHANGED/);
    assert.deepEqual(f.pushes, []);
    await assert.rejects(f.service.invoke('maker:auth:get-state', ['codex'], 'web:a'), /AUTH_OWNER_CHANGED/);
  } finally { f.close(); }
});
