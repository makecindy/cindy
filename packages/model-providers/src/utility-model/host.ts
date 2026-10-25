import type { AgentKind, Catalog, OAuthProviderDescriptor } from '../types.js';
import type { ModelDisableOverrides } from '../disableOverrides.js';
import type { UtilityModelProfile } from '../utilityModelProfiles.js';

/** Native one-shot calls are optional candidates, not a dependency on Maker or Electron. */
export interface UtilityNativeAgents {
  listAvailableAgents(): AgentKind[];
  getAgentAuthState(
    kind: AgentKind,
  ): Promise<{ authenticated: boolean; errorReason?: string }>;
  oneShot(
    kind: AgentKind,
    prompt: string,
    options?: {
      model?: string;
      maxTokens?: number;
      timeoutMs?: number;
      signal?: AbortSignal;
      systemPrompt?: string;
      responseInstructions?: string;
      beforeDispatch?: () => Promise<boolean>;
    },
  ): Promise<string>;
}

/** All mutable authority is read from the current owner at dispatch time. */
export interface UtilityRuntimeHost {
  log: {
    debug(message: string, data?: unknown): void;
    info(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
  };
  getAppCapabilities(): { canUseCindyGateway: boolean };
  activeOwnerScopeKey(): string;
  isAppSessionBoundaryPending(): boolean;
  readClaudeApiKey(): string | null;
  getChatgptBridgeAuth?(
    providerId?: string,
  ): Promise<{ accessToken: string; accountId: string | null }>;
  getChatgptBridgeAuthForDispatch?(
    providerId?: string,
  ): Promise<{
    accessToken: string;
    accountId: string | null;
    canDispatch(): boolean;
  }>;
  getGrokAccessToken?(providerId?: string): Promise<string>;
  getGrokOAuthCredentialGeneration?(providerId?: string): number;
  readCachedGenericOAuthAccessToken?(
    providerId: string,
    descriptor: OAuthProviderDescriptor | undefined,
  ): string | null;
  undiciFetch(
    url: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      signal?: AbortSignal;
    },
  ): Promise<Pick<Response, 'ok' | 'status' | 'text' | 'json'> & {
    body: {
      cancel(): Promise<void>;
      getReader(): Pick<ReadableStreamDefaultReader<Uint8Array>, 'read' | 'cancel' | 'releaseLock'>;
    } | null;
  }>;
  claudeUpstreamEndpoint(): string;
  getActiveCatalog(): Catalog;
  isXdGatewayPaymentRequiredRoute(model: string, agent: AgentKind): boolean;
  readModelDisableOverrides(): ModelDisableOverrides;
  getProviderRouteCredentialRevision(providerId: string): number;
  isProviderRouteMutationInProgress(providerId: string): boolean;
  withOpenCodeGoSessionHeader(
    headers: Record<string, string> | undefined,
    route: { providerId: string; catalogPresetId?: string; upstream: string },
  ): Record<string, string> | undefined;
  effectiveXdGatewayBaseUrl(): string;
  reportCindyGatewayKeyRejected(key: string | null | undefined): void;
  readCustomProviderKey(providerId: string, agent: string): string | null;
  MANAGED_OLLAMA_PROVIDER_ID: string;
  isManagedSidecarProviderId(providerId: string): boolean;
  ensureManagedOllamaReadyForSession?(input: {
    providerId: string;
  }): Promise<unknown>;
  getUtilityModelChainProfiles(): UtilityModelProfile[];
  getEffectiveAuxiliaryModelChain(): {
    source: 'auto' | 'custom' | 'env';
    refs: string[];
  };
}
