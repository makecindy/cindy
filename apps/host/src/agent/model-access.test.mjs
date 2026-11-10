import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureHostOwner } from './claude-auth.mjs';
import { createHostModelAccess } from './model-access.ts';

function fixture(request) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'host-model-access-'));
  configureHostOwner({ userDataDir: profile, ownerId: 'gateway-owner' });
  let key = null;
  let changed = 0;
  let requests = 0;
  const statuses = [];
  const service = createHostModelAccess({ ownerId: 'gateway-owner', region: 'global',
    readKey: () => key, writeKey: value => { key = value; return true; },
    request: (...args) => { requests++; return request(...args); },
    publish: status => statuses.push(status), onKeyChanged: () => { changed++; },
  });
  return { service, profile, statuses, get key() { return key; }, get changed() { return changed; },
    get requests() { return requests; },
    close() { service.close(); configureHostOwner({ userDataDir: profile, ownerId: null }); fs.rmSync(profile, { recursive: true, force: true }); },
  };
}

test('live gateway uses the shared credential store and refreshes once for a rejected current key', async () => {
  let payload = { endpoint: 'https://gateway.invalid/', apiKey: 'fixture-key-1' };
  const f = fixture(async () => payload);
  try {
    await f.service.start();
    const gateway = f.service.gateway;
    assert.equal(gateway.credential, 'fixture-key-1');
    assert.equal(gateway.endpoint, 'https://gateway.invalid');
    assert.equal(f.service.sync.getStatus().state, 'ok');
    assert.equal(f.changed, 1);
    await f.service.sync.sync();
    assert.equal(f.changed, 1, 'unchanged credentials must not restart Codex');
    payload = { endpoint: 'https://next-gateway.invalid', apiKey: 'fixture-key-2' };
    f.service.reportRejectedKey('fixture-key-1');
    f.service.reportRejectedKey('fixture-key-1');
    await f.service.sync.sync();
    assert.equal(gateway.credential, 'fixture-key-2');
    assert.equal(gateway.endpoint, 'https://next-gateway.invalid');
    assert.equal(f.changed, 2);
    assert.equal(f.requests, 3);
    assert.equal(f.service.isReplacedKey('fixture-key-1'), true);
    f.service.reportRejectedKey('fixture-key-1');
    assert.equal(f.requests, 3, 'old child-process failures cannot rotate a new credential');
    assert.ok(!JSON.stringify(f.statuses).includes('fixture-key'));
    f.service.close();
    assert.equal(gateway.credential, '');
    assert.equal(gateway.endpoint, '');
  } finally { f.close(); }
});

test('an in-flight result from a previous account cannot write credentials or publish readiness', async () => {
  let resolve;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  try {
    const started = f.service.start();
    configureHostOwner({ userDataDir: f.profile, ownerId: 'next-owner' });
    resolve({ endpoint: 'https://old.invalid', apiKey: 'old-owner-key' });
    await assert.rejects(started, /MODEL_ACCESS_OWNER_CHANGED/);
    assert.equal(f.key, null);
    assert.equal(f.changed, 0);
    assert.equal(f.service.gateway.credential, '');
    assert.equal(f.statuses.some(status => status.state === 'ok'), false);
  } finally { f.close(); }
});
