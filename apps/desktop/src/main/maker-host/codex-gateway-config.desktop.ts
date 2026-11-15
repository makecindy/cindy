/** Desktop endpoint adapter; provider overrides are shared with Node Host. */
import { claudeUpstreamEndpoint } from './runtime-configs.js';
import { buildCodexGatewayBaseUrl as buildBaseUrl } from './codex-gateway-config.js';
export * from './codex-gateway-config.js';
export function buildCodexGatewayBaseUrl(upstream = claudeUpstreamEndpoint()): string {
  return buildBaseUrl(upstream);
}
