import { randomUUID } from 'node:crypto';
import {
  isLoopbackProviderUrl,
  mergeDiscoveredRuntimeModels,
  runtimeCustomProviderId,
  type AgentKind,
  type CustomProviderConfig,
} from '@cindy/model-providers';
import type { AppModelsRequest } from '@cindy/mcps';
import type { registerProviderHandlers } from '../maker-ipc/providerHandlers.js';
import { validateCustomProviderConfig } from '../maker-host/custom-provider-store.js';

type Change = Extract<AppModelsRequest, { operation: 'connection' }>['change'];
type Actions = ReturnType<typeof registerProviderHandlers>['connections'];
export type RequestProviderSecret = (
  name: string,
  endpoints: string[],
  lifetime: {
    signal?: AbortSignal;
    deadline: number;
  },
) => Promise<string | null>;

function publicEndpoint(raw: string): string {
  const url = new URL(raw);
  url.username = url.password = url.search = url.hash = '';
  return url.toString();
}

function describeRuntimes(runtimes: CustomProviderConfig['runtimes']) {
  return Object.fromEntries(
    Object.entries(runtimes).map(([agent, runtime]) => [
      agent,
      runtime && {
        baseUrl: publicEndpoint(runtime.baseUrl),
        ...(runtime.modelsUrl ? { modelsUrl: publicEndpoint(runtime.modelsUrl) } : {}),
        wireProtocol: runtime.wireProtocol,
        supportsImageGeneration: runtime.supportsImageGeneration,
        models: runtime.models.map((model) => ({ id: model.id, name: model.name })),
      },
    ]),
  );
}

const busyReceipt = (busyCount: number) => ({
  ok: false,
  saved: false,
  errorCode: 'CODEX_RELOAD_CONFIRMATION_REQUIRED',
  confirmationRequired: 'codex-image-generation-reload',
  busyCount,
});

/** Agent configuration uses Settings transactions; secrets never cross the tool boundary. */
export async function manageProviderConnection(
  change: Change,
  api: Actions,
  guard: () => Promise<void>,
  requestSecret: (name: string, endpoints: string[]) => Promise<string | null>,
) {
  await guard();
  if (change.action === 'presets')
    return {
      presets: api.presets().map((preset) => ({
        id: preset.id,
        name: preset.name,
        authMethod: preset.authMethod ?? 'apiKey',
        runtimes: describeRuntimes(preset.runtimes),
      })),
    };
  const interrupt = 'interruptCodex' in change && change.interruptCodex === true;
  if (change.action === 'test') {
    const result = await api.test(change.providerId, change.agent);
    await guard();
    // Upstream error bodies can echo authentication material. Only classification crosses MCP.
    return {
      providerId: change.providerId,
      verification: {
        ok: result.ok,
        code: result.code,
        status: result.status,
        latencyMs: result.latencyMs,
      },
    };
  }
  if (change.action === 'create') {
    if (!!change.presetId === !!change.runtimes)
      throw new Error('Choose a preset or explicit runtimes');
    const preset = change.presetId
      ? api.presets().find((value) => value.id === change.presetId)
      : undefined;
    if (change.presetId && !preset) throw new Error('Preset unavailable');
    const authMethod = change.authMethod ?? preset?.authMethod ?? 'apiKey';
    const runtimes: CustomProviderConfig['runtimes'] = {};
    for (const [agent, runtime] of Object.entries(preset?.runtimes ?? change.runtimes ?? {})) {
      if (!runtime) continue;
      runtimes[agent as AgentKind] = {
        ...runtime,
        ...(preset ? { catalogPresetId: preset.id } : {}),
        models: runtime.models.map((model: { id: string; name?: string }) => ({
          ...model,
          name: model.name ?? model.id,
          ...(!preset && model.name !== undefined ? { nameExplicit: true } : {}),
        })),
      };
    }
    const config: CustomProviderConfig = {
      id: `api-${randomUUID().slice(0, 32)}`,
      name: change.name,
      auth: { method: authMethod },
      runtimes,
    };
    if (!validateCustomProviderConfig(config).ok) throw new Error('Invalid connection');
    const busy = api.checkHostChange(config, null);
    if (busy && !interrupt) return busyReceipt(busy);
    const keys: Partial<Record<AgentKind, string>> = {};
    try {
      // Reuse an answer only for identical endpoint sets; never silently share it across origins.
      const groups = new Map<string, AgentKind[]>();
      for (const [agent, runtime] of Object.entries(runtimes)) {
        if (!runtime) continue;
        const endpoints = [
          ...new Set([runtime.baseUrl, runtime.modelsUrl].filter((url): url is string => !!url)),
        ];
        if (authMethod === 'none') {
          if (!endpoints.every(isLoopbackProviderUrl))
            throw new Error('Unauthenticated connection must be local');
          continue;
        }
        const signature = JSON.stringify(endpoints);
        groups.set(signature, [...(groups.get(signature) ?? []), agent as AgentKind]);
      }
      for (const [signature, agents] of groups) {
        await guard();
        const value = await requestSecret(config.name, JSON.parse(signature));
        await guard();
        if (!value?.trim()) return { status: 'cancelled', saved: false };
        for (const agent of agents) keys[agent] = value;
      }
      await guard();
      const result = await api.create(config, keys, guard, interrupt);
      await guard();
      return {
        ...result,
        saved: result.ok,
        ...(result.ok ? { providerId: runtimeCustomProviderId(config.id) } : {}),
        verified: false,
      };
    } finally {
      for (const agent of Object.keys(keys)) delete keys[agent as AgentKind];
    }
  }
  const config = await api.get(change.providerId);
  await guard();
  if (!config) throw new Error('Connection unavailable');
  if (change.action === 'read')
    return {
      providerId: change.providerId,
      name: config.name,
      authMethod: config.auth?.method ?? 'apiKey',
      runtimes: describeRuntimes(config.runtimes),
    };
  if (config.auth?.method === 'oauth')
    throw new Error('Use subscription or OAuth connection tools');
  const baseline = JSON.stringify(config);
  const keepCurrent = (current: CustomProviderConfig) => {
    if (JSON.stringify(current) !== baseline) throw new Error('Connection changed');
    return current;
  };
  if (change.action === 'remove') {
    const busy = api.checkHostChange(null, config);
    if (busy && !interrupt) return busyReceipt(busy);
    const result = await api.remove(config, guard, interrupt);
    await guard();
    return { ...result, removed: result.ok, providerId: change.providerId };
  }
  if (change.action !== 'setRuntime' && !config.runtimes[change.agent])
    throw new Error('Runtime unavailable');
  if (change.action === 'setKey' || change.action === 'setRuntime') {
    const runtime =
      change.action === 'setRuntime'
        ? {
            ...change.runtime,
            models: change.runtime.models.map((model) => ({
              ...model,
              name: model.name ?? model.id,
              ...(model.name !== undefined ? { nameExplicit: true } : {}),
            })),
          }
        : config.runtimes[change.agent]!;
    const next = { ...config, runtimes: { ...config.runtimes, [change.agent]: runtime } };
    const endpoints = [
      ...new Set([runtime.baseUrl, runtime.modelsUrl].filter((url): url is string => !!url)),
    ];
    if (
      change.action === 'setRuntime' &&
      config.auth?.method === 'none' &&
      !endpoints.every(isLoopbackProviderUrl)
    )
      throw new Error('Unauthenticated connection must be local');
    const previous = config.runtimes[change.agent];
    const requiresKey =
      change.action === 'setKey' ||
      (config.auth?.method !== 'none' &&
        (!previous ||
          previous.baseUrl !== runtime.baseUrl ||
          previous.modelsUrl !== runtime.modelsUrl));
    const busy = api.checkHostChange(next, config, requiresKey && change.agent === 'codex');
    if (busy && !interrupt) return busyReceipt(busy);
    if (change.action === 'setKey' && config.auth?.method === 'none')
      throw new Error('Connection does not use a key');
    let value = requiresKey ? await requestSecret(config.name, endpoints) : null;
    const keys: Partial<Record<AgentKind, string>> = {};
    try {
      await guard();
      if (requiresKey && !value?.trim()) return { status: 'cancelled', saved: false };
      if (value) keys[change.agent] = value;
      const result = await api.update(
        config,
        keys,
        guard,
        (current) => {
          keepCurrent(current);
          return next;
        },
        interrupt,
      );
      await guard();
      return { ...result, saved: result.ok, providerId: change.providerId, verified: false };
    } finally {
      value = null;
      delete keys[change.agent];
    }
  }
  const fetched = change.action === 'refreshModels' ? await api.fetch(config, change.agent) : null;
  await guard();
  if (fetched && !fetched.ok)
    return {
      ok: false,
      providerId: change.providerId,
      errorCode: fetched.code ?? 'MODEL_DISCOVERY_FAILED',
      status: fetched.status,
      saved: false,
    };
  const next = (current: CustomProviderConfig): CustomProviderConfig => {
    keepCurrent(current);
    const runtime = current.runtimes[change.agent]!;
    const models =
      change.action === 'setModels'
        ? change.models.map((model) => ({
            ...runtime.models.find((old) => old.id === model.id),
            ...model,
            name: model.name ?? runtime.models.find((old) => old.id === model.id)?.name ?? model.id,
            ...(model.name !== undefined ? { nameExplicit: true } : {}),
          }))
        : mergeDiscoveredRuntimeModels(runtime.models, fetched?.models ?? []);
    return {
      ...current,
      runtimes: { ...current.runtimes, [change.agent]: { ...runtime, models } },
    };
  };
  const result = await api.update(config, {}, guard, next, interrupt);
  await guard();
  return {
    ...result,
    saved: result.ok,
    providerId: change.providerId,
    discoveredModelCount: fetched?.models?.length,
    verified: false,
  };
}
