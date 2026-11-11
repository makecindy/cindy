/** Host-owned references to the current owner's already connected OAuth accounts.
 * These types contain no token, client secret or authorization response. */
export interface GhostOauthAccountReference {
  instanceKey: string;
  secretKey: string;
  accountId: string;
}

export interface GhostReusableOauthAccount extends GhostOauthAccountReference {
  pluginName: string;
  label: string | null;
  scopes: string[];
}

export interface GhostSavedCredentialReference extends GhostOauthAccountReference {
  kind: 'secret' | 'connection';
}

export interface GhostReusableSavedCredential extends GhostSavedCredentialReference {
  pluginName: string;
  label: string | null;
  scopes: string[];
}

/** A marker alone grants nothing: only the Host can write the companion reference. */
export const GHOST_SAVED_CREDENTIAL_MARKER = 'cindy:host-injected-saved-credential:v1';

export function isReusableSavedSecret(secret: { source?: string }): boolean {
  return secret.source === undefined || secret.source === 'user';
}

export interface GhostAccountReuseGroup {
  key: string;
  label: string;
  options: (GhostReusableOauthAccount | GhostReusableSavedCredential)[];
  accounts: { id: string; label: string | null; status: 'connected' | 'expired' }[];
}

export type GhostAccountReuseAction =
  | { kind: 'connect'; secretKey: string; source: GhostOauthAccountReference | GhostSavedCredentialReference }
  | { kind: 'disconnect'; secretKey: string; accountId: string };

export type GhostAccountReuseResult = { ok: true } | { ok: false; error: string };
