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
import path from 'node:path';
import { MANAGED_OLLAMA_PROVIDER_ID } from '../../../desktop/src/shared/localModelRuntime.js';
import { MANAGED_LLAMACPP_PROVIDER_ID } from '../../../desktop/src/shared/llamaCpp.js';
import {
  createPiNativeProviderResolver,
  createPiSubscriptionConnectionReader,
  type PiNativeProviderPorts,
} from '../../../desktop/src/main/maker-host/piNativeProvidersCore.js';
import { getActiveCatalog } from '../../../desktop/src/main/maker-host/active-catalog.js';
import { isNativeProviderAuthBound } from '../../../desktop/src/main/maker-host/nativeProviderAuthBinding.js';
import { shouldSuppressLocalCodexAuth } from '../../../desktop/src/main/maker-host/codex-auth-invalidation.js';
import { hasCodexOAuthLoginUnbound } from './codex-system-login.js';
import { createLogger } from '../../../desktop/src/main/logger.js';

const log = createLogger('host-pi-native-providers');

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
  getCatalog: PiNativeProviderPorts['getCatalog'];
  /** Endpoint snapshot; the resolver checks readiness before using it for local proxy routes. */
  endpoint: () => string;
  claudeProxy: { isReady(): boolean; ready?(): Promise<void> } | null | undefined;
  providerConfig: {
    list: PiNativeProviderPorts['listCustomProvidersWithSecureHeaders'];
    readKey: PiNativeProviderPorts['readCustomProviderKey'];
    grok: { hasGrokOAuthLogin(providerId?: string): boolean };
    codexAccounts: {
      isOpenAiSubscriptionProviderId(providerId?: string | null): boolean;
      codexAccountState(providerId: string): { authenticated: boolean };
    };
  };
  /** The desktop's first step before a local Pi (release table row 25); no-op when absent. */
  ensureSharedGlobalSkills?: () => Promise<void>;
}) {
  const config = options.providerConfig;
  const resolver = createPiNativeProviderResolver({
    getCatalog: () => options.getCatalog(),
    getClaudeEndpoint: () => options.endpoint(),
    isAnthropicCompatProxyHandleReady: () => options.claudeProxy?.isReady() ?? false,
    ensureAnthropicCompatProxyReady: () => options.claudeProxy?.ready?.() ?? Promise.resolve(),
    resolvePiBinaryPath: () => options.piBinaryPath,
    isOpenAiSubscriptionProviderId: id => config.codexAccounts.isOpenAiSubscriptionProviderId(id),
    hasGrokOAuthLogin: id => config.grok.hasGrokOAuthLogin(id),
    listCustomProvidersWithSecureHeaders: () => config.list(),
    readCustomProviderKey: (...args) => config.readKey(...args),
    ensureSharedGlobalSkills: () => options.ensureSharedGlobalSkills?.() ?? Promise.resolve(),
    ensureManagedOllamaReadyForSession: input => hostManagedLocalModelNotReady(input),
    getUserDataDir: () => options.userDataDir,
  });
  /**
   * #12298: the Host's own credential state per subscription source (read-only). The
   * desktop reads the desktop's stores; the Host reads the profile's — same rules,
   * different facts. The state stays out of the provider list: that list is the
   * byte-for-byte contract between the desktop and the Host.
   */
  const subscriptionSourceConnected = createPiSubscriptionConnectionReader({
    // 架构规则 §5:端口转调,不在装配时把函数本身存下来。
    getActiveCatalog: () => getActiveCatalog(),
    hasGrokOAuthLogin: id => config.grok.hasGrokOAuthLogin(id),
    codexAccountState: id => config.codexAccounts.codexAccountState(id),
    hasCodexOAuthLoginReadOnly: () => hasHostCodexHomeLogin(path.join(options.userDataDir, 'codex-home')),
    onReadFailure: (providerId, error) => log.warn(
      'pi: subscription connection read failed; keeping the source listed',
      { providerId, message: error instanceof Error ? error.message : String(error) },
    ),
  });
  return { ...resolver, subscriptionSourceConnected };
}

/** The profile's own Codex (ChatGPT subscription) login, as the desktop's read-only check. */
function hasHostCodexHomeLogin(codexHome: string): boolean {
  if (!isNativeProviderAuthBound('openai')) return false;
  if (shouldSuppressLocalCodexAuth(codexHome, path.join(codexHome, 'auth.json'))) return false;
  return hasCodexOAuthLoginUnbound(codexHome);
}
