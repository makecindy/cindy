// #10644: exercise Host's production routes + reused Desktop handlers, using
// in-memory SQLite and the real encrypted credential store with synthetic keys.
// Existing auth and provider-route tests cannot create a provider through Host.
// Minimal failures: missing caller, valid Pi config, invalid discovery URL,
// credential write failure, and a caller retained across an owner generation.
// Tier: integration (SQLite + temporary credential files; no network/CLI).
// Standalone timing: 3.2s on Linux. New file: provider-config had no test.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../../desktop/src/main/localDb/schema.ts';
import { createDbClientForHandle } from '../../../desktop/src/main/localDb/client/createDbClientForHandle.ts';
import { clearCurrentDbClient, setCurrentDbClient } from '../../../desktop/src/main/localDb/client/current.ts';
import { getCustomProvider } from '../../../desktop/src/main/maker-host/custom-provider-store.ts';
import { getActiveCatalog, setCustomProviders } from '../../../desktop/src/main/maker-host/active-catalog.ts';
import { configureAppDataDir } from '../../../desktop/src/main/userDataPath.ts';
import { customProviderHeaderStorageKey, customProviderSecretStorageKey, providerOAuthStorageKey } from '../../../desktop/src/shared/providerSecrets.ts';
import { dataOwnerStorageKey } from '../../../desktop/src/main/dataOwnerPath.ts';
import { createCredentialStore } from '../credentials/store.mjs';
import { createHostService } from '../service.mjs';
import { hostOutbound } from '../outbound.mjs';
import { lifoCleanup } from '../test-support/cleanup.mjs';
import { configureHostOwner } from './claude-auth.mjs';
import { createHostProviderConfig } from './provider-config.ts';
import { createAvailabilityPolicy } from '../../../desktop/src/main/device-link/providerShareAvailabilityPolicyCore.ts';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-provider-create-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => root);
  configureAppDataDir(path.join(root, 'app-data'));
  const ownerId = 'provider-fixture';
  configureHostOwner({ userDataDir: root, ownerId });
  t.after(() => { setCustomProviders([]); configureHostOwner({ userDataDir: root, ownerId: null }); });
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE custom_providers (
    id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, runtimes TEXT NOT NULL DEFAULT '{}',
    auth TEXT, sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  const client = createDbClientForHandle({ db, drizzle: drizzle(db, { schema }), dispose: async () => db.close() });
  setCurrentDbClient(client, ownerId);
  t.after(async () => { clearCurrentDbClient(client); await client.dispose(); });
  const credentials = await createCredentialStore({ userDataDir: root, platform: 'linux', keyPromise: Promise.resolve(Buffer.alloc(16, 7)) });
  const events = [];
  const policy = createAvailabilityPolicy(async () => { throw new Error('Unexpected share revocation'); });
  const config = createHostProviderConfig({ profileDir: root, ownerId, credentials,
    withAvailabilityPolicyMutation: (id, work) => policy.withAvailabilityPolicyMutation(id, work),
    openExternal: async () => { throw new Error('Unexpected browser request'); }, publish: (...args) => events.push(args) });
  t.after(() => config.close());
  const service = createHostService({ providerInvoke: config.invoke });
  const invoke = (route, body, caller = 'web:fixture') => service(route, body, { caller });
  const secretPath = logical => path.join(root, 'safe-storage', `owner_${dataOwnerStorageKey(ownerId)}_${logical}.enc`);
  return { root, db, credentials, events, config, invoke, secretPath };
}
const createRoute = '/api/providers/custom/create';
const fetchRoute = '/api/providers/models-fetch';
const provider = id => ({ id, name: 'Fixture', runtimes: { pi: {
  baseUrl: 'https://provider.example.test/v1', wireProtocol: 'openai-chat',
  headers: { 'X-Fixture-Token': 'synthetic-header' }, models: [{ id: 'fixture-model', name: 'Fixture Model' }],
} } });
const discovery = { agent: 'pi', baseUrl: 'https://provider.example.test/v1', authMethod: 'apiKey', apiKey: 'synthetic-key', wireProtocol: 'openai-chat' };

test('provider routes require an authenticated caller and expose only create and discovery', async t => {
  const f = await fixture(lifoCleanup(t));
  for (const route of [createRoute, fetchRoute]) {
    assert.deepEqual(await f.invoke(route, {}, null), { status: 403, body: { error: 'authenticated_controller_required' } });
  }
  await assert.rejects(f.config.invoke('maker:provider:custom:delete', ['fixture'], 'web:fixture'), /UNSUPPORTED_CAPABILITY/);
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM custom_providers').get().count, 0);
});

test('create persists config and encrypted runtime secrets, refreshes catalog and rejects duplicate ids', async t => {
  const f = await fixture(lifoCleanup(t));
  const input = { config: provider('fixture'), keys: { pi: 'synthetic-key' } };
  assert.deepEqual(await f.invoke(createRoute, input), { status: 200, body: { ok: true } });
  const stored = await getCustomProvider('fixture');
  assert.equal(stored.runtimes.pi.headers, undefined);
  assert.equal(JSON.stringify(stored).includes('synthetic-key'), false);
  for (const [logical, plaintext] of [
    [customProviderSecretStorageKey('fixture', 'pi'), 'synthetic-key'],
    [customProviderHeaderStorageKey('fixture', 'pi'), JSON.stringify(input.config.runtimes.pi.headers)],
  ]) {
    const encrypted = fs.readFileSync(f.secretPath(logical), 'utf8');
    assert.equal(encrypted.includes(plaintext), false);
    assert.equal(f.credentials.decrypt(encrypted), plaintext);
  }
  assert.equal(f.config.readKey('fixture', 'pi'), 'synthetic-key');
  assert.ok(getActiveCatalog().providers.some(p => p.id === 'fixture'));
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0][0], 'maker:provider:changed');
  await assert.rejects(f.invoke(createRoute, input), /ALREADY_EXISTS/);
});

test('credential failure rolls staged secrets back without creating a config', async t => {
  const f = await fixture(lifoCleanup(t));
  const write = f.credentials.write;
  t.mock.method(f.credentials, 'write', (key, value) => {
    if (key.includes('header')) throw new Error('synthetic storage failure');
    write(key, value);
  });
  await assert.rejects(f.invoke(createRoute, { config: provider('failed'), keys: { pi: 'synthetic-key' } }), /synthetic storage failure/);
  assert.equal(await getCustomProvider('failed'), null);
  assert.equal(fs.existsSync(f.secretPath(customProviderSecretStorageKey('failed', 'pi'))), false);
  assert.deepEqual(f.events, []);
});

test('models-fetch applies Desktop validation and pins saved secret headers to the stored endpoint', async t => {
  const f = await fixture(lifoCleanup(t));
  const requests = [];
  t.mock.method(hostOutbound, 'outboundFetch', async (url, init) => {
    requests.push({ url: String(url), headers: new Headers(init.headers) });
    return Response.json({ data: [{ id: 'fixture-model' }] });
  });
  await assert.rejects(f.invoke(fetchRoute, { input: { ...discovery, baseUrl: 'file:///etc/passwd' } }), /INVALID_PARAMS/);
  assert.equal(requests.length, 0);
  const result = await f.invoke(fetchRoute, { input: discovery });
  assert.equal(result.body.ok, true);
  assert.equal(result.body.models[0].id, 'fixture-model');
  assert.equal(requests[0].headers.get('authorization'), 'Bearer synthetic-key');
  await f.invoke(createRoute, { config: provider('saved'), keys: { pi: 'synthetic-key' } });
  await f.invoke(fetchRoute, { input: { ...discovery, savedProviderId: 'saved', baseUrl: 'https://other.example.test' } });
  assert.equal(requests.at(-1).url, 'https://provider.example.test/v1/models');
  assert.equal(requests.at(-1).headers.get('x-fixture-token'), 'synthetic-header');
});

test('an old provider service cannot write after an account generation changes', async t => {
  const f = await fixture(lifoCleanup(t));
  configureHostOwner({ userDataDir: f.root, ownerId: 'other-owner' });
  await assert.rejects(f.invoke(createRoute, { config: provider('stale'), keys: {} }), /PROVIDER_OWNER_CHANGED/);
  assert.equal(await getCustomProvider('stale'), null);
  assert.deepEqual(f.events, []);
});

// The common credential reader must keep strict OAuth reads throwing while
// allowing explicit replacement of an undecryptable custom-provider snapshot.
test('corrupt secrets stay distinct from absent credentials for strict reads and mutations', async t => {
  const f = await fixture(lifoCleanup(t));
  const keyFile = f.secretPath(customProviderSecretStorageKey('corrupt', 'pi'));
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, 'invalid-fixture-ciphertext');
  const untouchedFile = f.secretPath(customProviderSecretStorageKey('untouched', 'pi'));
  fs.writeFileSync(untouchedFile, 'invalid-fixture-ciphertext');
  fs.writeFileSync(f.secretPath(providerOAuthStorageKey('corrupt')), 'invalid-fixture-ciphertext');
  assert.throws(() => f.config.recipeSecretIo.readStrict('corrupt'), /cannot be decrypted/);
  // Desktop create only stages keys explicitly supplied by the caller.
  assert.equal((await f.invoke(createRoute, { config: provider('untouched'), keys: {} })).body.ok, true);
  assert.equal(fs.readFileSync(untouchedFile, 'utf8'), 'invalid-fixture-ciphertext');
  assert.throws(() => f.config.readKey('untouched', 'pi'));
  assert.equal((await f.invoke(createRoute, { config: provider('corrupt'), keys: { pi: 'synthetic-replacement' } })).body.ok, true);
  assert.equal(f.config.readKey('corrupt', 'pi'), 'synthetic-replacement');
});
