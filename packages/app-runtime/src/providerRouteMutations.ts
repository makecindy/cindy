import {runtimeCustomProviderId, type AgentKind, type RoutingDescriptor} from '@cindy/model-providers';
export type ProviderRouteMutationRelease = (() => void) & {commit(): void};
export function createProviderRouteMutations(host: {
 inferProviderIdForModel(model: string, agent: AgentKind): string | null | undefined;
 getProviderRoutingDescriptor(provider: string | null | undefined, agent: AgentKind, model: string): RoutingDescriptor | null;
}) {
const {inferProviderIdForModel, getProviderRoutingDescriptor} = host;
const providerRouteMutationCounts = new Map<string, number>();
const providerRouteCredentialRevisions = new Map<string, number>();
let nextProviderRouteCredentialRevision = 1;
const providerRouteMutationWaiters = new Map<string, Set<() => void>>();

function beginProviderRouteMutation(providerId: string): ProviderRouteMutationRelease {
  providerId = runtimeCustomProviderId(providerId);
  const revision = nextProviderRouteCredentialRevision++;
  providerRouteMutationCounts.set(
    providerId,
    (providerRouteMutationCounts.get(providerId) ?? 0) + 1,
  );
  let finished = false;
  let committed = false;
  const finish = (() => {
    if (finished) return;
    finished = true;
    const remaining = (providerRouteMutationCounts.get(providerId) ?? 1) - 1;
    if (remaining <= 0) {
      providerRouteMutationCounts.delete(providerId);
      const waiters = providerRouteMutationWaiters.get(providerId);
      providerRouteMutationWaiters.delete(providerId);
      for (const resolve of waiters ?? []) resolve();
    }
    else providerRouteMutationCounts.set(providerId, remaining);
  }) as ProviderRouteMutationRelease;
  finish.commit = () => {
    if (finished || committed) return;
    committed = true;
    providerRouteCredentialRevisions.set(providerId, revision);
  };
  return finish;
}

/**
 * Non-sensitive request-dispatch generation for Provider routing, capabilities and credentials.
 * Kept for the process lifetime (including after delete) so deleting and recreating the same id
 * cannot make an old Host snapshot valid again.
 */
function getProviderRouteCredentialRevision(providerId: string): number {
  return providerRouteCredentialRevisions.get(runtimeCustomProviderId(providerId)) ?? 0;
}

function isProviderRouteMutationInProgress(providerId: string): boolean {
  return providerRouteMutationCounts.has(runtimeCustomProviderId(providerId));
}

async function captureCodexLocalAuthPolicy(
  providerId: string | null | undefined,
  modelId: string,
  signal?: AbortSignal,
): Promise<{ policy: 'isolated' | 'legacy-shared'; isCurrent: () => boolean }> {
  // With an inferred source the transaction may temporarily remove the model
  // from the catalog. Wait before inference, rather than freezing an unknown route.
  while (true) {
    signal?.throwIfAborted();
    const pending = providerId
      ? [runtimeCustomProviderId(providerId)].filter(isProviderRouteMutationInProgress)
      : [...providerRouteMutationCounts.keys()];
    if (pending.length === 0) break;
    await Promise.all(pending.map((id) => new Promise<void>((resolve, reject) => {
      const waiters = providerRouteMutationWaiters.get(id) ?? new Set<() => void>();
      const done = () => {
        signal?.removeEventListener('abort', cancel);
        waiters.delete(done);
        if (waiters.size === 0) providerRouteMutationWaiters.delete(id);
        resolve();
      };
      const cancel = () => {
        signal?.removeEventListener('abort', cancel);
        waiters.delete(done);
        if (waiters.size === 0) providerRouteMutationWaiters.delete(id);
        reject(signal?.reason);
      };
      signal?.addEventListener('abort', cancel, { once: true });
      waiters.add(done);
      providerRouteMutationWaiters.set(id, waiters);
    })));
  }
  const source = providerId ?? inferProviderIdForModel(modelId, 'codex');
  const routing = getProviderRoutingDescriptor(source, 'codex', modelId);
  // Keep legacy reuse for third-party OAuth and unknown routes. This
  // is compatibility policy, not a claim that they need official Codex OAuth.
  const revision = nextProviderRouteCredentialRevision;
  return {
    policy: routing?.authStrategy === 'api-key-header' || routing?.authStrategy === 'gateway-key'
      ? 'isolated' : 'legacy-shared',
    isCurrent: () => revision === nextProviderRouteCredentialRevision,
  };
}

async function resolveCodexLocalAuthPolicy(
  providerId: string | null | undefined,
  modelId: string,
): Promise<'isolated' | 'legacy-shared'> {
  return (await captureCodexLocalAuthPolicy(providerId, modelId)).policy;
}
return { beginProviderRouteMutation, getProviderRouteCredentialRevision, isProviderRouteMutationInProgress, captureCodexLocalAuthPolicy, resolveCodexLocalAuthPolicy };
}
