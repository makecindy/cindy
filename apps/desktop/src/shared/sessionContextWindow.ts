import type { AgentKind, Catalog, CatalogModel } from '@cindy/model-providers';
import { dbToMakerAgentKind } from './agentKindConversion';

/** Route identity carried by both persisted sessions and their renderer projection. */
export interface ContextWindowSession {
  agentKind?: string | null;
  model?: string | null;
  providerId?: string | null;
}

/**
 * Shared with runtime usage normalization: only an unambiguous, verified route
 * may replace a reported window. Never borrow a same-id model from another provider.
 */
export function resolveVerifiedContextWindow(
  catalog: Pick<Catalog, 'providers'>,
  agent: AgentKind,
  providerId: string | null | undefined,
  modelId: string,
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
  return Number.isFinite(only.contextWindow) && only.contextWindow > 0 ? only.contextWindow : null;
}

/** Pi's runtime window can differ from its catalog; preserve its saved snapshot. */
export function resolveSessionContextWindow(
  catalog: Pick<Catalog, 'providers'>,
  session: ContextWindowSession,
): number | null {
  if (!session.model || session.agentKind === 'pi') return null;
  return resolveVerifiedContextWindow(
    catalog,
    dbToMakerAgentKind(session.agentKind),
    session.providerId,
    session.model,
  );
}

/** Read-only projection: retain token counts and storage, refresh only the denominator. */
export function projectSessionContextWindow<
  T extends ContextWindowSession & { contextWindow: number },
>(session: T, resolve?: (session: ContextWindowSession) => number | null): T {
  const window = resolve?.(session);
  return window && Number.isFinite(window) && window > 0 && window !== session.contextWindow
    ? { ...session, contextWindow: window }
    : session;
}
