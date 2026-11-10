/**
 * Browser login for `cindy-host`, reusing the Desktop flow.
 *
 * Same authorize URL builder, same PKCE, same hosted-callback polling helper and
 * the same stored session record as the Electron main process. The only
 * substitutions are platform facts: global fetch instead of Electron net, a
 * system browser launcher, and this process's own loopback server.
 */

import crypto from 'node:crypto';
import { createServer } from 'node:http';

import { serializeAuthSessionRecord } from '@cindy/auth-client';
import { serializeHostSession } from './device-identity.mjs';

import { AUTH_SESSION_KEY } from '../../../desktop/src/main/authCredentialKeys.ts';
import {
  createDesktopPollCredentials,
  runHostedCallbackPolling,
} from '../../../desktop/src/main/authHostedCallback.ts';
import { parseAuthLoopbackCallback } from '../../../desktop/src/main/authLoopbackCallback.ts';

const BROWSER_AUTH_TIMEOUT_MS = 5 * 60_000;

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

function pickMethod(providers, requested) {
  const social = providers.social ?? [];
  const supported = social.map((provider) => ({ type: 'social', providerOrConnectionId: provider }));
  if (requested) {
    const match = supported.find((method) => method.providerOrConnectionId === requested);
    if (!match) {
      throw new Error(
        `unsupported login method "${requested}"; available: ${social.join(', ') || 'none'}`,
      );
    }
    return match;
  }
  if (supported.length === 1) return supported[0];
  if (supported.length === 0) {
    throw new Error(
      'no browser login is available for this account; email/phone sign-in is not implemented for cindy-host yet',
    );
  }
  throw new Error(`choose a login method with --method=: ${social.join(', ')}`);
}

/** Bind the loopback listener and resolve once it owns a real port. */
function listenOnLoopback(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : null);
    });
  });
}

/**
 * @param {{
 *   client: any,
 *   store: {write(key: string, value: string): void},
 *   region: 'cn' | 'global',
 *   hostedCallbackUrl?: string,
 *   openBrowser: (url: string) => Promise<void>,
 *   method?: string,
 *   onAuthorizeUrl?: (url: string) => void,
 *   signal?: AbortSignal,
 *   now?: () => number,
 * }} deps
 * @returns {Promise<{authenticated: true, realm: 'cn' | 'global', method: string}>}
 */
export async function runHostLogin(deps) {
  const providers = await deps.client.getProviders();
  const method = pickMethod(providers, deps.method);
  const { verifier, challenge } = pkce();

  const authorization = deps.hostedCallbackUrl
    ? await authorizeViaHostedCallback({ ...deps, method, challenge })
    : await authorizeViaLoopback({ ...deps, method, challenge });
  if ('error' in authorization) throw new Error(`browser authorization failed: ${authorization.error}`);

  const pair = await deps.client.exchangeAuthorizationCode(authorization.code, verifier);
  if (!pair?.refreshToken) throw new Error('authorization exchange returned no refresh token');
  deps.store.write(AUTH_SESSION_KEY, deps.deviceId ? serializeHostSession(deps.region, pair.refreshToken, deps.deviceId) : serializeAuthSessionRecord(deps.region, pair.refreshToken));
  return { authenticated: true, realm: deps.region, method: method.providerOrConnectionId ?? method.type };
}

async function authorizeViaHostedCallback({ client, method, challenge, hostedCallbackUrl, openBrowser, onAuthorizeUrl, signal, now }) {
  const { clientState, pollSecret } = createDesktopPollCredentials();
  const url = client.buildAuthorizeUrl({
    kind: method.type,
    providerOrConnectionId: method.providerOrConnectionId,
    redirectUri: hostedCallbackUrl,
    codeChallenge: challenge,
    state: clientState,
  });
  onAuthorizeUrl?.(url);
  await openBrowser(url);
  return runHostedCallbackPolling({
    poll: () => client.pollDesktopAuthorization(pollSecret, { signal }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: now ?? Date.now,
    signal: signal ?? new AbortController().signal,
    timeoutMs: BROWSER_AUTH_TIMEOUT_MS,
  });
}

async function authorizeViaLoopback({ client, method, challenge, openBrowser, onAuthorizeUrl, signal }) {
  const state = crypto.randomUUID();
  let settle;
  const outcome = new Promise((resolve) => {
    settle = resolve;
  });
  const server = createServer((request, response) => {
    const result = parseAuthLoopbackCallback(request.url, state);
    if (!result) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><title>Cindy</title>'
      + '<p>Login received. You can close this window and return to the terminal.</p>');
    finish(result);
  });
  const timer = setTimeout(() => finish({ error: 'REQUEST_TIMEOUT' }), BROWSER_AUTH_TIMEOUT_MS);
  const onAbort = () => finish({ error: 'USER_CANCELLED' });
  signal?.addEventListener('abort', onAbort, { once: true });

  function finish(result) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (server.listening) server.close();
    settle(result);
  }

  const port = await listenOnLoopback(server);
  if (!port) throw new Error('loopback listener failed to bind');
  const url = client.buildAuthorizeUrl({
    kind: method.type,
    providerOrConnectionId: method.providerOrConnectionId,
    redirectUri: `http://127.0.0.1:${port}/auth/callback`,
    codeChallenge: challenge,
    state,
  });
  onAuthorizeUrl?.(url);
  await openBrowser(url);
  return outcome;
}
