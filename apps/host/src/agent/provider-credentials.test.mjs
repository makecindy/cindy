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

// A fake of the active-catalog XD snapshot with the setter semantics the catalog relies on: the list,
// the authority mark and the payment refusals (kept only when the caller asks to preserve them).
const fakeSnapshot = () => {
  const state = { models: [], authoritative: false, paid: [] };
  return {
    state,
    applyModels: (models, options) => {
      state.models = models;
      state.authoritative = options.authoritative;
      if (!options.preservePaymentRequiredRoutes) state.paid = models.filter(m => m.availability === 'requires_payment').map(m => m.id);
    },
    readModels: () => state.models,
    markModelsUnknown: () => { state.authoritative = false; },
  };
};

test('after an owner, generation or endpoint change, a failed refresh does not expose the old list', async () => {
  for (const change of ['owner', 'generation', 'endpoint']) {
    const snapshot = fakeSnapshot();
    let fail = false;
    const list = createProviderCatalog({ ...snapshot,
      readProviders: async () => snapshot.state.models.length ? [{ id: 'xd', models: snapshot.state.models }] : [],
      fetchModels: async () => {
        if (fail) throw new Error('denied');
        return [{ id: 'private-model' }, { id: 'paid-model', availability: 'requires_payment' }];
      } });
    const gateway = { endpoint: 'https://gateway.example', credential: 'account-a-key' };
    assert.equal((await list({ gateway, ownerId: 'a', ownerGeneration: 1 })).providers.length, 1, change);
    fail = true;
    const next = change === 'owner' ? { gateway, ownerId: 'b', ownerGeneration: 1 }
      : change === 'generation' ? { gateway, ownerId: 'a', ownerGeneration: 2 }
        : { gateway: { ...gateway, endpoint: 'https://other-gateway.example' }, ownerId: 'a', ownerGeneration: 1 };
    const result = await list(next);
    assert.ok(result.error, change);
    assert.equal(result.providers.length, 0, change);
    assert.deepEqual(snapshot.state, { models: [], authoritative: false, paid: [] }, change);
  }
});

test('after a key-only change, a failed refresh keeps the old list and payment refusals, non-authoritative', async () => {
  const snapshot = fakeSnapshot();
  const credentials = [];
  const list = createProviderCatalog({ ...snapshot,
    readProviders: async () => [{ id: 'xd', models: snapshot.state.models }],
    fetchModels: async ({ credential }) => {
      credentials.push(credential);
      if (credential !== 'account-a-key') throw new Error('denied');
      return [{ id: 'private-model' }, { id: 'paid-model', availability: 'requires_payment' }];
    } });
  const gateway = { endpoint: 'https://gateway.example', credential: 'account-a-key' };
  await list({ gateway, ownerId: 'a' });
  assert.deepEqual(snapshot.state.paid, ['paid-model']);
  assert.equal(snapshot.state.authoritative, true);
  // The rotated key is refetched at once, without waiting for the five-minute cache.
  const result = await list({ gateway: { ...gateway, credential: 'rotated-key' }, ownerId: 'a' });
  assert.deepEqual(credentials, ['account-a-key', 'rotated-key']);
  assert.ok(result.error);
  assert.deepEqual(result.providers[0].models, [{ id: 'private-model' }]);
  assert.deepEqual(snapshot.state, { models: [{ id: 'private-model' }], authoritative: false, paid: ['paid-model'] });
});

// Port contract: a failed refresh keeps the list currently in the shared snapshot (main.ts reads it
// with getXdGatewayModels), as the desktop's runModelsSync does, not a private copy of the last
// success. Inside the Host only this catalog writes that snapshot, so the two agree today.
test('a failed refresh keeps the current snapshot list, read through the port', async () => {
  const snapshot = fakeSnapshot();
  let fail = false;
  const list = createProviderCatalog({ ...snapshot, readProviders: async () => [],
    fetchModels: async () => {
      if (fail) throw new Error('denied');
      return [{ id: 'allowed' }];
    } });
  const options = { ownerId: 'a', gateway: { endpoint: 'https://gateway.example', credential: 'fixture' } };
  await list(options);
  snapshot.state.models = [{ id: 'current' }, { id: 'upsell', availability: 'requires_payment' }];
  fail = true;
  await list({ ...options, force: true });
  assert.deepEqual(snapshot.state.models, [{ id: 'current' }]);
});

// Unit regression: a forced refresh that failed left the last success fresh, so the next read inside
// the cache window restored its authority (and dropped the payment refusals' preservation) without a
// successful round. The desktop stays non-authoritative until a round succeeds.
test('a failed refresh is not followed by a cached read that restores authority', async () => {
  const snapshot = fakeSnapshot();
  let fail = false;
  let calls = 0;
  const list = createProviderCatalog({ ...snapshot, readProviders: async () => [],
    fetchModels: async () => {
      calls++;
      if (fail) throw new Error('denied');
      return [{ id: 'allowed' }];
    } });
  const options = { ownerId: 'a', gateway: { endpoint: 'https://gateway.example', credential: 'fixture' } };
  await list(options);
  fail = true;
  await list({ ...options, force: true });
  assert.equal(snapshot.state.authoritative, false);
  await list(options);
  assert.equal(calls, 3);
  assert.equal(snapshot.state.authoritative, false);
  fail = false;
  await list(options);
  assert.equal(snapshot.state.authoritative, true);
});

// Unit regression: a retained catalog read used to return a hardcoded owner
// generation after an async refresh crossed sign-out. No real network is used.
test('catalog rejects an in-flight response after its owner generation changes', async () => {
  let owner = { dataOwnerId: 'a', generation: 7, pending: false };
  let resume;
  const list = createProviderCatalog({ readOwner: () => owner, applyModels() {}, readModels: () => [], fetchModels: async () => [],
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
    readModels: () => applied,
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
    readModels: () => applied,
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
