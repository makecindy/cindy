import type { CustomProviderConfig } from '@cindy/model-providers';
import {
  LLAMACPP_DEFAULT_CONTEXT,
  llamaCppContextSize,
  supportsLlamaCppMillionContext,
  LLAMACPP_MANAGED_ORIGIN,
  MANAGED_LLAMACPP_PROVIDER_ID,
  type LlamaCppModel,
  type LlamaCppCatalogEntry,
} from '../../shared/llamaCpp.js';
import {
  createCustomProvider,
  getCustomProvider,
  updateCustomProviderIfUnchanged,
} from '../maker-host/custom-provider-store.js';

export function isManagedLlamaCppProvider(config: CustomProviderConfig): boolean {
  return (
    config.id === MANAGED_LLAMACPP_PROVIDER_ID &&
    config.auth?.method === 'none' &&
    Object.values(config.runtimes).every(
      (r) =>
        !r || (r.baseUrl === `${LLAMACPP_MANAGED_ORIGIN}/v1` && r.wireProtocol === 'openai-chat'),
    )
  );
}
export function buildManagedLlamaCppProvider(
  models: LlamaCppModel[],
  existing?: CustomProviderConfig,
  catalog: LlamaCppCatalogEntry[] = [],
): CustomProviderConfig {
  const runtimes: CustomProviderConfig['runtimes'] = {};
  for (const agent of ['pi', 'codex', 'claude-code'] as const) {
    const previous = existing?.runtimes[agent];
    runtimes[agent] = {
      ...previous,
      baseUrl: `${LLAMACPP_MANAGED_ORIGIN}/v1`,
      wireProtocol: 'openai-chat',
      models: models.map((model) => {
        const saved = previous?.models.find((m) => m.id === model.id);
        return {
          ...saved,
          id: model.id,
          name:
            saved?.name ??
            catalog.find((entry) =>
              entry.variants.some((v) => v.repo === model.repo && v.file === model.file),
            )?.name ??
            `${model.repo.split('/')[1]} · ${model.file.split('/').at(-1)}`,
          ...(supportsLlamaCppMillionContext(model) ? { contextWindowMax: 1_000_000 } : {}),
          // Upgrade the previous managed default, preserving explicit custom budgets.
          contextWindow:
            !saved?.contextWindow || saved.contextWindow === LLAMACPP_DEFAULT_CONTEXT
              ? llamaCppContextSize(model)
              : saved.contextWindow,
        };
      }),
    };
  }
  return {
    ...existing,
    id: MANAGED_LLAMACPP_PROVIDER_ID,
    name: existing?.name ?? 'llama.cpp',
    auth: { method: 'none' },
    runtimes,
  };
}
export async function ensureManagedLlamaCppProvider(
  models: LlamaCppModel[] | undefined,
  stillActive: () => boolean,
  catalog: LlamaCppCatalogEntry[] = [],
): Promise<boolean> {
  if (!stillActive()) throw new Error('OWNER_CHANGED');
  const existing = await getCustomProvider(MANAGED_LLAMACPP_PROVIDER_ID);
  if (!stillActive()) throw new Error('OWNER_CHANGED');
  if (existing && !isManagedLlamaCppProvider(existing)) throw new Error('PROVIDER_CONFLICT');
  // Adding a provider must not probe the runtime or replace existing model settings.
  if (existing && models === undefined) return false;
  // Only the explicit Add action may create a connection. Late downloads and
  // reconciliation must never undo deletion, including deletion during CAS.
  if (!existing && models !== undefined) return false;
  const next = buildManagedLlamaCppProvider(models ?? [], existing ?? undefined, catalog);
  if (JSON.stringify(next) === JSON.stringify(existing)) return false;
  if (existing) {
    if (!(await updateCustomProviderIfUnchanged(existing.id, existing, next)))
      throw new Error('PROVIDER_CONFLICT');
  } else {
    await createCustomProvider(next);
  }
  return true;
}
