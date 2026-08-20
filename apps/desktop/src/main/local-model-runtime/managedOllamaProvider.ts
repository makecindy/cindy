import type {
  AgentKind,
  CustomProviderConfig,
  CustomProviderRuntimeConfig,
  ProviderRuntimeModelConfig,
} from '@cindy/model-providers';

import {
  canonicalOllamaModelRef,
  curatedOllamaDisplayName,
  MANAGED_OLLAMA_PROVIDER_ID,
  matchesLegacyPiOnlyOllamaFingerprint,
  matchesManagedOllamaFingerprint,
  matchesManagedOllamaV2Fingerprint,
  ollamaModelRefsEqual,
  OLLAMA_ANTHROPIC_BASE_URL,
  OLLAMA_OPENAI_BASE_URL,
} from '../../shared/localModelRuntime.js';
import {
  createCustomProvider,
  getCustomProvider,
  updateCustomProvider,
} from '../maker-host/custom-provider-store.js';

export type ManagedEnsureResult =
  | { ok: true; created: boolean; provider: CustomProviderConfig }
  | { ok: false; code: 'OWNER_CHANGED' }
  | { ok: false; code: 'MANAGED_ID_CONFLICT'; existing: CustomProviderConfig };

export interface ManagedOllamaWriteOpts {
  stillActive?: () => boolean;
  retainCanonicalIds?: ReadonlySet<string>;
}

export type ManagedOllamaAgent = Extract<AgentKind, 'pi' | 'claude-code' | 'codex'>;

let mutationQueue: Promise<unknown> = Promise.resolve();
let removalGeneration = 0;

export function markManagedOllamaRemoved(): void {
  removalGeneration += 1;
}

export function managedOllamaRemovalGeneration(): number {
  return removalGeneration;
}

function enqueueManaged<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(fn, fn);
  mutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function fingerprintOf(config: CustomProviderConfig): boolean {
  return matchesManagedOllamaFingerprint({
    id: config.id,
    authMethod: config.auth?.method,
    runtimes: config.runtimes,
  });
}

export function emptyPiRuntime(
  models: ProviderRuntimeModelConfig[] = [],
): CustomProviderRuntimeConfig {
  return { baseUrl: OLLAMA_OPENAI_BASE_URL, wireProtocol: 'openai-chat', models };
}

export function emptyClaudeRuntime(
  models: ProviderRuntimeModelConfig[] = [],
): CustomProviderRuntimeConfig {
  return { baseUrl: OLLAMA_ANTHROPIC_BASE_URL, wireProtocol: 'anthropic-messages', models };
}

export function emptyCodexRuntime(
  models: ProviderRuntimeModelConfig[] = [],
): CustomProviderRuntimeConfig {
  // Real Codex turns send ~400KB Responses payloads. Ollama's native
  // /v1/responses can sit silent past the proxy's 10-minute socket timeout.
  // Chat Completions via the existing local bridge streams first tokens sooner.
  return { baseUrl: OLLAMA_OPENAI_BASE_URL, wireProtocol: 'openai-chat', models };
}

export function buildEmptyManagedOllamaProvider(): CustomProviderConfig {
  return {
    id: MANAGED_OLLAMA_PROVIDER_ID,
    name: 'Ollama',
    auth: { method: 'none' },
    runtimes: {
      pi: emptyPiRuntime(),
      'claude-code': emptyClaudeRuntime(),
      codex: emptyCodexRuntime(),
    },
  };
}

export function toPlainRuntimeModel(
  name: string,
  contextLength?: number,
): ProviderRuntimeModelConfig {
  return {
    id: name,
    name: curatedOllamaDisplayName(name) ?? name,
    reasoning: false,
    ...(contextLength && contextLength > 0 ? { contextWindow: contextLength } : {}),
  };
}

export function toQwenRuntimeModel(
  name: string,
  contextLength?: number,
): ProviderRuntimeModelConfig {
  const contextWindow = contextLength && contextLength > 0 ? contextLength : 32_768;
  return {
    ...toPlainRuntimeModel(name, contextWindow),
    supportsImageInput: true,
    reasoning: true,
    reasoningEfforts: ['xhigh'],
    reasoningDefaultEffort: 'xhigh',
    thinkingToggle: true,
  };
}

function toAgentModel(
  model: ProviderRuntimeModelConfig,
  agent: ManagedOllamaAgent,
): ProviderRuntimeModelConfig {
  const named = {
    ...model,
    name: curatedOllamaDisplayName(model.id) ?? model.name,
  };
  if (agent === 'pi') return named;
  return {
    id: named.id,
    name: named.name,
    ...(named.contextWindow ? { contextWindow: named.contextWindow } : {}),
    ...(named.supportsImageInput ? { supportsImageInput: true } : {}),
    ...(named.reasoning
      ? {
          reasoning: true,
          ...(named.reasoningEfforts ? { reasoningEfforts: named.reasoningEfforts } : {}),
          ...(named.reasoningDefaultEffort
            ? { reasoningDefaultEffort: named.reasoningDefaultEffort }
            : {}),
        }
      : {}),
  };
}

export function migrateManagedOllamaProvider(
  existing: CustomProviderConfig,
): CustomProviderConfig | null {
  const input = {
    id: existing.id,
    authMethod: existing.auth?.method,
    runtimes: existing.runtimes,
  };
  if (matchesManagedOllamaV2Fingerprint(input)) {
    const codex = existing.runtimes.codex;
    if (codex?.wireProtocol === 'openai-responses') {
      return {
        ...existing,
        runtimes: {
          ...existing.runtimes,
          codex: emptyCodexRuntime(codex.models ?? []),
        },
      };
    }
    return existing;
  }
  if (!matchesLegacyPiOnlyOllamaFingerprint(input)) return null;
  const piModels = existing.runtimes.pi?.models ?? [];
  return {
    ...existing,
    runtimes: {
      pi: emptyPiRuntime(piModels),
      'claude-code': emptyClaudeRuntime(
        piModels.map((model) => toAgentModel(model, 'claude-code')),
      ),
      codex: emptyCodexRuntime(piModels.map((model) => toAgentModel(model, 'codex'))),
    },
  };
}

/** Catalog 加载前调用：不依赖打开设置页，把旧 Responses 行迁成 Chat 桥。 */
export async function migrateManagedOllamaOnCatalogLoad(
  stillCurrent: () => boolean = () => true,
): Promise<boolean> {
  return enqueueManaged(async () => {
    if (!stillCurrent()) return false;
    const existing = await getCustomProvider(MANAGED_OLLAMA_PROVIDER_ID);
    if (!existing || !fingerprintOf(existing)) return false;
    const migrated = migrateManagedOllamaProvider(existing);
    if (!migrated) return false;
    if (JSON.stringify(migrated.runtimes) === JSON.stringify(existing.runtimes)) {
      return false;
    }
    if (!stillCurrent()) return false;
    const updated = await updateCustomProvider(MANAGED_OLLAMA_PROVIDER_ID, migrated);
    return updated !== null;
  });
}

/** 把 Pi 已有模型补到 CC / Codex。legacy 会先迁成三 runtime。返回是否写过库。 */
export async function syncManagedOllamaAgentProjections(
  agents: readonly ManagedOllamaAgent[] = ['pi', 'claude-code', 'codex'],
  opts?: ManagedOllamaWriteOpts,
): Promise<boolean> {
  return enqueueManaged(async () => {
    if (ownerChanged(opts)) return false;
    const existing = await getCustomProvider(MANAGED_OLLAMA_PROVIDER_ID);
    if (ownerChanged(opts)) return false;
    if (!existing || !fingerprintOf(existing)) return false;
    const migrated = migrateManagedOllamaProvider(existing) ?? existing;
    const piModels = migrated.runtimes.pi?.models ?? [];
    let next = migrated;
    for (const model of piModels) {
      next = applyModelToAgents(next, model, agents, 'upsert');
    }
    if (JSON.stringify(next.runtimes) === JSON.stringify(existing.runtimes)) return false;
    if (ownerChanged(opts)) return false;
    const updated = await updateCustomProvider(MANAGED_OLLAMA_PROVIDER_ID, next);
    return updated !== null;
  });
}

export async function readManagedOllamaProvider(): Promise<CustomProviderConfig | null> {
  const existing = await getCustomProvider(MANAGED_OLLAMA_PROVIDER_ID);
  if (!existing) return null;
  return fingerprintOf(existing) ? existing : null;
}

export async function ensureManagedOllamaProvider(
  opts?: ManagedOllamaWriteOpts,
): Promise<ManagedEnsureResult> {
  return enqueueManaged(() => ensureManagedOllamaProviderUnlocked(opts));
}

export async function upsertManagedOllamaModel(
  model: ProviderRuntimeModelConfig,
  agents: readonly ManagedOllamaAgent[] = ['pi', 'claude-code', 'codex'],
  opts?: ManagedOllamaWriteOpts,
): Promise<ManagedEnsureResult> {
  return upsertManagedOllamaModels([{ model, agents }], opts);
}

export async function upsertManagedOllamaModels(
  entries: readonly {
    model: ProviderRuntimeModelConfig;
    agents?: readonly ManagedOllamaAgent[];
  }[],
  opts?: ManagedOllamaWriteOpts,
): Promise<ManagedEnsureResult> {
  return enqueueManaged(async () => {
    if (opts?.stillActive && !opts.stillActive()) return { ok: false, code: 'OWNER_CHANGED' };
    const ensured = await ensureManagedOllamaProviderUnlocked(opts);
    if (!ensured.ok) return ensured;
    const latest = await getCustomProvider(MANAGED_OLLAMA_PROVIDER_ID);
    if (!latest || !fingerprintOf(latest)) {
      return { ok: false, code: 'MANAGED_ID_CONFLICT', existing: latest ?? ensured.provider };
    }
    let next = latest;
    for (const entry of entries) {
      next = applyModelToAgents(
        next,
        entry.model,
        entry.agents ?? ['pi', 'claude-code', 'codex'],
        'upsert',
      );
    }
    if (opts?.retainCanonicalIds) {
      next = retainCanonicalModels(next, opts.retainCanonicalIds);
    }
    if (opts?.stillActive && !opts.stillActive()) return { ok: false, code: 'OWNER_CHANGED' };
    if (JSON.stringify(next.runtimes) === JSON.stringify(latest.runtimes)) {
      return { ok: true, created: false, provider: latest };
    }
    const updated = await updateCustomProvider(MANAGED_OLLAMA_PROVIDER_ID, next);
    if (!updated) return { ok: false, code: 'MANAGED_ID_CONFLICT', existing: latest };
    return { ok: true, created: false, provider: updated };
  });
}

function retainCanonicalModels(
  provider: CustomProviderConfig,
  retain: ReadonlySet<string>,
): CustomProviderConfig {
  const runtimes = {
    pi: provider.runtimes.pi ?? emptyPiRuntime(),
    'claude-code': provider.runtimes['claude-code'] ?? emptyClaudeRuntime(),
    codex: provider.runtimes.codex ?? emptyCodexRuntime(),
  };
  for (const agent of ['pi', 'claude-code', 'codex'] as const) {
    const current = runtimes[agent];
    runtimes[agent] = {
      ...current,
      models: current.models.filter((entry) => retain.has(canonicalOllamaModelRef(entry.id))),
    };
  }
  return { ...provider, runtimes };
}

export async function removeManagedOllamaModel(
  name: string,
  opts?: ManagedOllamaWriteOpts,
): Promise<ManagedEnsureResult> {
  return enqueueManaged(async () => {
    if (ownerChanged(opts)) return { ok: false, code: 'OWNER_CHANGED' };
    const existing = await getCustomProvider(MANAGED_OLLAMA_PROVIDER_ID);
    if (ownerChanged(opts)) return { ok: false, code: 'OWNER_CHANGED' };
    if (!existing) {
      return { ok: true, created: false, provider: buildEmptyManagedOllamaProvider() };
    }
    if (!fingerprintOf(existing)) {
      return { ok: false, code: 'MANAGED_ID_CONFLICT', existing };
    }
    const next = applyModelToAgents(
      existing,
      { id: name, name },
      ['pi', 'claude-code', 'codex'],
      'remove',
    );
    if (ownerChanged(opts)) return { ok: false, code: 'OWNER_CHANGED' };
    const updated = await updateCustomProvider(MANAGED_OLLAMA_PROVIDER_ID, next);
    if (!updated) return { ok: false, code: 'MANAGED_ID_CONFLICT', existing };
    return { ok: true, created: false, provider: updated };
  });
}

function applyModelToAgents(
  provider: CustomProviderConfig,
  model: ProviderRuntimeModelConfig,
  agents: readonly ManagedOllamaAgent[],
  mode: 'upsert' | 'remove',
): CustomProviderConfig {
  const runtimes = {
    pi: provider.runtimes.pi ?? emptyPiRuntime(),
    'claude-code': provider.runtimes['claude-code'] ?? emptyClaudeRuntime(),
    codex: provider.runtimes.codex ?? emptyCodexRuntime(),
  };
  const allAgents: ManagedOllamaAgent[] = ['pi', 'claude-code', 'codex'];
  for (const agent of allAgents) {
    const current = runtimes[agent];
    const without = current.models.filter((entry) => !ollamaModelRefsEqual(entry.id, model.id));
    const keep = mode === 'upsert' && agents.includes(agent);
    runtimes[agent] = {
      ...current,
      models: keep ? [...without, toAgentModel(model, agent)] : without,
    };
  }
  return { ...provider, runtimes };
}

function ownerChanged(opts?: ManagedOllamaWriteOpts): boolean {
  return Boolean(opts?.stillActive && !opts.stillActive());
}

async function ensureManagedOllamaProviderUnlocked(
  opts?: ManagedOllamaWriteOpts,
): Promise<ManagedEnsureResult> {
  if (ownerChanged(opts)) return { ok: false, code: 'OWNER_CHANGED' };
  const existing = await getCustomProvider(MANAGED_OLLAMA_PROVIDER_ID);
  if (ownerChanged(opts)) return { ok: false, code: 'OWNER_CHANGED' };
  if (!existing) {
    try {
      const created = await createCustomProvider(buildEmptyManagedOllamaProvider());
      return { ok: true, created: true, provider: created };
    } catch {
      if (ownerChanged(opts)) return { ok: false, code: 'OWNER_CHANGED' };
      const raced = await getCustomProvider(MANAGED_OLLAMA_PROVIDER_ID);
      if (ownerChanged(opts)) return { ok: false, code: 'OWNER_CHANGED' };
      if (raced && fingerprintOf(raced)) {
        const migrated = migrateManagedOllamaProvider(raced) ?? raced;
        if (migrated !== raced) {
          if (ownerChanged(opts)) return { ok: false, code: 'OWNER_CHANGED' };
          const updated = await updateCustomProvider(MANAGED_OLLAMA_PROVIDER_ID, migrated);
          if (updated) return { ok: true, created: false, provider: updated };
        }
        return { ok: true, created: false, provider: raced };
      }
      if (raced) return { ok: false, code: 'MANAGED_ID_CONFLICT', existing: raced };
      throw new Error('failed to create managed ollama provider');
    }
  }
  if (!fingerprintOf(existing)) return { ok: false, code: 'MANAGED_ID_CONFLICT', existing };
  const migrated = migrateManagedOllamaProvider(existing);
  if (!migrated) return { ok: false, code: 'MANAGED_ID_CONFLICT', existing };
  if (migrated !== existing) {
    if (ownerChanged(opts)) return { ok: false, code: 'OWNER_CHANGED' };
    const updated = await updateCustomProvider(MANAGED_OLLAMA_PROVIDER_ID, migrated);
    if (!updated) return { ok: false, code: 'MANAGED_ID_CONFLICT', existing };
    return { ok: true, created: false, provider: updated };
  }
  return { ok: true, created: false, provider: existing };
}
