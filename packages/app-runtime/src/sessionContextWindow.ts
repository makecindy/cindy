import type { AgentKind, Catalog, CatalogModel } from '@cindy/model-providers';
import { dbToMakerAgentKind } from '@cindy/maker-shared/agent-kind-conversion';

/** Route identity carried by both persisted sessions and their renderer projection. */
export interface ContextWindowSession {
  agentKind?: string | null;
  model?: string | null;
  providerId?: string | null;
}

export { resolveVerifiedContextWindow } from '@cindy/model-providers/verifiedContextWindow';

/** Resolve the unique catalog route used to build task-level context budget bounds. */
export function resolveRouteContextWindowBounds(
  catalog: Pick<Catalog, 'providers'>,
  agent: AgentKind,
  providerId: string | null | undefined,
  modelId: string,
): { providerId: string; defaultWindow: number; maxWindow: number | null } | null {
  const candidates: { providerId: string; model: CatalogModel }[] = [];
  for (const provider of catalog.providers) {
    if (provider.routing[agent]?.disabled === true) continue;
    if (providerId && provider.id !== providerId) continue;
    for (const model of provider.models[agent] ?? []) {
      if (model.id === modelId) candidates.push({ providerId: provider.id, model });
    }
  }
  if (candidates.length !== 1) return null;
  const { providerId: sourceProviderId, model } = candidates[0];
  const contextWindow = Number.isFinite(model.contextWindow) && model.contextWindow > 0
    ? Math.round(model.contextWindow) : null;
  const declaredMax = typeof model.contextWindowMax === 'number' &&
    Number.isFinite(model.contextWindowMax) && model.contextWindowMax > 0
    ? Math.round(model.contextWindowMax) : null;
  const maxWindow = declaredMax ?? (model.contextWindowVerified === true ? contextWindow : null);
  const anchor = maxWindow ?? contextWindow;
  if (anchor === null) return null;
  const defaultWindow = contextWindow === null ? anchor : Math.min(contextWindow, anchor);
  return { providerId: sourceProviderId, defaultWindow, maxWindow };
}
import { resolveVerifiedContextWindow } from '@cindy/model-providers/verifiedContextWindow';

/** Codex and Pi report their effective runtime windows; catalogs cannot replace them. */
export function resolveSessionContextWindow(
  catalog: Pick<Catalog, 'providers'>,
  session: ContextWindowSession,
): number | null {
  if (!session.model || session.agentKind === 'pi' || session.agentKind === 'codex') return null;
  return resolveVerifiedContextWindow(
    catalog,
    dbToMakerAgentKind(session.agentKind),
    session.providerId,
    session.model,
  );
}

/** Preserve proven runtime budgets; legacy catalog snapshots retain read-time correction. */
export function projectSessionContextWindow<
  T extends ContextWindowSession & { contextWindow: number; contextWindowRuntime?: number | null },
>(session: T, resolve?: (session: ContextWindowSession) => number | null): T {
  if (Number.isFinite(session.contextWindow) && session.contextWindow > 0 &&
      session.contextWindowRuntime === session.contextWindow) return session;
  const window = resolve?.(session);
  return window && Number.isFinite(window) && window > 0 && window !== session.contextWindow
    ? { ...session, contextWindow: window }
    : session;
}
