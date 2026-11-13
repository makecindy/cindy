/**
 * The Host's ports for the Pi native providers it shares with the desktop
 * (desktop maker-host/piNativeProvidersCore.ts; the desktop binds it in pi-host.ts).
 *
 * Two ports differ from the desktop by design:
 * - The global Skill projection belongs to row 25 of the migration release table; until then the
 *   Host does nothing before a local Pi startup.
 * - The Host has no managed local model runtime (Ollama, llama.cpp). It answers as the desktop's
 *   preflight answers when that runtime is not ready: the same error codes and wording.
 */
import { MANAGED_OLLAMA_PROVIDER_ID } from '../../../desktop/src/shared/localModelRuntime.js';
import { MANAGED_LLAMACPP_PROVIDER_ID } from '../../../desktop/src/shared/llamaCpp.js';
import {
  createPiNativeProviderResolver,
  type PiNativeProviderPorts,
} from '../../../desktop/src/main/maker-host/piNativeProvidersCore.js';

/** The desktop preflight's not-ready errors (local-model-runtime/preflight.ts). */
export async function hostManagedLocalModelNotReady(input: { providerId: string; remoteHostId: string | null }): Promise<void> {
  if (input.remoteHostId) return;
  if (input.providerId === MANAGED_LLAMACPP_PROVIDER_ID) {
    throw new Error('[LOCAL_LLAMACPP_NOT_READY] Reconnect llama.cpp in Settings → Model Providers.');
  }
  if (input.providerId !== MANAGED_OLLAMA_PROVIDER_ID) return;
  throw new Error(
    '[LOCAL_OLLAMA_NOT_READY] Local model service is not ready (absent). Open Settings → Model Providers → Ollama.',
  );
}

export function createHostPiNativeProviders(options: {
  userDataDir: string;
  piBinaryPath: string | null;
  /** The engine endpoint Pi's runtime config uses: the loopback proxy once ready, else the upstream. */
  endpoint: () => string;
  claudeProxy: { isReady(): boolean } | null | undefined;
  providerConfig: {
    list: PiNativeProviderPorts['listCustomProvidersWithSecureHeaders'];
    readKey: PiNativeProviderPorts['readCustomProviderKey'];
    grok: { hasGrokOAuthLogin(providerId?: string): boolean };
    codexAccounts: { isOpenAiSubscriptionProviderId(providerId?: string | null): boolean };
  };
}) {
  const config = options.providerConfig;
  return createPiNativeProviderResolver({
    getClaudeEndpoint: () => options.endpoint(),
    isAnthropicCompatProxyHandleReady: () => options.claudeProxy?.isReady() ?? false,
    resolvePiBinaryPath: () => options.piBinaryPath,
    isOpenAiSubscriptionProviderId: id => config.codexAccounts.isOpenAiSubscriptionProviderId(id),
    hasGrokOAuthLogin: id => config.grok.hasGrokOAuthLogin(id),
    listCustomProvidersWithSecureHeaders: () => config.list(),
    readCustomProviderKey: (...args) => config.readKey(...args),
    ensureSharedGlobalSkills: async () => {},
    ensureManagedOllamaReadyForSession: input => hostManagedLocalModelNotReady(input),
    getUserDataDir: () => options.userDataDir,
  });
}
