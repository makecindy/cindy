import { OauthIdentityStore, oauthIdentityScopeKey, type OauthIdentityScope } from '../../../desktop/src/main/plugin-oauth/identityStore.js';
import { initializePluginOauthCards } from '../../../desktop/src/main/plugin-oauth/cards.js';
import { invalidatePluginOauth } from '../../../desktop/src/main/plugin-oauth/runtime.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../../desktop/src/main/appSessionState.js';
import type { createHostPluginAuthorization } from './authorization.js';

/** Same signed, encrypted exchange as a controlled Desktop. A connected phone
 * proves its account/device identity before secret input or browser callbacks. */
export function initializeHostPluginRemoteAuthorization(options: {
  authorization: ReturnType<typeof createHostPluginAuthorization>;
  root(...parts: string[]): string;
  identity(): OauthIdentityScope | null;
  available(peer: string): boolean;
  credentials: { encrypt(value: string): string; decrypt(value: string): string };
}) {
  const owner = activeOwnerScopeKey();
  const current = () => activeOwnerScopeKey() === owner && !isAppSessionBoundaryPending();
  const identity = () => current() ? options.identity() : null;
  const store = new OauthIdentityStore({
    filePath: scope => options.root('plugin-oauth', `${oauthIdentityScopeKey(scope)}.v1.enc`),
    // The codec has already been prepared against the actual OS vault. There is
    // no plaintext fallback; an unavailable vault rejects load() before exchange.
    available: () => current() && identity() !== null,
    encrypt: value => Buffer.from(options.credentials.encrypt(value), 'base64'),
    decrypt: value => options.credentials.decrypt(value.toString('base64')),
  });
  initializePluginOauthCards({
    bridge: options.authorization.bridge, bots: () => null,
    bindConnection: options.authorization.bindConnection,
    owner: () => identity() ? owner : null,
    available: peer => current() && options.available(peer), identity,
    loadKey: (scope, check) => store.load(scope, () => {
      check();
      const active = identity();
      if (!active || oauthIdentityScopeKey(active) !== oauthIdentityScopeKey(scope))
        throw new Error('OAUTH_IDENTITY_UNAVAILABLE');
    }),
  });
  return () => invalidatePluginOauth();
}
