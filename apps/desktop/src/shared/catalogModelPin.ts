/**
 * A stable catalog route pin for one-shot text work.
 *
 * The provider and model ids may contain `:`, so the provider segment is URI
 * encoded while the model remains the final opaque segment. Keep this parser
 * shared by persistence, IPC and execution so a value accepted by Settings is
 * always decoded the same way at dispatch time.
 */

export const CATALOG_MODEL_PIN_PREFIX = 'cat:';

export type CatalogModelPinAgentKind = 'codex' | 'claude-code';

export interface CatalogModelPinRoute {
  providerId: string;
  agentKind: CatalogModelPinAgentKind;
  model: string;
}

const CATALOG_MODEL_PIN_AGENTS = new Set<CatalogModelPinAgentKind>(['codex', 'claude-code']);

/** Encode an exact provider × runtime × model route. */
export function encodeCatalogModelPin(route: CatalogModelPinRoute): string {
  return `${CATALOG_MODEL_PIN_PREFIX}${encodeURIComponent(route.providerId)}:${route.agentKind}:${route.model}`;
}

/** Decode a catalog pin; malformed or unsupported-runtime values return null. */
export function decodeCatalogModelPin(raw: string): CatalogModelPinRoute | null {
  if (!raw.startsWith(CATALOG_MODEL_PIN_PREFIX)) return null;
  const rest = raw.slice(CATALOG_MODEL_PIN_PREFIX.length);
  const firstSep = rest.indexOf(':');
  if (firstSep <= 0) return null;
  const secondSep = rest.indexOf(':', firstSep + 1);
  if (secondSep <= firstSep + 1) return null;

  let providerId: string;
  try {
    providerId = decodeURIComponent(rest.slice(0, firstSep));
  } catch {
    return null;
  }
  const agentKind = rest.slice(firstSep + 1, secondSep);
  const model = rest.slice(secondSep + 1);
  if (!providerId || !model || !CATALOG_MODEL_PIN_AGENTS.has(agentKind as CatalogModelPinAgentKind)) {
    return null;
  }
  return {
    providerId,
    agentKind: agentKind as CatalogModelPinAgentKind,
    model,
  };
}
