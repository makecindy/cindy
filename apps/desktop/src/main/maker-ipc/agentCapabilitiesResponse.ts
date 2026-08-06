import {
  resolveDefaultModel,
  type AgentKind,
  type Catalog,
} from '@cindy/model-providers';

export interface SessionDefaultModelCandidate {
  id: string;
  sortOrder?: number;
  defaultEnabled?: boolean;
  newSessionDefault?: boolean;
}

/**
 * Resolve the product default for an uncustomized new session/Worker.
 * Registry `newSessionDefault` is the highest-priority product marker, then catalog sessionModel,
 * then visible catalog order. Callers may restrict candidates to currently routable models.
 */
export function resolveActiveSessionDefaultModel(
  models: readonly SessionDefaultModelCandidate[],
  catalog: Pick<Catalog, 'providers' | 'defaults'>,
  agent: AgentKind,
  isRoutable: (modelId: string) => boolean = () => true,
): string | undefined {
  const candidates = models.filter((model) => isRoutable(model.id));
  const visible = candidates.filter((model) => model.defaultEnabled !== false);
  const byOrder = (a: SessionDefaultModelCandidate, b: SessionDefaultModelCandidate): number =>
    (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER);
  const marker = visible
    .filter((model) => model.newSessionDefault === true)
    .slice()
    .sort(byOrder)[0];
  if (marker) return marker.id;

  const catalogDefault = resolveDefaultModel(
    catalog,
    agent,
    'session',
    agent === 'codex' ? 'gpt-5.5' : agent === 'claude-code' ? 'claude-sonnet-4-6' : '',
  );
  if (catalogDefault && visible.some((model) => model.id === catalogDefault)) {
    return catalogDefault;
  }

  const pool = visible.length > 0 ? visible : candidates;
  return pool.slice().sort(byOrder)[0]?.id;
}

/**
 * Attach the Main process active-catalog session default to an agent capability snapshot.
 * The field is optional on the wire for old-peer compatibility; Pi omits it when the catalog has
 * no cross-provider default and lets the connected-model picker choose its first routable entry.
 */
export function withSessionDefaultModel<T extends { availableModels: readonly SessionDefaultModelCandidate[] }>(
  capabilities: T,
  catalog: Pick<Catalog, 'providers' | 'defaults'>,
  agent: AgentKind,
): T & { sessionDefaultModel?: string } {
  const sessionDefaultModel = resolveActiveSessionDefaultModel(
    capabilities.availableModels,
    catalog,
    agent,
  );
  return sessionDefaultModel ? { ...capabilities, sessionDefaultModel } : capabilities;
}
