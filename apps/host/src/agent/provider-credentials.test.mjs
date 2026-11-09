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
  const list = createProviderCatalog({ readCustom: async () => [], fetchModels: async ({ credential }) => {
    if (credential !== 'account-a-key') throw new Error('denied');
    return [{ id: 'private-model' }];
  } });
  const gateway = { endpoint: 'https://gateway.example', credential: 'account-a-key' };
  assert.equal((await list({ gateway, ownerId: 'a' })).providers.length, 1);
  assert.equal((await list({ gateway: { ...gateway, credential: 'account-b-key' }, ownerId: 'b' })).providers.length, 0);
  assert.equal((await list({ gateway: { ...gateway, credential: 'rotated-key' }, ownerId: 'a' })).providers.length, 0);
});
