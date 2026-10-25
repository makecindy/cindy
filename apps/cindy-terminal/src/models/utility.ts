import path from 'node:path';
import { rm } from 'node:fs/promises';
import {
  isOpenAiSubscriptionProvider,
  type AgentKind,
} from '@cindy/model-providers';
import { createUtilityTextRuntime } from '@cindy/model-providers/utility-model/runtime';
import type {
  UtilityNativeAgents,
  UtilityRuntimeHost,
} from '@cindy/model-providers/utility-model/host';
import { createAuxiliaryModelOptions } from '@cindy/model-providers/utility-model/auxiliaryModelOptions';
import { buildTextOneshotPinOptions } from '@cindy/model-providers/utility-model/textOneshotPinOptions';
import { resolveEffectiveAuxiliaryModelChain } from '@cindy/model-providers/utility-model/resolveAuxiliaryModelChain';
import { withOpenCodeGoSessionHeader } from '@cindy/model-providers/utility-model/opencode-go-session';
import {
  isValidAuxiliaryModelListInput,
  normalizeAuxiliaryModelList,
  type AuxiliaryModelSettingsState,
} from '@cindy/model-providers/auxiliaryModelSettings';
import {
  DEFAULT_UTILITY_MODEL_PROVIDER_CHAIN,
  getUtilityModelProfile,
  isUtilityModelProviderKind,
} from '@cindy/model-providers/utilityModelProfiles';
import {
  MANAGED_OLLAMA_PROVIDER_ID,
  isManagedSidecarProviderId,
} from '@cindy/model-providers/localModelRuntime';
import type { UtilityTextRequestOptions } from '@cindy/model-providers/utilityTextRequest';
import type { UtilityTextResult } from '@cindy/model-providers/utilityTextResult';
import type { AutoReviewRequest } from '@cindy/maker-core';
import { createAutoPermissionReviewer } from '@cindy/maker-core/auto-permission-reviewer';
import { createAutoReviewModelRouter, AUTO_REVIEW_ROUTER_GUARD_TIMEOUT_MS } from '@cindy/maker-core/auto-review-model-router';
import { atomicPrivateWrite, readPrivateFile } from '../platform.js';
import type { TerminalModelConfig } from './config.js';

export type UtilityConnections = Pick<
  UtilityRuntimeHost,
  | 'getChatgptBridgeAuth'
  | 'getChatgptBridgeAuthForDispatch'
  | 'getGrokAccessToken'
  | 'getGrokOAuthCredentialGeneration'
  | 'readCachedGenericOAuthAccessToken'
  | 'ensureManagedOllamaReadyForSession'
>;

/** Per-owner settings and the same auxiliary dispatch state machine as Desktop. */
export class TerminalUtilityModels {
  readonly ready: Promise<void>;
  private models: string[] = [];
  private revision = 0;
  private closed = false;
  private readonly abort = new AbortController();
  private pending: Promise<unknown> = Promise.resolve();
  private readonly work = new Set<Promise<unknown>>();
  private connections: UtilityConnections = {};
  private readonly file: string;
  constructor(
    private readonly options: {
      root: string;
      models: TerminalModelConfig;
      native: UtilityNativeAgents;
      log: UtilityRuntimeHost['log'];
      assertCurrent(): void;
      changed(): void;
      fetch?: typeof fetch;
    },
  ) {
    this.file = path.join(options.root, 'auxiliary-model-settings.json');
    this.ready = this.open();
  }
  private current() {
    if (this.closed) throw new Error('OWNER_CHANGED');
    this.options.assertCurrent();
  }
  private async open() {
    const raw = await readPrivateFile(this.file);
    this.current();
    if (!raw) return;
    const value: unknown = JSON.parse(raw.toString());
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('INVALID_AUXILIARY_SETTINGS');
    this.models = normalizeAuxiliaryModelList(
      (value as { models?: unknown }).models,
    );
  }
  configureConnections(connections: UtilityConnections) {
    this.current();
    this.connections = connections;
    this.revision++;
  }
  effective() {
    this.current();
    return resolveEffectiveAuxiliaryModelChain(this.models);
  }
  nativeAgents() { this.current(); return this.options.native; }
  effectiveSnapshot() { return JSON.stringify(this.effective()); }
  private async runtime() {
    await this.ready;
    await this.pending;
    this.current();
    const models = this.options.models;
    const snapshot = await models.utilityCredentials();
    this.current();
    const gateway = () => {
      this.current();
      return models.gatewayCredentials();
    };
    const runtime = createUtilityTextRuntime({
      ...this.connections,
      log: this.options.log,
      getAppCapabilities: () => ({ canUseCindyGateway: Boolean(gateway()) }),
      activeOwnerScopeKey: () => {
        this.current();
        return this.options.root;
      },
      isAppSessionBoundaryPending: () => {
        try {
          this.current();
          return false;
        } catch {
          return true;
        }
      },
      readClaudeApiKey: () => gateway()?.apiKey ?? null,
      undiciFetch: (url, init) =>
        (this.options.fetch ?? fetch)(url, { ...init, redirect: 'error' }),
      claudeUpstreamEndpoint: () => gateway()?.endpoint ?? '',
      getActiveCatalog: () =>
        snapshot.revision === models.revision()
          ? snapshot.catalog
          : models.activeCatalog(),
      isXdGatewayPaymentRequiredRoute: (model, agent) =>
        models.catalogRuntime.isXdGatewayPaymentRequiredRoute(model, agent),
      readModelDisableOverrides: () => models.snapshot().disabled ?? {},
      getProviderRouteCredentialRevision: () => models.revision(),
      isProviderRouteMutationInProgress: () => models.isMutating(),
      withOpenCodeGoSessionHeader,
      effectiveXdGatewayBaseUrl: () => gateway()?.endpoint ?? '',
      reportCindyGatewayKeyRejected: (key) =>
        models.reportGatewayRejection(key),
      readCustomProviderKey: (provider, agent) =>
        snapshot.readKey(provider, agent),
      MANAGED_OLLAMA_PROVIDER_ID,
      isManagedSidecarProviderId,
      getUtilityModelChainProfiles: () =>
        DEFAULT_UTILITY_MODEL_PROVIDER_CHAIN.map((id) =>
          getUtilityModelProfile(id),
        ),
      getEffectiveAuxiliaryModelChain: () => this.effective(),
    });
    return { runtime, snapshot };
  }
  async state(): Promise<
    AuxiliaryModelSettingsState & {
      effective: ReturnType<TerminalUtilityModels['effective']>;
    }
  > {
    const { runtime, snapshot } = await this.runtime();
    const options = createAuxiliaryModelOptions(runtime)({
      settings: { models: this.models },
      catalog: this.options.models.activeCatalog(),
      overrides: this.options.models.snapshot().disabled,
      hasCredential: (provider, agent) => {
        if (provider.id === 'xd')
          return Boolean(this.options.models.gatewayCredentials());
        if (isOpenAiSubscriptionProvider(provider))
          return Boolean(this.options.models.openAiAccount(provider.id)?.connected());
        if (provider.id === 'xai' || provider.auth.native === 'xai')
          return Boolean(this.options.models.grokAccount(provider.id)?.connected());
        if (provider.auth.method === 'oauth')
          return Boolean(
            this.connections.readCachedGenericOAuthAccessToken?.(
              provider.id,
              provider.auth.oauth,
            ),
          );
        return (
          provider.auth.method === 'none' ||
          Boolean(snapshot.readKey(provider.id, agent))
        );
      },
    });
    this.current();
    return {
      models: [...this.models],
      defaults: { models: [] },
      isCustomized: this.models.length > 0,
      customizedKeys: this.models.length ? ['models'] : [],
      options,
      effective: this.effective(),
    };
  }
  update(input: unknown, guard: () => void = () => {}) {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => key !== 'models') ||
      !isValidAuxiliaryModelListInput((input as { models?: unknown }).models)
    )
      throw new Error('INVALID_AUXILIARY_SETTINGS');
    const models = [...(input as { models: string[] }).models];
    const work = this.pending.then(async () => {
      await this.ready;
      this.current();
      guard();
      const allowed = new Set(
        buildTextOneshotPinOptions(
          this.options.models.activeCatalog(),
          this.options.models.snapshot().disabled,
        ).map((item) => item.id),
      );
      if (
        models.some(
          (ref) =>
            !isUtilityModelProviderKind(ref) &&
            !allowed.has(ref) &&
            !this.models.includes(ref),
        )
      )
        throw new Error('AUXILIARY_MODEL_UNAVAILABLE');
      if (models.length)
        await atomicPrivateWrite(this.file, JSON.stringify({ models }));
      else await rm(this.file, { force: true });
      this.current();
      guard();
      this.models = models;
      this.revision++;
      this.options.changed();
    });
    this.pending = work.catch(() => {});
    return work.then(() => this.state());
  }
  request(
    prompt: string,
    opts: UtilityTextRequestOptions = {},
  ): Promise<UtilityTextResult> {
    const operation = (async (): Promise<UtilityTextResult> => {
      const { runtime, snapshot } = await this.runtime();
      const revision = this.revision;
      const current = () => {
        this.current();
        return (
          revision === this.revision &&
          snapshot.revision === this.options.models.revision() &&
          !this.options.models.isMutating()
        );
      };
      return runtime.requestUtilityText(this.options.native, prompt, {
        ...opts,
        signal: AbortSignal.any([
          this.abort.signal,
          ...(opts.signal ? [opts.signal] : []),
        ]),
        beforeDispatch: async (route) =>
          current() &&
          (!opts.beforeDispatch || (await opts.beforeDispatch(route))) &&
          current(),
      });
    })();
    this.work.add(operation);
    void operation.finally(() => this.work.delete(operation)).catch(() => {});
    return operation;
  }
  /** Same dedicated/fallback policy as Desktop, captured under this account.
   * No native Claude credential is read or reused for auxiliary dispatch. */
  reviewPermission(request: AutoReviewRequest, guard: () => void = () => {}, parentSignal?: AbortSignal) {
    const operation = (async () => {
      const { runtime, snapshot } = await this.runtime();
      const revision = this.revision, cancel = new AbortController();
      const signal = AbortSignal.any([this.abort.signal, cancel.signal, ...(parentSignal ? [parentSignal] : [])]);
      const current = () => {
        try {
          this.current(); guard();
          if (revision !== this.revision || snapshot.revision !== this.options.models.revision() || this.options.models.isMutating()) throw new Error('MODEL_CONFIGURATION_CHANGED');
          if (signal.aborted) throw new Error('AUTO_REVIEW_CANCELLED');
        } catch (error) { cancel.abort(); throw error; }
      };
      current();
      const fallback = runtime.createCustomAutoReviewFallback();
      const route = createAutoReviewModelRouter({
        logger: this.options.log,
        requestCandidate: async (prompt, candidate, opts) => {
          current();
          const result = await runtime.requestDedicatedAutoReviewCandidateText(prompt, candidate, { ...opts, signal: AbortSignal.any([signal, ...(opts.signal ? [opts.signal] : [])]) });
          current(); return result;
        },
        createAuxiliaryFallback: () => fallback ? async (prompt, opts) => {
          current();
          const result = await fallback(prompt, { ...opts, signal: AbortSignal.any([signal, ...(opts.signal ? [opts.signal] : [])]) });
          current(); return result;
        } : undefined,
      });
      const reviewer = createAutoPermissionReviewer({
        logger: this.options.log, managesRetries: true,
        resolveRequestTimeoutMs: () => AUTO_REVIEW_ROUTER_GUARD_TIMEOUT_MS,
        requestText: (_request, prompt, context) => route(prompt, AbortSignal.any([signal, context.signal])),
      });
      const result = await reviewer(request);
      current(); return result;
    })();
    this.work.add(operation);
    void operation.finally(() => this.work.delete(operation)).catch(() => {});
    return operation;
  }
  async close() {
    this.closed = true;
    this.abort.abort();
    await Promise.allSettled([this.ready, this.pending, ...this.work]);
  }
}
