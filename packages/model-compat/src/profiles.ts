import { isXaiSchemaTarget } from './upstream/adapters/xai-tool-schema';
import { modelRecordValue } from './upstream/reasoning-effort';
import profiles from './upstream-profiles.json';
import { isPlainObject } from './object';

export type CompatibilityHarness = 'codex' | 'claude-code' | 'pi';
export type CompatibilityProtocol = 'openai-responses' | 'openai-chat' | 'anthropic' | 'google';
/** Execution facts, never inferred from the display name or a user's account identity. */
export interface CompatibilityRoute {
  harness: CompatibilityHarness;
  protocol: CompatibilityProtocol;
  upstreamBase: string;
  model: string;
  authMode?: 'oauth' | 'api-key';
}
export type ProviderCompatibilityProfile = Record<string, unknown> & { id: string; baseUrl: string; adapter: string };

/** Exact origin and path boundaries prevent a provider's patch leaking to a lookalike or proxy. */
function servesEndpoint(base: string, actual: string): boolean {
  try {
    const expected = new URL(base);
    const target = new URL(actual);
    const prefix = expected.pathname.replace(/\/+$/, '');
    return expected.origin === target.origin && (target.pathname === prefix || target.pathname.startsWith(prefix + '/'));
  } catch { return false; }
}

// Compare every transport declaration, ignoring only account identity metadata.
// Sort object keys because registry declarations need not use identical key order.
function policySignature(profile: ProviderCompatibilityProfile): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (!isPlainObject(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  };
  const policy = Object.fromEntries(Object.entries(profile).filter(([key]) => key !== 'id' && key !== 'authKind'));
  return JSON.stringify(canonical(policy));
}

/** Upstream provider declarations are compatibility data only: they never add accounts or models. */
export function resolveProviderCompatibilityProfile(route: CompatibilityRoute): ProviderCompatibilityProfile | null {
  // OpenCodex's xAI OAuth transport rewrites the public registry base to this exact
  // subscription endpoint. Reuse that transport predicate, not a model-name alias.
  if (isXaiSchemaTarget({ baseUrl: route.upstreamBase })) {
    return (profiles as ProviderCompatibilityProfile[]).find(profile => profile.id === 'xai') ?? null;
  }
  const matches = (profiles as ProviderCompatibilityProfile[]).filter(profile => servesEndpoint(profile.baseUrl, route.upstreamBase));
  matches.sort((a, b) => b.baseUrl.length - a.baseUrl.length);
  if (!matches.length) return null;
  let candidates = matches.filter(profile => profile.baseUrl === matches[0]!.baseUrl);
  const authKind = route.authMode === 'api-key' ? 'key' : route.authMode;
  if (authKind) {
    const authenticated = candidates.filter(profile => profile.authKind === authKind);
    if (authenticated.length) candidates = authenticated;
  }
  const first = candidates[0]!;
  // Duplicate account profiles with the same wire contract share the same patches.
  // Truly conflicting declarations remain unresolved; never guess from a model name.
  return candidates.every(profile => policySignature(profile) === policySignature(first)) ? first : null;
}

/** OpenCodex uses exact model membership, with a colon variant falling back to its base. */
export function profileModelValue(value: unknown, model: string): unknown {
  if (!isPlainObject(value)) return undefined;
  return modelRecordValue(value, model);
}
export function profileModelListed(value: unknown, model: string): boolean {
  if (!Array.isArray(value)) return false;
  return value.includes(model) || (model.includes(':') && value.includes(model.slice(0, model.indexOf(':'))));
}
