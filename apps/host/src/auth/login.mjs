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
import { assertHostSessionRegion, hostPackageRegion } from './region-policy.ts';

const BROWSER_AUTH_TIMEOUT_MS = 5 * 60_000;
const REFUSED_SESSION_LOGOUT_TIMEOUT_MS = 5_000;

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

async function pickMethod(providers, requested, choosePersonalMethod) {
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
  if (choosePersonalMethod) {
    const chosen = await choosePersonalMethod(social);
    const match = supported.find((method) => method.providerOrConnectionId === chosen);
    if (match) return match;
    throw new Error(`unsupported login method "${chosen}"; available: ${social.join(', ')}`);
  }
  throw new Error(`choose a login method with --method=: ${social.join(', ')}`);
}

async function enterpriseLoginMethod(client, organization, requested, discovery) {
  const { connections } = discovery ?? await client.discoverSsoOrg(organization);
  const match = requested
    ? connections.find(({ connectionId }) => connectionId === requested)
    : connections.length === 1 ? connections[0] : undefined;
  if (!match) {
    throw new Error(`Choose an enterprise connection with --method=: ${connections.map(c => c.connectionId).join(', ')}`);
  }
  return { type: 'sso', providerOrConnectionId: match.connectionId };
}

/**
 * The exchange returns a LoginOutcome; only `ok` carries tokens. The other
 * outcomes need an interactive step the CLI does not offer. The message names
 * the step only, never the tickets or masked targets in the outcome.
 */
function unfinishedLoginMessage(outcome) {
  switch (outcome?.status) {
    case 'binding_required':
      return `this account must bind ${outcome.bindType === 'email' ? 'an email address' : 'a phone number'} first; `
        + 'sign in with the Cindy desktop app using the same method, finish binding there, then run cindy-host login again';
    case 'select_account':
      return 'this sign-in matches several Cindy accounts and cindy-host login cannot choose one yet';
    case 'sso_verification_required':
      return 'this sign-in needs an extra verification code, which cindy-host login does not support yet';
    default:
      return `authorization exchange returned an unsupported login outcome (${String(outcome?.status)})`;
  }
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
 *   packageRegion?: 'cn' | 'global',
 *   warn?: (line: string) => void,
 *   admitAccount?: (membership: { id: string }) => void,
 *   persistSession?: (record: string, membership: { id: string }) => Promise<void>,
 *   refusedSessionLogoutTimeoutMs?: number,
 *   hostedCallbackUrl?: string,
 *   openBrowser: (url: string) => Promise<void>,
 *   method?: string,
 *   choosePersonalMethod?: (methods: string[]) => Promise<string>,
 *   organization?: string,
 *   organizationDiscovery?: import('@cindy/auth-client').SsoOrgDiscovery,
 *   onAuthorizeUrl?: (url: string) => void,
 *   onSignedIn?: (accessToken: string) => Promise<void>,
 *   signal?: AbortSignal,
 *   now?: () => number,
 * }} deps
 * `onSignedIn` gets the access token of this explicit sign-in (held in memory only), after the session is saved.
 * @returns {Promise<{authenticated: true, realm: 'cn' | 'global', method: string}>}
 */
export async function runHostLogin(deps) {
  let method, pair;
  if (deps.cloudGuest) {
    const {grant,guest}=deps.cloudGuest;
    method={type:'cloud-guest'};
    pair=await deps.client.exchangeAuthorizationCode(grant.code,grant.verifier);
    if (pair?.status==='ok' && (pair.membership?.kind!=='org' || pair.membership.id!==guest.membershipId || pair.membership.orgId!==guest.organizationId)) {
      await endRefusedSession(deps,pair.accessToken);throw new Error('Cloud guest owner changed');
    }
  } else {
    method = deps.organization
      ? await enterpriseLoginMethod(deps.client, deps.organization, deps.method, deps.organizationDiscovery)
      : await pickMethod(await deps.client.getProviders(), deps.method, deps.choosePersonalMethod);
    const {verifier,challenge}=pkce();
    const authorization=deps.hostedCallbackUrl
      ? await authorizeViaHostedCallback({...deps,method,challenge})
      : await authorizeViaLoopback({...deps,method,challenge});
    if ('error' in authorization) throw new Error(`browser authorization failed: ${authorization.error}`);
    pair=await deps.client.exchangeAuthorizationCode(authorization.code,verifier);
  }
  if (pair?.status !== 'ok') throw new Error(unfinishedLoginMessage(pair));
  if (deps.organization && pair.membership?.kind !== 'org') {
    await endRefusedSession(deps, pair.accessToken);
    throw new Error('Enterprise sign-in requires an organization membership.');
  }
  // H-1, as the Desktop: a personal account of another region is refused before anything is saved.
  try {
    assertHostSessionRegion({ packageRegion: deps.packageRegion ?? hostPackageRegion(), sessionRealm: deps.region,
      membershipKind: pair.membership?.kind });
    // A running serve with another account's runtime: that account must stop first (login-cli.mjs).
    deps.admitAccount?.(pair.membership);
  } catch (error) {
    await endRefusedSession(deps, pair.accessToken);
    throw error;
  }
  const record = deps.deviceId ? serializeHostSession(deps.region, pair.refreshToken, deps.deviceId) : serializeAuthSessionRecord(deps.region, pair.refreshToken);
  // The Skill projection owner commit (login-cli.mjs) saves the session inside its own transaction.
  if (deps.persistSession) {
    // A save or commit that fails leaves an issued session nobody holds: end it, as a refusal does.
    try { await deps.persistSession(record, pair.membership); }
    catch (error) { await endRefusedSession(deps, pair.accessToken); throw error; }
  } else deps.store.write(AUTH_SESSION_KEY, record);
  if (deps.onSignedIn && typeof pair.accessToken === 'string' && pair.accessToken) await deps.onSignedIn(pair.accessToken);
  return { authenticated: true, realm: deps.region, method: method.providerOrConnectionId ?? method.type };
}

/**
 * The exchange above already issued a session that nobody will hold. The Desktop has no such path
 * (its personal code login always uses the build region); the Host ends it so no orphan is left.
 * Only through the client that exchanged the code, i.e. the account's own region's sign-in service,
 * never the package region's. Best effort: a few seconds at most, a failure is logged without the
 * token or the account, and the refusal stands either way.
 */
async function endRefusedSession(deps, accessToken) {
  const warn = deps.warn ?? ((line) => console.warn(line));
  if (!accessToken || typeof deps.client.logout !== 'function') return;
  let timer;
  try {
    await Promise.race([
      deps.client.logout(accessToken),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), deps.refusedSessionLogoutTimeoutMs ?? REFUSED_SESSION_LOGOUT_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } catch {
    warn('The refused sign-in could not be ended on the sign-in service; it will expire on its own.');
  } finally {
    clearTimeout(timer);
  }
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
