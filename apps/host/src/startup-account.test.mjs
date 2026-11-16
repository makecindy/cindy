import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { mapMembershipToAuthUser } from '../../desktop/src/shared/authUser.ts';
import { resolveSessionDevice, canRegisterHostDevice } from './auth/device-identity.mjs';
import { AUTH_SESSION_KEY } from '../../desktop/src/main/authCredentialKeys.ts';
import { resolveRuntimeDeviceId } from '../../desktop/src/main/deviceId.ts';
import { decodeAccessTokenOrgSlug } from '../../desktop/src/main/authTokenClaims.ts';
import { createServer } from 'node:http';
import { CindyAuthClient as RealAuthClient, parseAuthSessionRecord, serializeAuthSessionRecord } from '@cindy/auth-client';
import { assertHostSessionRegion } from './auth/region-policy.ts';
import { refreshHostSession as realRefreshHostSession } from './auth/refresh.mjs';
import { projectAdoptedSession } from './credentials/session.mjs';

// Unit regression: run the real startup/auth functions with in-memory network,
// credentials and storage. A valid login for B must never open A's database.
const source = ts.createSourceFile('main.ts', readFileSync(new URL('./main.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const functions = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && ['ensureRuntime', 'resolveAccountUser'].includes(node.name?.text)) {
    functions.push(node.getText(source).replaceAll('import.meta.url', "'file:///test/main.ts'"));
  } else ts.forEachChild(node, visit);
}
visit(source);
const compiled = ts.transpileModule(`
let activeOwner = null, runtimeLease = null, currentSessionToken = null, accountUser = null, currentDeviceId = null, remoteIdentityReady = false;
let account = { authenticated: false, realm: 'global' };
const runtime = { owner: null };
${functions.join('\n')}
return { start: ensureRuntime, resolve: resolveAccountUser, token: () => currentSessionToken, account: () => account };
`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function setup(overrides = {}) {
  const opens = [];
  const steps = [];
  const deps = {
    mapMembershipToAuthUser, decodeAccessTokenOrgSlug, resolveRuntimeDeviceId, resolveSessionDevice, canRegisterHostDevice, AUTH_SESSION_KEY,
    resolveHostDataDir: () => 'isolated-test-profile',
    configureHostOwner: ({ ownerId }) => { steps.push(`owner:${ownerId}`); },
    // Row 25 (25a): the Host reads the Skill projection boundary for the owner it just configured.
    observeSkillProjectionBoundary: (ownerId) => { steps.push(`boundary:${ownerId}`); return 'stable'; },
    acquireHostRuntimeLease: () => ({ held: true, release() {} }),
    readAdoptedSessionState: async () => ({ authenticated: true, realm: 'global' }),
    openOwnerDatabase: async (args) => { opens.push(args); steps.push('open'); throw new Error('database opened'); },
    path: { join: (...parts) => parts.join('/') }, layout: { packaged: false, drizzleDir: 'desktop/drizzle', sqliteVecPath: 'desktop/vec0' }, process,
    resolveHostRegion: () => 'global', readAuthEndpoints: () => ({ authApiBaseUrl: 'https://example.invalid' }),
    createCredentialStore: async () => ({ read: () => null }), createRequire: () => () => ({ machineIdSync: () => 'test-device' }),
    CindyAuthClient: class { async getMe() { return { membership: { id: 'account-b' } }; } },
    refreshHostSession: async () => ({ sessionToken: 'synthetic-test-value' }),
    ACCOUNT_DEFAULT_MODEL: 'test-model', ACCOUNT_DEFAULT_EFFORT: 'medium',
    // The former startup refresh swallowed mismatch errors and still opened storage.
    refreshAuthSession: async () => false,
    assertHostSessionRegion, hostPackageRegion: () => 'global', hostAuthFetch: () => { throw new Error('no network in this harness'); },
    ...overrides,
  };
  // import.meta.url is only passed to the injected createRequire stub.
  const code = compiled.replaceAll('import.meta.url', "'file:///test/main.ts'");
  return { ...new Function(...Object.keys(deps), code)(...Object.values(deps)), opens, steps };
}

test('startup rejects a different signed-in owner before opening storage', async () => {
  const h = setup();
  await assert.rejects(h.start('account-a'), /does not match/);
  assert.deepEqual(h.opens, []);
  assert.equal(h.token(), null);
});

test('matching owner authentication proceeds to its own database', async () => {
  const h = setup();
  await assert.rejects(h.start('account-b'), /database opened/);
  assert.equal(h.opens.length, 1);
  assert.equal(h.opens[0].ownerId, 'account-b');
  // Read after the owner is configured (the boundary path follows that profile), before storage.
  assert.deepEqual(h.steps, ['owner:account-b', 'boundary:account-b', 'open']);
});

test('an explicit owner cannot open private data without a verified login', async () => {
  const h = setup({ readAdoptedSessionState: async () => ({ authenticated: false, realm: 'global' }) });
  await assert.rejects(h.start('account-b'), /Sign in/);
  assert.deepEqual(h.opens, []);
  assert.equal(h.token(), null);
});

/*
 * H-2 (release table; user decision 2026-11-17 “和桌面版一致”): adopting a stored session (a
 * Desktop profile's `AUTH_SESSION_KEY` record) applies the Desktop's cold-start and runtime-refresh
 * rule. Production entry: main.ts's ensureRuntime and resolveAccountUser, with the real
 * CindyAuthClient, refreshHostSession and session projection against two fake auth servers.
 * Gap: the cases above stub the auth client and never carry an account kind or a realm.
 * Minimal failure: global package, stored cn personal session → must stay signed out, no database.
 * Tier: unit (loopback HTTP only).
 */
async function adoptStoredSession(packageRegion, sessionRealm, kind) {
  const hits = [];
  const servers = {};
  const memberId = `fixture-${sessionRealm}-member`;
  for (const region of ['cn', 'global']) {
    const server = createServer((request, response) => {
      hits.push(`${region} ${request.url}`);
      const membership = { id: memberId, kind, role: 'owner', displayName: 'Fixture', email: null,
        orgId: kind === 'org' ? 'fixture-org' : null, orgName: kind === 'org' ? 'Fixture Org' : null };
      const json = (value) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      if (request.url === '/api/auth/refresh') return json({ accessToken: 'fixture-access-value', refreshToken: `fixture-rotated-${region}`, membership });
      if (request.url === '/api/me') return json({ membership, passportId: 'fixture-passport', identities: [membership] });
      return response.writeHead(404).end('{}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers[region] = { server, url: `http://127.0.0.1:${server.address().port}` };
  }
  // The record exactly as the Desktop writes it (no Host device binding).
  const records = new Map([[AUTH_SESSION_KEY, serializeAuthSessionRecord(sessionRealm, 'fixture-desktop-refresh')]]);
  const store = { read: (key) => records.get(key) ?? null, write: (key, value) => records.set(key, value) };
  const h = setup({
    createCredentialStore: async () => store,
    readAdoptedSessionState: async () => projectAdoptedSession(store),
    readAuthEndpoints: (realm) => ({ authApiBaseUrl: servers[realm].url }),
    CindyAuthClient: RealAuthClient, refreshHostSession: realRefreshHostSession, hostAuthFetch: (input, init) => fetch(input, init),
    hostPackageRegion: () => packageRegion,
  });
  const close = () => Promise.all(Object.values(servers).map(({ server }) => new Promise((resolve) => server.close(resolve))));
  return { h, hits, memberId, stored: () => parseAuthSessionRecord(records.get(AUTH_SESSION_KEY)), close };
}

test('an adopted cross-region personal session stays signed out; an organization session is used', async () => {
  for (const [packageRegion, sessionRealm, kind, adopted] of [
    ['global', 'cn', 'personal', false],
    ['cn', 'global', 'personal', false],
    ['global', 'cn', 'org', true],
    ['cn', 'global', 'org', true],
    ['global', 'global', 'personal', true],
  ]) {
    const label = `package ${packageRegion}, stored ${sessionRealm} ${kind}`;
    const run = await adoptStoredSession(packageRegion, sessionRealm, kind);
    try {
      if (adopted) {
        await assert.rejects(run.h.start(run.memberId), /database opened/, label);
        assert.equal(run.h.opens[0]?.ownerId, run.memberId, label);
        assert.equal(run.h.token(), 'fixture-access-value', label);
        assert.equal(run.h.account().realm, sessionRealm, label);
      } else {
        await assert.rejects(run.h.start(run.memberId), (error) => error.code === 'HOST_CROSS_REGION_PERSONAL_ACCOUNT', label);
        assert.deepEqual(run.h.opens, [], `${label}: no account database is opened`);
        assert.equal(run.h.token(), null, `${label}: the session is not adopted`);
        // Cleared, as the Desktop resets to its build realm; an empty realm is what makes the web
        // shim block every statistics collector (甲 21).
        assert.deepEqual(run.h.account(), { authenticated: false, realm: null }, label);
      }
      // As the Desktop: the rotated token stays in the record of its own region either way.
      assert.deepEqual([run.stored()?.realm, run.stored()?.refreshToken], [sessionRealm, `fixture-rotated-${sessionRealm}`], label);
      assert.ok(run.hits.length > 0 && run.hits.every((hit) => hit.startsWith(`${sessionRealm} `)), label);
    } finally {
      await run.close();
    }
  }
});
