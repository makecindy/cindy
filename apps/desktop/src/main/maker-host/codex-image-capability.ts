import type { Catalog, CatalogModel, Provider } from '@cindy/model-providers';

import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';

export type ImageInputCapability = true | false | undefined;

export interface CodexImageCapabilityDeps {
  getCatalog: () => Catalog;
  getSessionProvider: (sessionId: string) => string | null;
}

function modelCapability(model: CatalogModel | undefined): ImageInputCapability {
  if (!model) return undefined;
  if (model.supportsImageInput !== undefined) return model.supportsImageInput;
  if (model.modalities !== undefined) return model.modalities.input.includes('image');
  return undefined;
}

function candidateModelIds(provider: Provider, modelId: string): Set<string> {
  const ids = new Set([modelId, modelId.replace(/\[1m\]$/, '')]);
  const stripPrefix = provider.routing.codex?.modelIdRewrite?.stripPrefix;
  if (stripPrefix && modelId.startsWith(stripPrefix)) {
    const stripped = modelId.slice(stripPrefix.length);
    ids.add(stripped);
    ids.add(stripped.replace(/\[1m\]$/, ''));
  }
  return ids;
}

function providerModel(provider: Provider, modelId: string): CatalogModel | undefined {
  const ids = candidateModelIds(provider, modelId);
  return provider.models.codex?.find((model) => ids.has(model.id));
}

/**
 * Resolves image support for the exact live Codex provider/model route.
 * Explicit catalog declarations always beat learned failures, so catalog refreshes can recover
 * a route without restarting Desktop. Undeclared routes remain optimistic until their first
 * schema rejection, after which only that exact route becomes marker-only.
 */
export class CodexImageCapabilityResolver {
  private readonly rejectedRoutes = new Set<string>();

  constructor(private readonly deps: CodexImageCapabilityDeps) {}

  resolve(sessionId: string, item: AgentInputQueuedMessage): ImageInputCapability {
    if (item.createOpts.agentKind !== 'codex') return true;
    return this.resolveCodexRoute(
      sessionId,
      item.createOpts.model || item.model,
      item.createOpts.providerId,
    );
  }

  resolveCodexRoute(
    sessionId: string,
    modelId: string,
    queuedProviderId?: string | null,
  ): ImageInputCapability {
    const providerId = this.deps.getSessionProvider(sessionId) ?? queuedProviderId ?? null;
    const catalog = this.deps.getCatalog();
    const provider = providerId
      ? catalog.providers.find((candidate) => candidate.id === providerId)
      : undefined;
    const explicit = modelCapability(provider ? providerModel(provider, modelId) : undefined);
    if (explicit !== undefined) return explicit;

    if (!providerId) {
      const matches = catalog.providers
        .map((candidate) => providerModel(candidate, modelId))
        .filter((model): model is CatalogModel => model !== undefined);
      const declared = new Set(
        matches
          .map(modelCapability)
          .filter((capability): capability is boolean => capability !== undefined),
      );
      if (declared.size === 1) return [...declared][0];
    }

    return this.rejectedRoutes.has(this.routeKey(providerId, modelId)) ? false : undefined;
  }

  markRejected(sessionId: string, item: AgentInputQueuedMessage): void {
    if (item.createOpts.agentKind !== 'codex') return;
    this.markCodexRouteRejected(
      sessionId,
      item.createOpts.model || item.model,
      item.createOpts.providerId,
    );
  }

  markCodexRouteRejected(
    sessionId: string,
    modelId: string,
    queuedProviderId?: string | null,
  ): void {
    const providerId = this.deps.getSessionProvider(sessionId) ?? queuedProviderId ?? null;
    const catalogProvider = providerId
      ? this.deps.getCatalog().providers.find((candidate) => candidate.id === providerId)
      : undefined;
    if (
      modelCapability(catalogProvider ? providerModel(catalogProvider, modelId) : undefined) ===
      true
    ) {
      return;
    }
    this.rejectedRoutes.add(this.routeKey(providerId, modelId));
  }

  clear(): void {
    this.rejectedRoutes.clear();
  }

  private routeKey(providerId: string | null, modelId: string): string {
    return `${providerId ?? '<default>'}\u0000${modelId}`;
  }
}

let defaultResolver: CodexImageCapabilityResolver | null = null;

export function getDefaultCodexImageCapabilityResolver(
  deps: CodexImageCapabilityDeps,
): CodexImageCapabilityResolver {
  defaultResolver ??= new CodexImageCapabilityResolver(deps);
  return defaultResolver;
}
