import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { AgentKind, DiscoveredModel, DiscoveredModelSource, Provider } from '@cindy/model-providers';

const key = randomBytes(32);
const sourceEpoch = randomUUID();
const receipts = new Map<string, {
  signature: string;
  agent: AgentKind;
  sources: Map<string, DiscoveredModelSource | undefined>;
  binding?: { providerId: string | undefined; isCurrent(): boolean };
}>();

/** Process-local receipts authenticate discovery provenance, without persisting credentials. */
export function modelSourceRequestSignature(url: string, init: RequestInit): string {
  const headers = [...new Headers(init.headers).entries()].sort(([a], [b]) => a.localeCompare(b));
  return createHmac('sha256', key).update(JSON.stringify([url, headers])).digest('hex');
}

export function issueModelSourceSnapshot(
  models: DiscoveredModel[], agent: AgentKind, signature: string, force = false,
): DiscoveredModel[] {
  if (!force && !models.some(model => model.discoveredSource)) return models;
  const id = `${sourceEpoch}:${randomUUID()}`;
  const result = models.map(model => model.discoveredSource
    ? { ...model, discoverySnapshotId: id, discoveredSource: { ...model.discoveredSource, snapshotId: id } } : { ...model, discoverySnapshotId: id });
  receipts.set(id, { agent, signature, sources: new Map(result.map(model => [model.id, model.discoveredSource])) });
  // Receipts are only needed between discovery and Settings commit, never after restart.
  while (receipts.size > 32) receipts.delete(receipts.keys().next().value!);
  return result;
}

/** A boot marker is only a display freshness check, never write authorization.
 * Old persisted labels cannot prove the credential transaction survived a crash.
 * Keep wire identity and raw persistence; re-discovery restores display provenance. */
export function projectCurrentModelSources(provider: Provider): Provider {
  const current = (source: DiscoveredModelSource | undefined) =>
    !source || source.snapshotId?.startsWith(`${sourceEpoch}:`) === true;
  if (Object.values(provider.models).every(models => models?.every(model =>
    current(model.discoveredSource) && current(model.userModelConfig?.discoveredSource)) !== false)) return provider;
  return { ...provider, models: Object.fromEntries(Object.entries(provider.models).map(([agent, models]) => [
    agent, models?.map(model => {
      const { discoveredSource, userModelConfig, ...rest } = model;
      if (current(discoveredSource) && current(userModelConfig?.discoveredSource)) return model;
      const cleanConfig = userModelConfig && (() => {
        const { discoveredSource: _source, ...config } = userModelConfig;
        return config;
      })();
      return { ...rest, ...(current(discoveredSource) && discoveredSource ? { discoveredSource } : {}),
        ...(cleanConfig ? { userModelConfig: cleanConfig } : {}) };
    }),
  ])) };
}

export function bindModelSourceSnapshot(models: DiscoveredModel[] | undefined, providerId: string | undefined, isCurrent: () => boolean): void {
  for (const model of models ?? []) {
    const snapshotId = model.discoverySnapshotId ?? model.discoveredSource?.snapshotId;
    const receipt = snapshotId && receipts.get(snapshotId);
    if (receipt) receipt.binding = { providerId, isCurrent };
  }
}

export function acceptsModelSourceSnapshot(
  modelId: string, source: DiscoveredModelSource | undefined, providerId: string, agent: AgentKind,
  signature?: string, snapshotId = source?.snapshotId,
): boolean {
  const receipt = snapshotId ? receipts.get(snapshotId) : undefined;
  const expected = receipt?.sources.get(modelId);
  const sameSource = expected === undefined ? source === undefined : source !== undefined
    && expected.kind === source.kind && expected.providerId === source.providerId
    && expected.label === source.label && expected.discoveredName === source.discoveredName
    && expected.snapshotId === source.snapshotId;
  if (!receipt || receipt.agent !== agent || !receipt.sources.has(modelId) || !sameSource) return false;
  return receipt.binding
    ? receipt.binding.isCurrent() && (receipt.binding.providerId !== undefined
      ? receipt.binding.providerId === providerId && (signature === undefined || receipt.signature === signature)
      : signature !== undefined && receipt.signature === signature)
    : signature !== undefined && receipt.signature === signature;
}
