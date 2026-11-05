import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

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
          return { refreshToken: 'fixture-refresh-value' };
        },
      },
      store: { write: (key, value) => written.set(key, value) },
      region: 'global',
      openBrowser: async (url) => {
        openedUrl = url;
        // Follow the provider redirect into the host's own callback listener.
        await fetch(url, { redirect: 'follow' });
      },
    });

    assert.deepEqual(result, { authenticated: true, realm: 'global', method: 'google' });
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
        return { refreshToken: 'fixture-refresh-value' };
      },
    },
    store: { write: (key, value) => written.set(key, value) },
    region: 'cn',
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
