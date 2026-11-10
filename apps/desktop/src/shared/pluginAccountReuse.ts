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
