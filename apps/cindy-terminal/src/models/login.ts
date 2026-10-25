import { createGenericOAuthRuntime } from '@cindy/model-providers/provider-auth/generic-oauth';
import { buildUserProvider } from '@cindy/model-providers';
import type { GenericOAuthRuntimeHost } from '@cindy/model-providers/provider-auth/generic-oauth';
import type { TerminalDurableSecrets } from '../contracts.js';
import type { TerminalClaudeAuthorization } from './claude-terminal.js';
import type { TerminalSubscriptions } from './subscriptions.js';
import type { TerminalGrokLogin } from './grok-login.js';
import type { TerminalNativeAccounts } from './native-accounts.js';
import type { TerminalModelConfig, ModelOAuthConnection } from './config.js';

export type ProviderLoginState = {
  status: 'pending' | 'success' | 'expired' | 'cancelled' | 'error';
  verificationUrl?: string;
  userCode?: string;
  expiresAt?: number;
  callbackRequired?: boolean;
  terminal?: boolean;
};
type Login = {
  providerId: string;
  state: ProviderLoginState;
  current(): void;
  work?: Promise<void>;
  timer?: NodeJS.Timeout;
};

/** Authorizations live on the selected host; only the protected controller
 * receives the URL/code or submits the callback. Tokens stay in its owner vault. */
export class TerminalProviderLogin implements ModelOAuthConnection {
  private closed = false;
  private readonly abort = new AbortController();
  private readonly nativeLogins = new Map<string, TerminalNativeAccounts | TerminalGrokLogin | TerminalClaudeAuthorization>();
  private readonly logins = new Map<string, Login>();
  private readonly runtime: ReturnType<typeof createGenericOAuthRuntime>;
  constructor(
    private readonly options: {
      models: TerminalModelConfig;
      subscriptions?: TerminalSubscriptions;
      native?: TerminalNativeAccounts;
      grok?: TerminalGrokLogin;
      claude?: TerminalClaudeAuthorization;
      secrets: Pick<
        TerminalDurableSecrets,
        'getSync' | 'setSync' | 'deleteSync'
      >;
      assertCurrent(): void;
      changed(): void;
      log: GenericOAuthRuntimeHost['log'];
      fetch?: typeof fetch;
    },
  ) {
    const key = (id: string) => `terminal:provider-oauth:${id}`;
    this.runtime = createGenericOAuthRuntime({
      // The shared runner may include upstream error details. Keep terminal
      // logs structural so a provider cannot echo tokens into diagnostics.
      log: {
        info: () => {},
        warn: () => options.log.warn('PROVIDER_AUTH_REQUEST_FAILED'),
      },
      storage: {
        read: (id) => {
          this.current();
          return options.secrets.getSync(key(id));
        },
        readStrict: (id) => {
          this.current();
          return options.secrets.getSync(key(id));
        },
        write: (id, value) => {
          this.current();
          options.secrets.setSync(key(id), value);
          return true;
        },
        remove: (id) => {
          this.current();
          options.secrets.deleteSync(key(id));
          return true;
        },
      },
      fetchImpl: async (url, init) => {
        this.current();
        const response = await (options.fetch ?? fetch)(url, {
          ...init,
          redirect: 'error',
          signal: AbortSignal.any([
            this.abort.signal,
            ...(init?.signal ? [init.signal] : []),
          ]),
        });
        this.current();
        return response;
      },
    });
    options.models.connectOAuth(this);
  }
  private current() {
    if (this.closed) throw new Error('OWNER_CHANGED');
    this.options.assertCurrent();
  }
  private provider(id: string) {
    this.current();
    const provider = this.options.models
      .activeCatalog()
      .providers.find((p) => p.id === id);
    if (!provider?.auth.oauth) throw new Error('PROVIDER_OAUTH_UNAVAILABLE');
    return { ...provider, oauth: provider.auth.oauth };
  }
  connected(id: string) {
    this.provider(id);
    return this.runtime.hasGenericOAuthLogin(id);
  }
  async credential(id: string) {
    const provider = this.provider(id),
      descriptor = JSON.stringify(provider.oauth);
    await this.runtime.refreshGenericOAuthIfNeeded(id, provider.oauth);
    if (JSON.stringify(this.provider(id).oauth) !== descriptor)
      throw new Error('MODEL_CONFIGURATION_CHANGED');
    return this.runtime.readCachedGenericOAuthAccessToken(id, provider.oauth);
  }
  cachedCredential = (id: string) => {
    const provider = this.provider(id);
    return this.runtime.readCachedGenericOAuthAccessToken(id, provider.oauth);
  };
  disconnect(id: string) {
    this.removeReversibly(id);
    this.options.changed();
  }
  removeReversibly(id: string) {
    this.current();
    for (const [requestId, entry] of this.logins)
      if (entry.providerId === id) this.cancel(requestId);
    const account = this.options.subscriptions?.connection(id);
    if (account) return account.removeReversibly();
    const restore = this.runtime.removeGenericOAuthCredentialsReversibly(id);
    if (!restore) throw new Error('PROVIDER_DISCONNECT_FAILED');
    return () => {
      this.current();
      if (!restore()) throw new Error('PROVIDER_CREDENTIAL_RESTORE_FAILED');
    };
  }
  async refresh(id: string) {
    const provider = this.provider(id);
    await this.credential(id);
    for (const kind of provider.agents) {
      const base = provider.routing[kind]?.upstream;
      if (!base) continue;
      const models = await this.runtime.discoverGenericOAuthModels(
        id,
        provider.oauth,
        provider.oauth.modelsDiscoveryUrl ??
          this.runtime.deriveModelsDiscoveryUrl(base),
        kind,
      );
      this.current();
      if (models)
        this.options.models.catalogRuntime.setDiscoveredProviderModels(
          id,
          kind,
          buildUserProvider({
            id,
            name: provider.name,
            runtimes: { [kind]: { baseUrl: base, models } },
          }).models[kind] ?? [],
        );
    }
    this.options.changed();
  }
  begin(
    id: string,
    providerId: string,
    current: () => void,
    deadline: number,
  ): ProviderLoginState {
    current();
    const native = this.options.subscriptions?.connection(providerId) ?? (providerId === 'openai' ? this.options.native : providerId === 'xai' ? this.options.grok : providerId === 'anthropic' ? this.options.claude : undefined);
    if (native) { this.nativeLogins.set(id, native); return native.begin(id, current, deadline); }
    const provider = this.provider(providerId);
    const old = this.logins.get(id);
    if (old) return this.read(id);
    if (
      [...this.logins.values()].some(
        (entry) =>
          entry.providerId === providerId && entry.state.status === 'pending',
      )
    )
      throw new Error('PROVIDER_LOGIN_BUSY');
    const descriptor = JSON.stringify(provider.oauth);
    const expiresAt = provider.oauth.flow === 'device-code' ? deadline : Math.min(deadline, Date.now() + 5 * 60_000);
    const entry: Login = {
      providerId,
      state: { status: 'pending', expiresAt },
      current: () => {
        current();
        this.current();
        if (JSON.stringify(this.provider(providerId).oauth) !== descriptor)
          throw new Error('MODEL_CONFIGURATION_CHANGED');
      },
    };
    this.logins.set(id, entry);
    entry.timer = setTimeout(
      () => {
        this.cancel(id, 'expired');
      },
      Math.max(0, expiresAt - Date.now()),
    );
    entry.timer.unref();
    entry.work = this.runtime
      .runGenericOAuthLogin(provider, provider.oauth, {
        onBrowser: async (verificationUrl) => {
          entry.current();
          entry.state = {
            status: 'pending',
            verificationUrl,
            callbackRequired: true,
            expiresAt,
          };
        },
        onProgress: (progress) => {
          entry.current();
          clearTimeout(entry.timer);
          entry.timer = setTimeout(() => this.cancel(id, 'expired'), Math.max(0, Math.min(expiresAt, progress.expiresAt) - Date.now()));
          entry.timer.unref();
          entry.state = {
            status: 'pending',
            verificationUrl: progress.verificationUrl,
            userCode: progress.userCode,
            expiresAt: Math.min(expiresAt, progress.expiresAt),
          };
        },
        onCredentialPersisted: (rollback) => {
          try {
            entry.current();
          } catch (error) {
            rollback();
            throw error;
          }
        },
      })
      .then((result) => {
        if (entry.state.status !== 'pending') return;
        entry.current();
        entry.state = { status: result.ok ? 'success' : 'error' };
        if (result.ok) this.options.changed();
      })
      .catch(() => {
        if (entry.state.status === 'pending') entry.state = { status: 'error' };
      })
      .finally(() => {
        clearTimeout(entry.timer);
      });
    return { ...entry.state };
  }
  read(id: string): ProviderLoginState {
    this.current();
    if (this.nativeLogins.has(id)) return this.nativeLogins.get(id)!.state(id);
    const entry = this.logins.get(id);
    if (!entry) throw new Error('PROVIDER_LOGIN_STALE');
    entry.current();
    return { ...entry.state };
  }
  submit(id: string, value: unknown) {
    this.read(id);
    const native = this.nativeLogins.get(id);
    if (native && 'exchange' in native) return native.exchange(id, value);
    if (native) throw new Error('PROVIDER_LOGIN_STALE');
    const entry = this.logins.get(id)!;
    if (
      entry.state.status !== 'pending' ||
      !entry.state.callbackRequired ||
      typeof value !== 'string'
    )
      throw new Error('PROVIDER_LOGIN_STALE');
    this.runtime.submitGenericOAuthCallback(entry.providerId, value);
    return this.read(id);
  }
  cancel(id: string, status: 'cancelled' | 'expired' = 'cancelled') {
    if (this.nativeLogins.has(id)) { this.nativeLogins.get(id)!.cancel(id, status); return; }
    const entry = this.logins.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    if (entry.state.status === 'pending') {
      entry.state = { status };
      this.runtime.cancelGenericOAuthLogin(entry.providerId);
    }
    if (status !== 'expired') this.logins.delete(id);
  }
  cancelProvider(providerId: string) {
    const native = this.options.subscriptions?.connection(providerId) ?? (providerId === 'anthropic' ? this.options.claude : providerId === 'openai' ? this.options.native : providerId === 'xai' ? this.options.grok : undefined);
    for (const [id, connection] of this.nativeLogins) if (connection === native) this.cancel(id);
    for (const [id, login] of this.logins) if (login.providerId === providerId) this.cancel(id);
  }
  async close() {
    this.closed = true;
    this.abort.abort();
    const work = [...this.logins.values()].map((entry) => entry.work);
    for (const id of this.logins.keys()) this.cancel(id);
    this.runtime.close();
    await this.options.subscriptions?.close();
    await this.options.native?.close();
    await this.options.grok?.close();
    await this.options.claude?.close();
    await this.options.models.nativeClaude?.close();
    await Promise.allSettled(work);
  }
}
