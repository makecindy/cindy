import type { AgentKind, Catalog, CatalogModel } from './types.js';

/**
 * Resolve catalog metadata for an unambiguous, verified route. Callers decide
 * whether it is a fallback or a projection; it cannot replace native Codex usage.
 * Never borrow a same-id model from another provider.
 */
export function resolveVerifiedContextWindow(
  catalog: Pick<Catalog, 'providers'>,
  agent: AgentKind,
  providerId: string | null | undefined,
  modelId: string,
  workingBudget?: number | null,
): number | null {
  const candidates: CatalogModel[] = [];
  for (const provider of catalog.providers) {
    if (provider.routing[agent]?.disabled === true) continue;
    if (providerId && provider.id !== providerId) continue;
    for (const model of provider.models[agent] ?? []) {
      if (model.id === modelId) candidates.push(model);
    }
  }
  if (candidates.length !== 1) return null;
  const only = candidates[0];
  if (only.contextWindowVerified !== true) return null;
  if (!Number.isFinite(only.contextWindow) || only.contextWindow <= 0) return null;
  // The working default may be deliberately below the verified route maximum.
  // An explicit budget can raise that default, but cannot raise physical capacity.
  const maximum = typeof only.contextWindowMax === 'number' &&
    Number.isFinite(only.contextWindowMax) && only.contextWindowMax > 0
    ? only.contextWindowMax : only.contextWindow;
  const budget = typeof workingBudget === 'number' && Number.isFinite(workingBudget) && workingBudget > 0
    ? workingBudget : only.contextWindow;
  return Math.min(budget, maximum);
}

