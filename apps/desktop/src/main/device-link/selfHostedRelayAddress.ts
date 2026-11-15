import os from 'node:os';
import type { RelayConfig } from './selfHostedRelayConfig.js';
export function suggestedRelayUrls(config: RelayConfig): string[] {
  if (!config.host.listenAll) return [];
  return Object.values(os.networkInterfaces()).flatMap(entries => (entries ?? [])
    .filter(entry => entry.family === 'IPv4' && !entry.internal).map(entry => `http://${entry.address}:${config.host.port}`));
}
/** External recipients cannot use the host's loopback transport address. */
export function hostJoinBaseUrl(config: RelayConfig): string | null {
  return config.host.externalUrl ?? suggestedRelayUrls(config)[0] ?? null;
}
