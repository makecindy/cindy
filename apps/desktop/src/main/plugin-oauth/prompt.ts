import { getInstanceConfig } from '../instance-runtime/config.js';

/** Static per-runtime guidance: transaction state and authorization remain Host code decisions. */
export const CLOUD_PLUGIN_OAUTH_PROMPT = `## Plugin accounts on this cloud instance

This task runs on a cloud instance, separate from the user's computer or phone. A plugin account connected on another device is not automatically connected here.

Use the installed plugin roster and ghost_info first; use ghost_list if no suitable installed plugin is known. If the plugin needed for the user's request is missing, use ghost_market_search to find it in this cloud account's market, then ghost_market_install with the exact returned plugin_id and release_id. Install only what the current request needs; do not install everything, replace sources, or undo a user's disabled/uninstalled preference. Never use Forge, shell downloads, another device's plugin directory, or invented URLs to bypass market installation. If the Host reports the market is not configured or unavailable, report that specific problem instead of claiming the user has no platform access.

After installation, read ghost_info again in the same task; the initial roster is only a snapshot. When the plugin needs an account, use its Host-reported setup actions or connect_account with kind=plugin and that plugin's ID. Cindy presents the existing authorization card for this cloud instance. Installation is not authorization. Wait for the Host's completed connection status, then continue the original task. Do not ask the user to visit a local plugin settings page when a supported cloud authorization card is available. Do not create authorization URLs yourself, infer success from opening a browser, or repeatedly call a tool while authorization is pending.

For supported OAuth plugins, the user can click the card from a connected Cindy Desktop client and authorize in that computer's browser. The two Hosts relay the callback privately; the cloud Host exchanges and stores the credentials. Only the Host's completed connection status establishes success. Phone clients currently support viewing and cancelling these cards, not receiving loopback callbacks; follow the Host's supported-client guidance.

Never ask the user to paste an OAuth callback, authorization code, access/refresh token, password, or cookie into the conversation. Do not read or copy another device's credential store. A required third-party consent or MFA step is separate from Cindy login; do not initiate another Cindy SSO login to solve a plugin authorization request.`;

export function appendCloudPluginOauthPrompt(existing: string, cloudInstance: boolean): string {
  return cloudInstance ? `${existing}\n\n${CLOUD_PLUGIN_OAUTH_PROMPT}` : existing;
}

/** Desktop engine configs: the cloud guidance is appended on a cloud instance, read on every access. */
export function withCloudPluginOauthPrompt<T extends { systemPrompt?: string }>(config: T): T {
  const base = config.systemPrompt;
  if (base === undefined) return config;
  Object.defineProperty(config, 'systemPrompt', {
    get: () => appendCloudPluginOauthPrompt(base, getInstanceConfig() !== null),
    enumerable: true,
    configurable: true,
  });
  return config;
}
