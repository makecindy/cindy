import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

import { CindyAuthClient, parseAuthSessionRecord } from '@cindy/auth-client';

import { runHostLogin } from './login.mjs';

/**
 * The real account authorization needs the user; this drives the same code path
 * with a stub identity provider that redirects back to the host's loopback
 * listener, so PKCE, the callback parse, the code exchange and the credential
 * write are all exercised for real.
 */
test('completes the loopback login against a stub provider and stores the session', async () => {
  /** Redirects to the host callback exactly like the authorize endpoint would. */
  const provider = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const redirect = url.searchParams.get('redirect_uri') ?? '';
    const state = url.searchParams.get('state') ?? '';
    const target = new URL(redirect);
    target.searchParams.set('code', 'stub-authorization-code');
    target.searchParams.set('state', state);
    response.writeHead(302, { location: target.toString() }).end();
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const providerPort = provider.address().port;

  let openedUrl = '';
  const written = new Map();
  const exchanged = [];
  const signedIn = [];
  try {
    const result = await runHostLogin({
      client: {
        getProviders: async () => ({ social: ['google'] }),
        buildAuthorizeUrl: ({ redirectUri, codeChallenge, state }) => {
          const url = new URL(`http://127.0.0.1:${providerPort}/authorize`);
          url.searchParams.set('redirect_uri', redirectUri);
          url.searchParams.set('code_challenge', codeChallenge);
          url.searchParams.set('state', state);
          return url.toString();
        },
        exchangeAuthorizationCode: async (code, verifier) => {
          exchanged.push({ code, verifier });
          return { status: 'ok', refreshToken: 'fixture-refresh-value', accessToken: 'fixture-fresh-access' };
        },
      },
      store: { write: (key, value) => written.set(key, value) },
      region: 'global',
      openBrowser: async (url) => {
        openedUrl = url;
        // Follow the provider redirect into the host's own callback listener.
        await fetch(url, { redirect: 'follow' });
      },
      // A removed Host registers again only with this sign-in's own token (auth/device-link-registration.mjs).
      onSignedIn: async (token) => { signedIn.push({ token, saved: written.size }); },
    });

    assert.deepEqual(result, { authenticated: true, realm: 'global', method: 'google' });
    assert.deepEqual(signedIn, [{ token: 'fixture-fresh-access', saved: 1 }]);
    assert.equal(exchanged.length, 1);
    assert.equal(exchanged[0].code, 'stub-authorization-code');
    assert.ok(exchanged[0].verifier.length >= 43, 'PKCE verifier is sent with the exchange');
    // The challenge the provider received is S256 of the verifier used later.
    const challenge = new URL(openedUrl).searchParams.get('code_challenge');
    assert.equal(
      challenge,
      createHash('sha256').update(exchanged[0].verifier).digest('base64url'),
    );
    const stored = [...written.values()][0];
    assert.match(stored, /fixture-refresh-value/);
    assert.match(stored, /"global"/);
  } finally {
    await new Promise((resolve) => provider.close(() => resolve()));
  }
});

test('completes the hosted-callback login once polling returns a code', async () => {
  const written = new Map();
  let polls = 0;
  const result = await runHostLogin({
    client: {
      getProviders: async () => ({ social: ['apple'] }),
      buildAuthorizeUrl: () => 'https://auth.example.invalid/authorize',
      pollDesktopAuthorization: async () => {
        polls += 1;
        return polls < 2
          ? { status: 'pending' }
          : { status: 'ok', code: 'hosted-code' };
      },
      exchangeAuthorizationCode: async (code) => {
        assert.equal(code, 'hosted-code');
        return { status: 'ok', refreshToken: 'fixture-refresh-value' };
      },
    },
    store: { write: (key, value) => written.set(key, value) },
    region: 'cn',
    packageRegion: 'cn',
    hostedCallbackUrl: 'https://auth.example.invalid/desktop/callback',
    method: 'apple',
    openBrowser: async () => {},
  });

  assert.deepEqual(result, { authenticated: true, realm: 'cn', method: 'apple' });
  assert.ok(polls >= 2, 'keeps polling while the browser flow is pending');
  assert.match([...written.values()][0], /fixture-refresh-value/);
});

test('refuses a callback whose state does not match the request', async () => {
  const provider = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const target = new URL(url.searchParams.get('redirect_uri') ?? '');
    target.searchParams.set('code', 'stub-code');
    target.searchParams.set('state', 'forged-state');
    response.writeHead(302, { location: target.toString() }).end();
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const port = provider.address().port;
  try {
    await assert.rejects(
      runHostLogin({
        client: {
          getProviders: async () => ({ social: ['google'] }),
          buildAuthorizeUrl: ({ redirectUri, state }) => {
            const url = new URL(`http://127.0.0.1:${port}/authorize`);
            url.searchParams.set('redirect_uri', redirectUri);
            url.searchParams.set('state', state);
            return url.toString();
          },
          exchangeAuthorizationCode: async () => ({ refreshToken: 'fixture-unused-value' }),
        },
        store: { write: () => assert.fail('nothing may be stored') },
        region: 'global',
        openBrowser: async (url) => {
          await fetch(url, { redirect: 'follow' });
        },
      }),
      /authorization failed/,
    );
  } finally {
    await new Promise((resolve) => provider.close(() => resolve()));
  }
});

/*
 * H-1 (release table; user decision 2026-11-17 “和桌面版一致”): `cindy-host login` applies the
 * Desktop's cross-region rule (`canRestoreAuthSessionForMembership`) to the package region, the
 * `--region` realm and the account kind returned by the exchange.
 * Production entry: runHostLogin with the real CindyAuthClient against two fake auth servers on
 * loopback (one per region, each reporting its own region), as the region inventory did.
 * Gap: the tests above use client stubs without a membership and never cross regions.
 * Minimal failure: package global, --region=cn, personal account → must not be stored.
 * Tier: unit (loopback HTTP only).
 */
async function fakeAuthServers(kind, logout = 'ok') {
  const hits = [];
  const servers = {};
  for (const region of ['cn', 'global']) {
    const server = createServer((request, response) => {
      hits.push(`${region} ${request.url}`);
      const json = (value) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      const membership = { id: `fixture-${region}-member`, kind, role: 'owner', displayName: 'Fixture', email: null,
        orgId: kind === 'org' ? 'fixture-org' : null, orgName: kind === 'org' ? 'Fixture Org' : null };
      if (request.url === '/api/auth/providers') return json({ region, attribution: 'email', email: true, phone: false, social: ['google'] });
      if (request.url === '/api/auth/desktop/callback/poll') return json({ status: 'ok', code: 'fixture-code' });
      if (request.url === '/api/auth/token') return json({ status: 'ok', accessToken: 'fixture-access-value', refreshToken: `fixture-refresh-${region}`, membership });
      if (request.url === '/api/auth/logout') {
        if (logout === 'hang') return undefined;
        if (logout === 'fail') return response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'INTERNAL' } }));
        return json({ status: 'ok' });
      }
      return response.writeHead(404).end('{}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers[region] = { server, url: `http://127.0.0.1:${server.address().port}` };
  }
  const close = () => Promise.all(Object.values(servers).map(({ server }) => {
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(resolve));
  }));
  return { hits, servers, close };
}

test('login follows the Desktop rule: personal accounts stay in the package region, organizations may cross', async () => {
  for (const [packageRegion, region, kind, admitted] of [
    ['global', 'cn', 'personal', false],
    ['cn', 'global', 'personal', false],
    ['global', 'cn', 'org', true],
    ['cn', 'global', 'org', true],
    ['global', 'global', 'personal', true],
    ['cn', 'cn', 'personal', true],
  ]) {
    const label = `package ${packageRegion}, --region=${region}, ${kind}`;
    const fake = await fakeAuthServers(kind);
    const written = new Map();
    try {
      const login = runHostLogin({
        client: new CindyAuthClient({ baseUrl: fake.servers[region].url, region, deviceId: 'fixture-device', clientType: 'desktop', fetch }),
        store: { write: (key, value) => written.set(key, value) },
        deviceId: 'fixture-device',
        region,
        packageRegion,
        hostedCallbackUrl: `${fake.servers[region].url}/desktop/callback`,
        openBrowser: async () => {},
      });
      if (admitted) {
        assert.deepEqual(await login, { authenticated: true, realm: region, method: 'google' }, label);
        assert.equal(parseAuthSessionRecord([...written.values()][0])?.realm, region, label);
      } else {
        await assert.rejects(login, (error) => error.code === 'HOST_CROSS_REGION_PERSONAL_ACCOUNT'
          && error.message.includes(`"${region}" region`) && error.message.includes(`"${packageRegion}" region`), label);
        assert.equal(written.size, 0, `${label}: no session is saved`);
        // The issued session is ended once, at the account's own region only (the Host addition).
        assert.deepEqual(fake.hits.filter((hit) => hit.endsWith('/api/auth/logout')), [`${region} /api/auth/logout`], label);
      }
      if (admitted) assert.equal(fake.hits.some((hit) => hit.endsWith('/api/auth/logout')), false, label);
      // Every request went to the account's own region, admitted or not.
      assert.ok(fake.hits.length > 0 && fake.hits.every((hit) => hit.startsWith(`${region} `)), label);
    } finally {
      await fake.close();
    }
  }
});

// The Host addition after a refusal: ending the issued session is best effort. A failing or hanging
// sign-in service must not change the refusal or keep the command waiting, and the warning carries
// neither the token nor the account. Minimal failure: logout answers 500, or never answers.
test('a refused login ends its session at most best effort and stays refused', async () => {
  for (const logout of ['fail', 'hang']) {
    const fake = await fakeAuthServers('personal', logout);
    const warnings = [];
    const written = new Map();
    try {
      await assert.rejects(runHostLogin({
        client: new CindyAuthClient({ baseUrl: fake.servers.cn.url, region: 'cn', deviceId: 'fixture-device', clientType: 'desktop', fetch }),
        store: { write: (key, value) => written.set(key, value) }, deviceId: 'fixture-device',
        region: 'cn', packageRegion: 'global', hostedCallbackUrl: `${fake.servers.cn.url}/desktop/callback`,
        openBrowser: async () => {}, warn: (line) => warnings.push(line), refusedSessionLogoutTimeoutMs: 50,
      }), (error) => error.code === 'HOST_CROSS_REGION_PERSONAL_ACCOUNT', logout);
      assert.equal(written.size, 0, logout);
      assert.equal(warnings.length, 1, logout);
      assert.doesNotMatch(warnings[0], /fixture-access-value|fixture-cn-member|fixture-device/, logout);
      assert.ok(fake.hits.every((hit) => hit.startsWith('cn ')), logout);
    } finally {
      await fake.close();
    }
  }
});

// The package region of a release (区域单元, 甲 20): built for cn, run with CINDY_HOST_REGION unset,
// the rule must judge against cn, not the source default global. Only a release has a build region,
// so this runs one child process with the release constant the builder bakes in
// (__CINDY_HOST_RELEASE__, runtime-layout.mjs). Minimal failure: hostPackageRegion() ignoring the
// release and answering global.
test('a cn release judges sign-in against cn with CINDY_HOST_REGION unset', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const hostDir = fileURLToPath(new URL('../..', import.meta.url));
  const script = `
    globalThis.__CINDY_HOST_RELEASE__ = { region: 'cn' };
    const { hostPackageRegion, assertHostSessionRegion } = await import(${JSON.stringify(new URL('./region-policy.ts', import.meta.url).href)});
    const verdict = (sessionRealm) => { try { assertHostSessionRegion({ packageRegion: hostPackageRegion(), sessionRealm, membershipKind: 'personal' }); return 'admitted'; } catch (error) { return error.code; } };
    process.stdout.write(JSON.stringify({ region: hostPackageRegion(), cn: verdict('cn'), global: verdict('global') }));`;
  const env = { ...process.env };
  delete env.CINDY_HOST_REGION;
  const { stdout } = await promisify(execFile)(process.execPath,
    ['--import', 'tsx', '--import', './src/loaders/register-raw.mjs', '--input-type=module', '-e', script], { cwd: hostDir, env });
  assert.deepEqual(JSON.parse(stdout), { region: 'cn', cn: 'admitted', global: 'HOST_CROSS_REGION_PERSONAL_ACCOUNT' });
});
