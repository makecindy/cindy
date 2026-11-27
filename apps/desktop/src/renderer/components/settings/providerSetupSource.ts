import { createContext, useContext, type ReactNode } from 'react';
import type { AgentKind, ProviderView } from '@cindy/model-providers';

import {
  createCustomProvider,
  deleteCustomProvider,
  readCustomProviderKey,
  updateCustomProvider,
} from '@/lib/customProviders';

type Maker = Window['electronAPI']['maker'];

/**
 * Where the add-provider wizard and the connection form read and write. Absent on the local
 * page (this computer); the cloud instance settings page provides the instance, where
 * secrets and logins travel on its management tickets.
 */
export interface ProviderSetupSource {
  /** Ollama and the managed llama.cpp runtime can be added (this computer only). */
  localRuntimes: boolean;
  listProviderPresets: Maker['listProviderPresets'];
  scanLocalCli: Maker['scanLocalCli'];
  /** One provider's full settings view (routing included), after a connection changed. */
  readProvider(providerId: string): Promise<ProviderView | undefined>;
  fetchProviderModels: Maker['fetchProviderModels'];
  /** Optional, as on an older preload: endpoint detection is a convenience. */
  detectProvider?: Maker['detectProvider'];
  testProviderConnection: Maker['testProviderConnection'];
  builtinApiKeyStore(providerId: string, apiKey: string): Promise<unknown>;
  createCustomProvider: typeof createCustomProvider;
  updateCustomProvider: typeof updateCustomProvider;
  deleteCustomProvider(providerId: string): Promise<unknown>;
  /** Throws when saved keys cannot be shown here (they stay where they are stored). */
  readCustomProviderKey(providerId: string, agent: AgentKind): Promise<string | null>;
  providerOAuthLogin: Maker['providerOAuthLogin'];
  providerOAuthCancel: Maker['providerOAuthCancel'];
  /** The device's own Claude Code / Codex sign-in ("use this computer's account"). */
  localAccountLogin?(kind: 'claude' | 'codex'): Promise<{ ok: boolean; reason?: string }>;
  cancelLocalAccountLogin?(): void;
  /** The pending sign-in's device code, browser link or callback form. */
  loginPrompt?: ReactNode;
}

/** This computer, through the same functions the components called before. */
export const localProviderSetup: Omit<ProviderSetupSource, 'localAccountLogin'> = {
  localRuntimes: true,
  listProviderPresets: () => window.electronAPI.maker.listProviderPresets(),
  scanLocalCli: () => window.electronAPI.maker.scanLocalCli(),
  readProvider: async (providerId) =>
    (await window.electronAPI.maker.listProviders()).providers.find((p) => p.id === providerId),
  fetchProviderModels: (input) => window.electronAPI.maker.fetchProviderModels(input),
  get detectProvider() {
    const detect = window.electronAPI.maker.detectProvider;
    return detect
      ? (input: Parameters<NonNullable<Maker['detectProvider']>>[0]) => detect(input)
      : undefined;
  },
  testProviderConnection: (input) => window.electronAPI.maker.testProviderConnection(input),
  builtinApiKeyStore: (providerId, apiKey) =>
    window.electronAPI.builtinApiKeyStore(providerId, apiKey),
  // Resolved at call time, like the components' own imports.
  createCustomProvider: (...args) => createCustomProvider(...args),
  updateCustomProvider: (...args) => updateCustomProvider(...args),
  deleteCustomProvider: (providerId) => deleteCustomProvider(providerId),
  readCustomProviderKey: (...args) => readCustomProviderKey(...args),
  providerOAuthLogin: (providerId, options) =>
    window.electronAPI.maker.providerOAuthLogin(providerId, options),
  providerOAuthCancel: (providerId, options) =>
    window.electronAPI.maker.providerOAuthCancel(providerId, options),
};

export const ProviderSetupSourceContext = createContext<ProviderSetupSource | null>(null);

export function useProviderSetupSource(): ProviderSetupSource | null {
  return useContext(ProviderSetupSourceContext);
}
