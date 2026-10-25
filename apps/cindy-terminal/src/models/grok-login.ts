import path from "node:path";
import { createGrokOAuthRuntime } from "@cindy/model-providers/provider-auth/grok-oauth";
import { createXaiModelDiscovery } from "@cindy/model-providers/provider-auth/xai-model-discovery";
import { createXaiBridgeAuthInvalidator } from "@cindy/model-providers/provider-auth/xai-auth-invalidation";
import type { TerminalDurableSecrets } from "../contracts.js";
import type { TerminalModelConfig } from "./config.js";
import type { ProviderLoginState } from "./login.js";

const KEY = "terminal:native:xai";
const BINDING = `${KEY}:bound`;
type Login = {
  state: ProviderLoginState;
  abort: AbortController;
  current(): void;
  timer?: NodeJS.Timeout;
  work?: Promise<void>;
};

/** SuperGrok uses the same OAuth and account discovery as Desktop. Device codes
 * are returned only to the initiating protected controller; tokens stay here. */
export class TerminalGrokLogin {
  private closed = false;
  private readonly abort = new AbortController();
  private readonly logins = new Map<string, Login>();
  private readonly runtime: ReturnType<typeof createGrokOAuthRuntime>;
  private readonly discovery: ReturnType<typeof createXaiModelDiscovery>;
  readonly invalidate: ReturnType<typeof createXaiBridgeAuthInvalidator>;
  private loaded = false;
  usageRequestHeaders(accessToken: string) { this.current(); return this.discovery.buildXaiCliProxyHeaders(accessToken); }
  usageAccountUrl() { this.current(); return this.discovery.XAI_ACCOUNT_USER_URL; }
  constructor(
    private readonly options: {
      root: string;
      providerId?: string;
      models: TerminalModelConfig;
      secrets: Pick<
        TerminalDurableSecrets,
        "getSync" | "setSync" | "deleteSync"
      >;
      assertCurrent(): void;
      changed(): void;
      fetch?: typeof fetch;
    },
  ) {
    const log = { info() {}, warn() {} };
    const fetchImpl: typeof fetch = async (url, init) => {
      this.current();
      const response = await (options.fetch ?? fetch)(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.any([
          this.abort.signal,
          ...(init?.signal ? [init.signal] : []),
        ]),
      });
      this.current();
      return response;
    };
    const secret = {
      get: () => {
        this.current();
        return options.secrets.getSync(KEY);
      },
      set: (_id: string, value: string) => {
        this.current();
        options.secrets.setSync(KEY, value);
        return true;
      },
      remove: () => {
        this.current();
        options.secrets.deleteSync(KEY);
        return true;
      },
    };
    this.runtime = createGrokOAuthRuntime({
      log,
      outboundFetch: fetchImpl,
      shell: {
        openExternal: async () => {
          throw new Error("USE_DEVICE_AUTHORIZATION");
        },
      },
      activeOwnerScopeKey: () => options.root,
      isAppSessionBoundaryPending: () => {
        try {
          this.current();
          return false;
        } catch {
          return true;
        }
      },
      OwnerBoundaryPendingError: class extends Error {
        readonly code = "owner_boundary_pending";
        constructor() {
          super("OWNER_CHANGED");
        }
      },
      getProviderSecretStore: () => secret,
      genericOAuthSecretIo: {
        read: secret.get,
        write: secret.set,
        remove: secret.remove,
      },
      bindNativeProviderAuth: () => {
        this.current();
        options.secrets.setSync(BINDING, "1");
      },
      isNativeProviderAuthBound: () => {
        this.current();
        return options.secrets.getSync(BINDING) === "1";
      },
      unbindNativeProviderAuth: () => {
        this.current();
        options.secrets.deleteSync(BINDING);
      },
      retainInvalidatedProviderPresentation: async () => {
        options.changed();
      },
    });
    this.invalidate = createXaiBridgeAuthInvalidator({
      getCurrentAccessToken: async () => this.peek(),
      recover: async (_reason, token) => {
        const outcome = await this.runtime.recoverGrokAuthAfterRejection(token);
        this.current();
        if (outcome === "logged_out") options.changed();
        return outcome;
      },
    });
    this.discovery = createXaiModelDiscovery({
      fetchImpl,
      log,
      getAccessToken: async () => (await this.credential()).accessToken,
      peekAccessToken: () => this.peek(),
      hasLogin: () => this.connected(),
      getConnectionSource: () =>
        this.connected() ? "explicit-provider-oauth" : null,
      getScopeKey: () => this.generation(),
      cacheFilePath: () => path.join(options.root, "xai-models.json"),
      applySnapshot: (models) => {
        this.current();
        options.models.catalogRuntime.setXaiDiscoveredModels(models, options.providerId);
      },
      invalidateAuth: this.invalidate,
    });
    if (!options.providerId || options.providerId === 'xai') options.models.nativeGrok = this;
  }
  private current() {
    if (this.closed) throw new Error("OWNER_CHANGED");
    this.options.assertCurrent();
  }
  connected() {
    this.current();
    return this.runtime.hasGrokOAuthLogin();
  }
  peek() {
    this.current();
    return this.runtime.peekGrokAccessToken();
  }
  generation() {
    this.current();
    return this.runtime.getGrokOAuthCredentialGeneration();
  }
  async credential() {
    this.current();
    const generation = this.generation();
    const accessToken = await this.runtime.getGrokAccessToken();
    this.current();
    const canDispatch = () => {
      try {
        return this.generation() === generation && this.peek() === accessToken;
      } catch {
        return false;
      }
    };
    if (!canDispatch()) throw new Error("PROVIDER_AUTHORIZATION_CHANGED");
    return { accessToken, canDispatch };
  }
  async models(force = false) {
    this.current();
    if (!this.connected()) return;
    if (!force && this.loaded) return;
    if (!force && (await this.discovery.loadXaiModelsFromDiskCache())) {
      this.loaded = true;
      return;
    }
    this.loaded = await this.discovery.refreshXaiModelsFromHttp();
  }
  disconnect() {
    this.current();
    for (const id of this.logins.keys()) this.cancel(id);
    this.runtime.logoutGrok();
    this.discovery.clearXaiDiscoveredModels();
    this.loaded = false;
    this.options.changed();
  }
  removeReversibly() {
    this.current();
    const previous = new Map([KEY, BINDING].map(key => [key, this.options.secrets.getSync(key)]));
    this.disconnect();
    return () => {
      this.current();
      for (const [key, value] of previous) {
        if (value === null) this.options.secrets.deleteSync(key);
        else this.options.secrets.setSync(key, value);
      }
      this.runtime.resetGrokOAuthMemoryCache();
      this.discovery.clearXaiDiscoveredModels();
      this.loaded = false;
      this.options.changed();
    };
  }
  begin(id: string, current: () => void, deadline: number): ProviderLoginState {
    this.current();
    current();
    if (this.logins.has(id)) return this.state(id);
    if (
      [...this.logins.values()].some(
        (login) => login.state.status === "pending",
      )
    )
      throw new Error("PROVIDER_LOGIN_BUSY");
    const expiresAt = Math.min(deadline, Date.now() + 15 * 60_000);
    const login: Login = {
      state: { status: "pending", expiresAt },
      abort: new AbortController(),
      current: () => {
        this.current();
        current();
        if (login.abort.signal.aborted || login.state.status !== "pending")
          throw new Error("PROVIDER_LOGIN_STALE");
      },
    };
    this.logins.set(id, login);
    const expire = (time: number) => {
      clearTimeout(login.timer);
      login.timer = setTimeout(
        () => this.cancel(id, "expired"),
        Math.max(0, time - Date.now()),
      );
      login.timer.unref();
    };
    expire(expiresAt);
    login.work = this.runtime
      .runGrokOAuthLogin({
        method: "device",
        cancellationSignal: login.abort.signal,
        assertCurrent: login.current,
        isCurrent: () => {
          try {
            login.current();
            return true;
          } catch {
            return false;
          }
        },
        beforeCommit: async () => {
          login.current();
          await this.discovery.discardXaiModelsDiskCache();
          login.current();
        },
        onCommitted: () => {
          // The grant is committed before cancellation can label it cancelled.
          login.state = { status: "success" };
          this.loaded = false;
          this.discovery.clearXaiDiscoveredModels();
          this.options.changed();
        },
        onDeviceCode: (code) => {
          login.current();
          login.state = {
            status: "pending",
            ...code,
            expiresAt: Math.min(expiresAt, code.expiresAt),
          };
          expire(login.state.expiresAt!);
        },
      })
      .then((result) => {
        if (login.state.status !== "pending") return;
        login.current();
        login.state = { status: result.ok ? "success" : "error" };
        if (result.ok) {
          this.loaded = false;
          this.discovery.clearXaiDiscoveredModels();
          this.options.changed();
        }
      })
      .catch(() => {
        if (login.state.status === "pending") login.state = { status: "error" };
      })
      .finally(() => clearTimeout(login.timer));
    return { ...login.state };
  }
  state(id: string): ProviderLoginState {
    this.current();
    const login = this.logins.get(id);
    if (!login) throw new Error("PROVIDER_LOGIN_STALE");
    return { ...login.state };
  }
  cancel(id: string, status: "cancelled" | "expired" = "cancelled") {
    const login = this.logins.get(id);
    if (!login) return;
    clearTimeout(login.timer);
    if (login.state.status === "pending") {
      login.state = { status };
      login.abort.abort();
    }
  }
  async close() {
    this.closed = true;
    this.abort.abort();
    for (const id of this.logins.keys()) this.cancel(id);
    this.runtime.resetGrokOAuthMemoryCache();
    await Promise.allSettled(
      [...this.logins.values()].map((login) => login.work),
    );
    await this.discovery.waitForXaiDiscoveryIdleForTest();
  }
}
