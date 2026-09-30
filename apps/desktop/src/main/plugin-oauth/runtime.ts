import { OauthTransactions, type OauthTransactionDeps } from './transactions.js';
import { onOauthCardClosed } from './context.js';
import { AuthenticatedOauthHost, OauthHostIdentity } from './authentication.js';
import {
  oauthIdentityScopeKey,
  type OauthIdentityScope,
  type OauthSigningKey,
} from './identityStore.js';

export type OauthKeyLoader = (
  scope: OauthIdentityScope,
  assertCurrent: () => void,
) => Promise<OauthSigningKey>;
let host: OauthTransactions | undefined;
let authenticated: AuthenticatedOauthHost | undefined;
let identity: (OauthIdentityScope & { key: OauthHostIdentity; owner: string }) | null = null;
let identityFlight: { scope: string; promise: ReturnType<typeof currentIdentity> } | null = null;
let identityTarget: () => OauthIdentityScope | null = () => null;
let loadKey: OauthKeyLoader | undefined;
let currentOwner: (() => string | null) | undefined;
let unsubscribe: (() => void) | undefined;
let epoch = 0;
const peers = new Map<string, number>();

async function currentIdentity(): Promise<
  (OauthIdentityScope & { key: OauthHostIdentity }) | null
> {
  const owner = currentOwner?.();
  const target = owner ? identityTarget() : null;
  const loader = loadKey;
  if (!owner || !target || !loader) return null;
  const scope = JSON.stringify([owner, oauthIdentityScopeKey(target)]);
  if (
    identity &&
    identity.owner === owner &&
    oauthIdentityScopeKey(identity) === oauthIdentityScopeKey(target)
  )
    return identity;
  if (identityFlight?.scope === scope) return identityFlight.promise;
  const startEpoch = epoch;
  const assertCurrent = () => {
    const now = identityTarget();
    if (
      epoch !== startEpoch ||
      loader !== loadKey ||
      owner !== currentOwner?.() ||
      !now ||
      oauthIdentityScopeKey(now) !== oauthIdentityScopeKey(target)
    )
      throw new Error('OAUTH_IDENTITY_UNAVAILABLE');
  };
  const promise = (async () => {
    const stored = await loader(target, assertCurrent);
    assertCurrent();
    identity = { ...target, key: new OauthHostIdentity(stored), owner };
    return identity;
  })();
  identityFlight = { scope, promise };
  try {
    return await promise;
  } finally {
    if (identityFlight?.promise === promise) identityFlight = null;
  }
}

export function initializePluginOauthHost(
  deps: OauthTransactionDeps,
  target: () => OauthIdentityScope | null,
  keyLoader: OauthKeyLoader,
): void {
  invalidatePluginOauth();
  unsubscribe?.();
  host = new OauthTransactions(deps);
  identity = null;
  identityFlight = null;
  identityTarget = target;
  loadKey = keyLoader;
  currentOwner = deps.owner;
  const transactions = host;
  authenticated = new AuthenticatedOauthHost({
    ...deps,
    identity: currentIdentity,
    request: (peer, raw) => transactions.request(peer, raw),
  });
  unsubscribe = onOauthCardClosed((id) => host?.cancelRequest(id));
}

/** Capability projection must not access the keychain or generate a key at startup. */
export function supportsRemotePluginOauth(): boolean {
  return !!loadKey && !!currentOwner?.() && !!identityTarget();
}
export async function publishedPluginOauthIdentity() {
  return (await currentIdentity())?.key.descriptor;
}
export function requestPluginOauth(peer: string, raw: unknown): Promise<unknown> {
  if (!authenticated) return Promise.reject(new Error('OAUTH_BRIDGE_UNAVAILABLE'));
  return authenticated.request(peer, raw);
}
/** A peer failure cancels only that peer. Shared relay/account teardown cancels all transactions. */
export function invalidatePluginOauth(peer?: string): void {
  host?.cancelPeer(peer);
  authenticated?.invalidate(peer);
  if (peer) peers.set(peer, (peers.get(peer) ?? 0) + 1);
  else {
    epoch++;
    peers.clear();
    identity = null;
    identityFlight = null;
  }
}
export function capturePluginOauthPeer(peer: string): () => void {
  const startEpoch = epoch;
  const peerEpoch = peers.get(peer) ?? 0;
  return () => {
    if (startEpoch !== epoch || peerEpoch !== (peers.get(peer) ?? 0))
      throw new Error('OAUTH_BRIDGE_UNAVAILABLE');
  };
}
