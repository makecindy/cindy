import {
  createCredentialsSync,
  isValidCredentialsPayload,
  type CredentialsPayload,
} from '@cindy/model-providers/model-access/credentialsSync';
import {
  buildModelsSyncRequest,
  ensureCredentialsReadyForModelsRefresh,
  modelsWithoutStalePaymentUpsell,
  parseModelsSyncPayload,
  withModelsSyncOverallDeadline,
} from '@cindy/model-providers/model-access/modelsSyncRefresh';
import type {
  ModelAccessAccountTier,
  ModelAccessStatus,
} from '@cindy/model-providers/modelAccess';
import type { TerminalSecrets } from '../contracts.js';
import type { TerminalModelConfig } from './config.js';
import { loadCatalogWithSource } from '@cindy/model-providers';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { atomicPrivateWrite, readPrivateFile } from '../platform.js';
import { createGatewayKeyRejectionReporter } from '@cindy/model-providers/model-access/gatewayKeyRejection';
import type { TerminalPricing } from './pricing.js';

export interface TerminalGatewayOptions {
  models: TerminalModelConfig;
  pricing: TerminalPricing;
  secrets: TerminalSecrets;
  endpoint(): string;
  fallbackEndpoint(): string;
  root: string;
  identity(): { userId: string; realm: 'cn' | 'global' } | null;
  token(): string | null;
  refreshToken(): Promise<unknown>;
  assertCurrent(): void;
  changed(status: ModelAccessStatus): void;
  fetch?: typeof fetch;
}

/** The same credential state machine and account catalog as Desktop, without a window. */
export class TerminalGateway {
  private credentialsValue: CredentialsPayload | null = null;
  private accountTier: ModelAccessAccountTier | null = null;
  private closed = false;
  private readonly abort = new AbortController();
  private flight: Promise<void> | null = null;
  private rejection: Promise<unknown> | null = null;
  private catalogFlight: Promise<void> | null = null;
  private readonly sync;
  private readonly rejectionReporter;
  readonly ready: Promise<void>;

  constructor(private readonly options: TerminalGatewayOptions) {
    options.pricing.bindGatewayEndpoint(options.endpoint, () => options.identity()?.userId ?? null);
    this.sync = createCredentialsSync({
      fetchCredentials: () =>
        this.request(
          '/api/model-access/credentials',
        ) as Promise<CredentialsPayload>,
      rotateCredentials: () =>
        this.request('/api/model-access/credentials/rotate', {
          method: 'POST',
        }) as Promise<CredentialsPayload>,
      readXdKey: () => this.credentials()?.apiKey ?? null,
      writeXdKey: async (apiKey) => {
        const current = this.credentials();
        return current
          ? this.commit({ apiKey, endpoint: current.endpoint })
          : false;
      },
      commitCredentials: (payload) => this.commit(payload),
      store: {
        getSource: () => (this.credentialsValue ? 'server' : null),
        getServerEndpoint: () => this.credentialsValue?.endpoint ?? null,
        // Atomic commitCredentials owns persistence; these methods remain the
        // synchronous metadata interface used by the shared state machine.
        setServerCredentials: () => {
          throw new Error('ATOMIC_GATEWAY_COMMIT_REQUIRED');
        },
        setManualSource: () => {
          throw new Error('GATEWAY_SERVER_CREDENTIALS_REQUIRED');
        },
        clear: () => {
          this.credentialsValue = null;
        },
      },
      onStatusChange: () => {
        if (!this.closed) options.changed(this.status());
      },
      sleep: (ms) =>
        new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            this.abort.signal.removeEventListener('abort', finish);
            resolve();
          };
          const timer = setTimeout(finish, ms);
          timer.unref();
          this.abort.signal.addEventListener('abort', finish, { once: true });
          if (this.closed) finish();
        }),
    });
    this.rejectionReporter = createGatewayKeyRejectionReporter({
      canUseCindyGateway: () => Boolean(this.credentials()),
      isSessionBoundaryPending: () => this.closed,
      getCredentialSource: () => (this.credentialsValue ? 'server' : null),
      readCurrentKey: () => this.credentials()?.apiKey ?? null,
      requestSync: () => {
        const work = this.sync.resyncAfterKeyRejection().finally(() => {
          if (this.rejection === work) this.rejection = null;
        });
        this.rejection = work;
        return work;
      },
    });
    options.models.connectGateway(
      () => this.credentials(),
      () => this.refresh(),
      (key) => this.rejected(key),
    );
    this.ready = this.open();
    // Startup and close await this promise; attach a handler immediately while
    // the host is still assembling the rest of its owner services.
    void this.ready.catch(() => {});
  }
  private current() {
    if (this.closed) throw new Error('OWNER_CHANGED');
    this.options.assertCurrent();
  }
  private async open() {
    // A fresh guest profile has no account key and may not have a vault yet.
    if (!this.options.identity()) return;
    const raw = await this.options.secrets.get('terminal:gateway');
    this.current();
    if (!raw) return;
    const value: unknown = JSON.parse(raw);
    if (!this.valid(value)) throw new Error('INVALID_GATEWAY_CREDENTIALS');
    this.credentialsValue = value;
  }
  private valid(value: unknown): value is CredentialsPayload {
    if (!isValidCredentialsPayload(value)) return false;
    const url = new URL(value.endpoint);
    return !url.username && !url.password && !url.search && !url.hash;
  }
  credentials(): CredentialsPayload | null {
    try {
      this.current();
      if (
        !this.options.identity() ||
        !this.options.token() ||
        ['unsupported', 'disabled'].includes(this.sync.getStatus().state)
      )
        return null;
      return this.credentialsValue ? { ...this.credentialsValue } : null;
    } catch {
      return null;
    }
  }
  status(): ModelAccessStatus {
    return { ...this.sync.getStatus(), accountTier: this.accountTier };
  }
  private async commit(payload: CredentialsPayload): Promise<boolean> {
    this.current();
    if (!this.valid(payload)) return false;
    try {
      await this.options.secrets.set(
        'terminal:gateway',
        JSON.stringify(payload),
      );
      this.current();
      this.credentialsValue = { ...payload };
      this.options.models.gatewayChanged();
      return true;
    } catch {
      return false;
    }
  }
  private async request(
    route: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    this.current();
    const endpoint = this.options.endpoint();
    for (let attempt = 0; attempt < 2; attempt++) {
      this.current();
      const token = this.options.token();
      if (!token)
        throw Object.assign(new Error('AUTH_REQUIRED'), {
          code: 'AUTH_REQUIRED',
          statusCode: 401,
        });
      const response = await (this.options.fetch ?? fetch)(
        new URL(route, endpoint),
        {
          ...init,
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.any([
            this.abort.signal,
            AbortSignal.timeout(20_000),
            ...(init.signal ? [init.signal] : []),
          ]),
          headers: { ...init.headers, authorization: `Bearer ${token}` },
        },
      );
      this.current();
      if (response.status === 401 && attempt === 0) {
        await response.body?.cancel();
        // Token rotation is allowed to complete; the owner guard prevents its
        // result from crossing into a later account.
        await this.options.refreshToken();
        this.current();
        continue;
      }
      if (!response.ok) {
        let code = 'MODEL_ACCESS_REQUEST_FAILED';
        if (response.status === 501) {
          const error: unknown = await response.json().catch(() => null);
          if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'MODEL_ACCESS_QUOTA_NOT_SUPPORTED') code = 'MODEL_ACCESS_QUOTA_NOT_SUPPORTED';
        } else await response.body?.cancel();
        throw Object.assign(new Error('MODEL_ACCESS_REQUEST_FAILED'), {
          code,
          statusCode: response.status,
        });
      }
      const result: unknown = await response.json();
      this.current();
      return result;
    }
    throw new Error('AUTH_REQUIRED');
  }
  async start() {
    await this.ready;
    this.current();
    await this.options.pricing.prewarmModelPricing();
    this.current();
    this.catalogFlight = this.loadCatalog();
    await this.catalogFlight;
    this.current();
    const identity = this.options.identity();
    if (!identity) return;
    this.sync.handleAuthChange({ isAuthenticated: true, ...identity });
    await this.refresh();
  }
  private async loadCatalog() {
    const cache = (scope: string) =>
      path.join(
        this.options.root,
        'catalog-cache',
        createHash('sha256').update(scope).digest('hex') + '.json',
      );
    const loaded = await loadCatalogWithSource(
      {
        baseUrl: this.options.endpoint(),
        fallbackBaseUrl: this.options.fallbackEndpoint(),
        url: process.env.XDT_MODELS_URL,
        localPath: process.env.XDT_MODELS_PATH,
        disableFetch: process.env.XDT_DISABLE_MODELS_FETCH === '1',
      },
      {
        fetchText: async (url, timeoutMs) => {
          this.current();
          const response = await (this.options.fetch ?? fetch)(url, {
            redirect: 'error',
            signal: AbortSignal.any([
              this.abort.signal,
              AbortSignal.timeout(Math.max(1, timeoutMs)),
            ]),
          });
          this.current();
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error('CATALOG_REQUEST_FAILED');
          }
          const text = await response.text();
          this.current();
          return text;
        },
        readFile: async (file) =>
          (await readPrivateFile(file))?.toString() ?? null,
        readCache: async (scope) =>
          (await readPrivateFile(cache(scope)))?.toString() ?? null,
        writeCache: async (scope, text) => {
          this.current();
          await atomicPrivateWrite(cache(scope), text);
          this.current();
        },
      },
    );
    this.current();
    this.options.models.catalogRuntime.commitActiveCatalogSnapshot(
      loaded.catalog,
      loaded,
    );
    this.options.changed(this.status());
  }
  refresh(): Promise<void> {
    if (this.flight) return this.flight;
    const work = this.refreshModels().finally(() => {
      if (this.flight === work) this.flight = null;
    });
    this.flight = work;
    this.options.pricing.trackGatewayModelPricingSync(work);
    return work;
  }
  private async refreshModels() {
    await this.ready;
    this.current();
    if (!this.options.identity()) throw new Error('AUTH_REQUIRED');
    const state = await ensureCredentialsReadyForModelsRefresh(this.sync);
    this.current();
    if (state.state !== 'ok') {
      this.accountTier = null;
      if (state.state === 'disabled' || state.state === 'unsupported') {
        this.options.models.catalogRuntime.setXdGatewayModels([]);
        this.options.pricing.clearGatewayModelPricing();
      }
      else this.options.models.catalogRuntime.markXdGatewayModelAccessUnknown();
      this.options.changed(this.status());
      return;
    }
    try {
      const request = buildModelsSyncRequest(this.options.endpoint());
      const payload = await withModelsSyncOverallDeadline(
        this.request(request.path, { headers: request.options.headers }),
      );
      this.current();
      const parsed = parseModelsSyncPayload(payload);
      if (!parsed.ok) throw new Error('INVALID_MODEL_ACCESS_CATALOG');
      this.options.models.catalogRuntime.setXdGatewayModels(parsed.models, {
        authoritative: true,
      });
      this.options.pricing.replaceGatewayModelPricing(parsed.models, this.options.identity()?.userId);
      this.accountTier = parsed.accountTier;
    } catch (error) {
      this.current();
      const catalog = this.options.models.catalogRuntime;
      catalog.setXdGatewayModels(
        modelsWithoutStalePaymentUpsell(catalog.getXdGatewayModels()),
        { authoritative: false, preservePaymentRequiredRoutes: true },
      );
      this.accountTier = null;
      throw error;
    } finally {
      if (!this.closed) this.options.changed(this.status());
    }
  }
  async rotate() {
    await this.ready;
    this.current();
    const status = await this.sync.rotate();
    this.current();
    return status;
  }
  readAccountQuota() {
    return this.request('/api/model-access/quota', { signal: AbortSignal.timeout(8_000) });
  }
  rejected(key: string | null | undefined) {
    this.rejectionReporter.reportUsedKey(key);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    this.sync.handleAuthChange({ isAuthenticated: false });
    await Promise.allSettled([
      this.ready,
      this.flight,
      this.rejection,
      this.catalogFlight,
    ]);
    this.credentialsValue = null;
  }
}
