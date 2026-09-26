import { app } from 'electron';

import {
  MANAGED_OLLAMA_PROVIDER_ID,
  matchesManagedOllamaFingerprint,
} from '../../shared/localModelRuntime.js';
import { getCustomProvider } from '../maker-host/custom-provider-store.js';
import { startOfficialOllamaApp } from './ollamaRuntime.js';
import { MANAGED_LLAMACPP_PROVIDER_ID } from '../../shared/llamaCpp.js';

function cindyUserDataDir(explicit?: string): string | undefined {
  if (explicit) return explicit;
  try {
    return app.getPath('userData');
  } catch {
    return undefined;
  }
}

export async function ensureManagedOllamaReadyForSession(opts: {
  providerId?: string | null;
  remoteHostId?: string | null;
  userDataDir?: string;
}): Promise<void> {
  if (opts.remoteHostId) return;
  if (opts.providerId === MANAGED_LLAMACPP_PROVIDER_ID) {
    const { isManagedLlamaCppProvider } = await import('./managedLlamaCppProvider.js');
    const config = await getCustomProvider(MANAGED_LLAMACPP_PROVIDER_ID);
    const root = cindyUserDataDir(opts.userDataDir);
    if (!root || !config || !isManagedLlamaCppProvider(config)) {
      throw new Error('[LOCAL_LLAMACPP_NOT_READY] Reconnect llama.cpp in Settings → Model Providers.');
    }
    const { getManagedLlamaCppService } = await import('./llamaCppService.js');
    await getManagedLlamaCppService(root).start();
    return;
  }
  if (opts.providerId !== MANAGED_OLLAMA_PROVIDER_ID) return;
  const existing = await getCustomProvider(MANAGED_OLLAMA_PROVIDER_ID);
  if (
    !existing ||
    !matchesManagedOllamaFingerprint({
      id: existing.id,
      authMethod: existing.auth?.method,
      runtimes: existing.runtimes,
    })
  ) {
    throw new Error(
      '[LOCAL_OLLAMA_NOT_READY] Managed Ollama provider is missing or was customized. Reconnect it in Settings → Model Providers.',
    );
  }
  const ready = await startOfficialOllamaApp({
    platform: process.platform,
    fetchImpl: (url, init) => fetch(url, init),
    userDataDir: cindyUserDataDir(opts.userDataDir),
  });
  if (ready.kind !== 'ready') {
    throw new Error(
      `[LOCAL_OLLAMA_NOT_READY] Local model service is not ready (${ready.kind}). Open Settings → Model Providers → Ollama.`,
    );
  }
}
