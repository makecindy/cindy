import { createHash } from 'node:crypto';
export interface AppliedCodexProviderRoute { providerId: string; modelProviderId: string; responseModels: readonly string[] }


export interface CodexAppliedCustomProviderIdentityInput {
  agentKind: string;
  remoteHostId?: string | null;
  currentCodexProxyActive?: boolean | null;
  currentThreadModelProviderId?: string | null;
  targetProviderId?: string | null;
  targetModel?: string | null;
}


export function resolveCodexCustomProviderModelProviderId(
  routes: readonly AppliedCodexProviderRoute[],
  providerId: string | null | undefined,
  model: string | null | undefined,
): string | null {
  if (!providerId || !model) return null;
  const route = routes.find((candidate) => candidate.providerId === providerId);
  return route?.responseModels.includes(model) ? route.modelProviderId : null;
}
export function createCodexProviderIdentity(host: { appliedRoutes(): readonly AppliedCodexProviderRoute[]; allAppliedRoutes(): readonly AppliedCodexProviderRoute[] }) {
const RETIRED_IMAGE_GENERATION_PROVIDER_PREFIX = 'cindy_imagegen_';


/**
 * Whether a local Codex thread would cross the custom Provider identity frozen into its Host.
 * Membership in the applied snapshot is the authority: do not infer private identities from ids.
 */
function crossesCodexAppliedCustomProviderIdentity(
  input: CodexAppliedCustomProviderIdentityInput,
): boolean {
  if (input.agentKind !== 'codex' || input.remoteHostId || input.currentCodexProxyActive !== true) {
    return false;
  }

  const actual = input.currentThreadModelProviderId?.trim() || null;
  const appliedRoutes = host.allAppliedRoutes();
  const target = resolveCodexCustomProviderModelProviderId(appliedRoutes, input.targetProviderId?.trim() || null, input.targetModel?.trim() || null);
  const actualIsAppliedCustomProviderIdentity = appliedRoutes.some(
    (route) => route.modelProviderId === actual,
  );
  const actualIsRetiredPrototypeIdentity =
    actual?.startsWith(RETIRED_IMAGE_GENERATION_PROVIDER_PREFIX) === true;

  return target !== null
    ? actual !== target
    : actualIsAppliedCustomProviderIdentity || actualIsRetiredPrototypeIdentity;
}


/** Whether a thread provider id belongs to the currently applied dynamic route set. */
function isAppliedCodexCustomProviderIdentity(providerId: string | null | undefined): boolean {
  const actual = providerId?.trim() || null;
  return actual !== null && host.appliedRoutes().some(
    (route) => route.modelProviderId === actual,
  );
}
return { crossesCodexAppliedCustomProviderIdentity, isAppliedCodexCustomProviderIdentity };
}

export function stableCodexProviderRouteId(providerId: string): string {
  return createHash('sha256').update(providerId, 'utf8').digest('hex').slice(0, 20);
}
