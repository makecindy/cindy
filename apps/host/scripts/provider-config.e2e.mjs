// Integration: real migrations, SQLite, shared header migration and credential
// files in a newly created profile. The injected key is synthetic; this does
// not exercise a user's keyring, OAuth provider or a real model.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configureHostOwner } from '../src/agent/claude-auth.mjs';
import { createHostProviderConfig } from '../src/agent/provider-config.ts';
import { createHostPiNativeProviders } from '../src/agent/pi-native-providers.ts';
import { createCredentialStore } from '../src/credentials/store.mjs';
import { hostRuntimeLayout } from '../src/runtime-layout.mjs';
import { openOwnerDatabase } from '../../desktop/src/main/localDb/startupCore.ts';
import { createDbClientForHandle } from '../../desktop/src/main/localDb/client/createDbClientForHandle.ts';
import { setCurrentDbClient, clearCurrentDbClient } from '../../desktop/src/main/localDb/client/current.ts';
import { createCustomProvider, listCustomProviders } from '../../desktop/src/main/maker-host/custom-provider-store.ts';
import { customProviderSecretStorageKey, customProviderHeaderStorageKey, providerOAuthStorageKey } from '../../desktop/src/shared/providerSecrets.ts';
import { dataOwnerStorageKey } from '../../desktop/src/main/dataOwnerPath.ts';
import { beginAppSessionBoundary } from '../../desktop/src/main/appSessionState.ts';
const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-host-provider-e2e-')));
const inheritedFormalProfile = process.env.XDT_OFFICIAL_SHARED_PROFILE;
delete process.env.XDT_OFFICIAL_SHARED_PROFILE;
const ownerId = 'provider-fixture-owner';
const key = logical => `owner_${dataOwnerStorageKey(ownerId)}_${logical}`;
let database, config, release;
try {
  configureHostOwner({ userDataDir: profile, ownerId });
  const layout = hostRuntimeLayout();
  const opened = await openOwnerDatabase({ userDataDir: profile, ownerId, isPackaged: false,
    drizzleDir: layout.drizzleDir, sqliteVecExtPath: layout.sqliteVecPath });
  database = createDbClientForHandle({ db: opened.db, drizzle: opened.drizzle, dispose: async () => opened.db.close() });
  setCurrentDbClient(database, ownerId);
  const credentials = await createCredentialStore({ userDataDir: profile, platform: 'linux', keyPromise: Promise.resolve(Buffer.alloc(16, 7)) });
  config = createHostProviderConfig({ profileDir: profile, ownerId, credentials,
    openExternal: async () => { throw Error('This fixture must not open a browser'); } });
  const runtime = { baseUrl: 'https://provider.invalid/v1', wireProtocol: 'openai-responses',
    models: [{ id: 'fixture-model', name: 'Fixture model', contextWindow: 8192, maxOutput: 1024 }] };
  await createCustomProvider({ id: 'key-fixture', name: 'Key fixture', auth: { method: 'apiKey' }, runtimes: { pi: runtime } });
  await createCustomProvider({ id: 'header-fixture', name: 'Header fixture', auth: { method: 'apiKey' },
    runtimes: { pi: { ...runtime, headers: { Authorization: 'Bearer synthetic-header-value' } } } });
  // Current CRUD correctly strips header secrets. Seed an old-format row to
  // exercise migration of installations created before encrypted headers.
  opened.db.prepare('UPDATE custom_providers SET runtimes = ? WHERE id = ?').run(
    JSON.stringify({ pi: { ...runtime, headers: { Authorization: 'Bearer synthetic-header-value' } } }),
    'header-fixture',
  );
  let views = await config.publicViews();
  assert.equal(views.find(p => p.id === 'key-fixture').connected, false);
  assert.equal(views.find(p => p.id === 'header-fixture').connected, true, JSON.stringify(views.find(p => p.id === 'header-fixture')));
  assert.equal(JSON.stringify(views).includes('synthetic-header-value'), false);
  assert.equal(JSON.stringify(await listCustomProviders()).includes('synthetic-header-value'), false, 'legacy header left SQLite');
  assert.equal(JSON.parse(credentials.read(key(customProviderHeaderStorageKey('header-fixture', 'pi')))).Authorization,
    'Bearer synthetic-header-value');
  credentials.write(key(customProviderSecretStorageKey('key-fixture', 'pi')), 'synthetic-api-key');
  views = await config.publicViews();
  assert.equal(views.find(p => p.id === 'key-fixture').connected, true);
  assert.equal(JSON.stringify(views).includes('synthetic-api-key'), false);
  // Pi's native providers through the Host's resolver (no Pi binary, no loopback proxy: custom providers only).
  const native = await createHostPiNativeProviders({ userDataDir: profile, piBinaryPath: null, endpoint: () => '',
    claudeProxy: null, providerConfig: config }).resolvePiNativeProviders({ workingDir: profile, model: 'fixture-model', purpose: 'preview' });
  const provider = native.providers.find(p => p.id === 'key-fixture');
  assert.ok(provider);
  assert.equal(provider.models[0].contextWindow, 8192);
  assert.ok(Object.values(native.env).includes('synthetic-api-key'));
  const token = JSON.stringify({ access_token: 'synthetic-oauth-token', expires_at: Date.now() + 3_600_000 });
  credentials.write(key(providerOAuthStorageKey('oauth-fixture')), token);
  assert.equal(config.oauth.hasGenericOAuthLogin('oauth-fixture'), true);
  release = beginAppSessionBoundary();
  await assert.rejects(config.publicViews(), /PROVIDER_OWNER_CHANGED/);
  await config.close();
  assert.throws(() => config.oauth.hasGenericOAuthLogin('oauth-fixture'), /PROVIDER_OWNER_CHANGED/);
  release(); release = null;
  console.log('PASS provider configuration: missing credentials remain disconnected; legacy headers migrate to encrypted files without public exposure; Pi uses shared model limits; owner boundaries reject stale reads');
} finally {
  await config?.close(); release?.();
  if (database) { clearCurrentDbClient(database); await database.dispose(); }
  configureHostOwner({ userDataDir: profile, ownerId: null });
  await fs.rm(profile, { recursive: true, force: true });
  if (inheritedFormalProfile === undefined) delete process.env.XDT_OFFICIAL_SHARED_PROFILE;
  else process.env.XDT_OFFICIAL_SHARED_PROFILE = inheritedFormalProfile;
}
