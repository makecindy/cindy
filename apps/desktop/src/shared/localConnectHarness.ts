import type {
  CustomProviderConfig,
  CustomProviderRuntimeConfig,
  ProviderRuntimeModelConfig,
} from '@cindy/model-providers';

import {
  LOCAL_ADVANCED_PRESET_IDS,
  MANAGED_LMSTUDIO_PROVIDER_ID,
} from './localModelRuntime.js';

function loopbackOrigin(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function copyModels(models: readonly ProviderRuntimeModelConfig[] = []): ProviderRuntimeModelConfig[] {
  return models.map((model) => ({
    id: model.id,
    name: model.name,
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(model.supportsImageInput ? { supportsImageInput: true } : {}),
  }));
}

function isPlainChatRuntime(
  runtime: CustomProviderRuntimeConfig | undefined,
): runtime is CustomProviderRuntimeConfig {
  if (!runtime?.baseUrl) return false;
  if (runtime.wireProtocol !== undefined && runtime.wireProtocol !== 'openai-chat') return false;
  if (runtime.headers && Object.keys(runtime.headers).length > 0) return false;
  if (runtime.modelsUrl || runtime.requestPath || runtime.piCatalogProviderId) return false;
  return loopbackOrigin(runtime.baseUrl) !== null;
}

/**
 * 旧本机预设只有 Pi。把未改过指纹的 LM Studio / llama.cpp / vLLM
 * 补上现在预设里的 harness，不改用户手改过的供应商。
 */
export function migrateLocalConnectProvider(
  existing: CustomProviderConfig,
): CustomProviderConfig | null {
  if ((existing.auth?.method ?? 'none') !== 'none') return null;
  const runtimeKeys = Object.keys(existing.runtimes);
  if (runtimeKeys.some((key) => key !== 'pi' && key !== 'claude-code' && key !== 'codex')) {
    return null;
  }
  const pi = existing.runtimes.pi;
  if (!isPlainChatRuntime(pi)) return null;

  const isLmStudio = existing.id === MANAGED_LMSTUDIO_PROVIDER_ID;
  const isKnownPreset =
    isLmStudio ||
    (LOCAL_ADVANCED_PRESET_IDS as readonly string[]).includes(existing.id) ||
    /^(llama-cpp|vllm)-\d+$/.test(existing.id);
  if (!isKnownPreset) return null;

  const models = copyModels(pi.models);
  const origin = loopbackOrigin(pi.baseUrl);
  if (!origin) return null;

  const runtimes = { ...existing.runtimes };
  let changed = false;

  if (isLmStudio && !runtimes['claude-code']) {
    runtimes['claude-code'] = {
      baseUrl: origin,
      wireProtocol: 'anthropic-messages',
      models: [...models],
    };
    changed = true;
  }

  if (!runtimes.codex) {
    runtimes.codex = {
      baseUrl: pi.baseUrl,
      wireProtocol: 'openai-chat',
      models: [...models],
    };
    changed = true;
  } else if (runtimes.codex.wireProtocol === 'openai-responses') {
    runtimes.codex = {
      ...runtimes.codex,
      wireProtocol: 'openai-chat',
    };
    changed = true;
  }

  return changed ? { ...existing, runtimes } : existing;
}
