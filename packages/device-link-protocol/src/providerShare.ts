/**
 * Provider-share scope: another account's device uses this device's remote-agent
 * capability for one shared provider. src/dst always remain physical device identifiers.
 */
export const PROVIDER_SHARE_RELAY_CAPABILITY = 'provider-share-v1';
export type ProviderShareEndpoint = { role: 'host' } | { role: 'guest'; memberId: string };
export interface ProviderShareScope {
  shareId: string;
  target: ProviderShareEndpoint;
  /** Authored by the relay, never trusted from a sending client. */
  source?: ProviderShareEndpoint;
}
export function providerShareIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error('Invalid providerShare identifier');
  return value;
}
function endpoint(value: unknown): ProviderShareEndpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid providerShare endpoint');
  const row = value as Record<string, unknown>;
  if (row.role === 'host' && row.memberId === undefined) return { role: 'host' };
  if (row.role === 'guest') return { role: 'guest', memberId: providerShareIdentifier(row.memberId) };
  throw new Error('Invalid providerShare endpoint');
}
/** Request parsing deliberately discards any client-supplied source. */
export function parseProviderShareScope(value: unknown, withSource = false): ProviderShareScope | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    const scope: ProviderShareScope = { shareId: providerShareIdentifier(row.shareId), target: endpoint(row.target) };
    if (withSource) {
      scope.source = endpoint(row.source);
      if (scope.source.role === scope.target.role) return null;
    }
    return scope;
  } catch { return null; }
}
