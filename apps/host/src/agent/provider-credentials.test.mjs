import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderRouteResolver } from './provider-credentials.mjs';
import { dataOwnerStorageKey } from '../../../desktop/src/main/dataOwnerPath.ts';
import { createProviderCatalog } from './providers.mjs';
import { fetchGatewayCredentials } from './gateway.mjs';

// Fresh-profile regression: no copied desktop vault is needed after login.
// Unit: the production provisioning adapter must validate the response and
// preserve HTTP failures without returning keys in its error messages.
test('fresh Host login provisions a validated gateway connection', async () => {
  const connection = await fetchGatewayCredentials({ sessionToken: 'test-session', region: 'global', request: async (url, options) => {
    assert.ok(url.endsWith('/api/model-access/credentials'));
    assert.equal(options.headers.authorization, 'Bearer test-session');
    assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => ({ apiKey: 'test-key', endpoint: 'https://gateway.example/' }) };
  } });
  assert.deepEqual(connection, { credential: 'test-key', endpoint: 'https://gateway.example' });
  assert.equal(await fetchGatewayCredentials({ sessionToken: null, region: 'global', request: () => { throw Error('must not request'); } }), null);
  await assert.rejects(fetchGatewayCredentials({ sessionToken: 'test-session', region: 'global', request: async () => ({ ok: false, status: 403 }) }), /HOST_MODEL_ACCESS_HTTP_403/);
  await assert.rejects(fetchGatewayCredentials({ sessionToken: 'test-session', region: 'global', request: async () => ({ ok: true, json: async () => ({ apiKey: 'test-key', endpoint: 'file:///tmp' }) }) }), /HOST_MODEL_ACCESS_INVALID_RESPONSE/);
});

test('custom providers resolve only their own runtime credential and never reuse a gateway key', async () => {
  const reads = [];
  const resolve = createProviderRouteResolver({ ownerId: 'owner', catalog: async () => ({ providers: [{
    id: 'vendor', auth: { method: 'apiKey' }, routing: {
      'claude-code': { upstream: 'https://vendor.example/v1' },
      codex: { upstream: 'https://codex.example/v1' },
    },
  }] }), store: { read: key => { reads.push(key); return key.endsWith('_codex') ? 'codex-secret' : null; } } });
  await assert.rejects(resolve('vendor', 'claude-code'), /Connect this provider/);
  assert.equal((await resolve('vendor', 'codex')).apiKey, 'codex-secret');
  assert.deepEqual(reads, ['claude-code', 'codex'].map(agent => `owner_${dataOwnerStorageKey('owner')}_provider_key_vendor_${agent}`));
  await assert.rejects(resolve('unknown', 'codex'), /not configured/);
  assert.equal(await resolve('xd', 'codex'), null);
});

test('a failed catalog refresh cannot expose models from another account or credential', async () => {
  let models = [];
  const list = createProviderCatalog({ applyModels: value => { models = value; },
    readProviders: async () => models.length ? [{ id: 'xd', models }] : [], fetchModels: async ({ credential }) => {
    if (credential !== 'account-a-key') throw new Error('denied');
    return [{ id: 'private-model' }];
  } });
  const gateway = { endpoint: 'https://gateway.example', credential: 'account-a-key' };
  assert.equal((await list({ gateway, ownerId: 'a' })).providers.length, 1);
  assert.equal((await list({ gateway: { ...gateway, credential: 'account-b-key' }, ownerId: 'b' })).providers.length, 0);
  assert.equal((await list({ gateway: { ...gateway, credential: 'rotated-key' }, ownerId: 'a' })).providers.length, 0);
});

// Unit regression: a retained catalog read used to return a hardcoded owner
// generation after an async refresh crossed sign-out. No real network is used.
test('catalog rejects an in-flight response after its owner generation changes', async () => {
  let owner = { dataOwnerId: 'a', generation: 7, pending: false };
  let resume;
  const list = createProviderCatalog({ readOwner: () => owner, applyModels() {}, fetchModels: async () => [],
    readProviders: () => new Promise(resolve => { resume = resolve; }) });
  const result = list({ ownerId: 'a', gateway: null });
  owner = { ...owner, generation: 8 };
  resume([]);
  await assert.rejects(result, /PROVIDER_OWNER_CHANGED/);
});

// Race regression: an old credential fetch must never overwrite a newer one,
// even when the account generation itself has not changed.
test('model refresh is single-flight and rejects a stale credential response', async () => {
  let applied = [];
  let resume;
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const list = createProviderCatalog({
    readProviders: async () => [{ id: 'xd', models: applied }],
    applyModels: models => { applied = models; },
    fetchModels: async ({ credential }) => {
      calls++;
      if (credential === 'old') { started(); return new Promise(resolve => { resume = resolve; }); }
      return [{ id: 'current', contextWindow: 12345, agents: ['pi'] }];
    },
  });
  const gateway = { endpoint: 'https://gateway.example', credential: 'old' };
  const first = list({ ownerId: 'a', gateway });
  const joined = list({ ownerId: 'a', gateway });
  const stale = Promise.all([assert.rejects(first, /PROVIDER_CONNECTION_CHANGED/), assert.rejects(joined, /PROVIDER_CONNECTION_CHANGED/)]);
  await entered;
  assert.equal(calls, 1);
  const current = await list({ ownerId: 'a', gateway: { ...gateway, credential: 'new' } });
  assert.equal(current.providers[0].models[0].contextWindow, 12345);
  assert.deepEqual(current.providers[0].models[0].agents, ['pi']);
  resume([{ id: 'stale' }]);
  await stale;
  assert.equal(applied[0].id, 'current');
});

test('failed refresh preserves executable models but drops stale payment advertising', async () => {
  let applied = [];
  let fail = false;
  const list = createProviderCatalog({
    readProviders: async () => [{ id: 'xd', models: applied }],
    applyModels: models => { applied = models; },
    fetchModels: async () => {
      if (fail) throw Error('sensitive synthetic upstream failure');
      return [{ id: 'allowed' }, { id: 'upgrade', availability: 'requires_payment' }];
    },
  });
  const options = { ownerId: 'a', gateway: { endpoint: 'https://gateway.example', credential: 'fixture' } };
  await list(options);
  fail = true;
  const result = await list({ ...options, force: true });
  assert.deepEqual(result.providers[0].models, [{ id: 'allowed' }]);
  assert.ok(result.error);
  assert.ok(!JSON.stringify(result).includes('sensitive'));
});
