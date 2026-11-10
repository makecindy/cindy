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

export interface GhostAccountReuseGroup {
  key: string;
  label: string;
  options: GhostReusableOauthAccount[];
  accounts: { id: string; label: string | null; status: 'connected' | 'expired' }[];
}

export type GhostAccountReuseAction =
  | { kind: 'connect'; secretKey: string; source: GhostOauthAccountReference }
  | { kind: 'disconnect'; secretKey: string; accountId: string };

export type GhostAccountReuseResult = { ok: true } | { ok: false; error: string };
