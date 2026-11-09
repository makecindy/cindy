/** Desktop endpoint adapter; provider overrides are shared with Node Host. */
import { claudeUpstreamEndpoint } from './runtime-configs.js';
import { buildCodexGatewayBaseUrl as buildBaseUrl } from './codexGatewayConfigCore.js';
export * from './codexGatewayConfigCore.js';
export function buildCodexGatewayBaseUrl(upstream = claudeUpstreamEndpoint()): string {
  return buildBaseUrl(upstream);
}
