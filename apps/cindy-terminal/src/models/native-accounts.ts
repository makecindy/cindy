import {createChatgptBridgeAuthInvalidator} from '@cindy/model-providers/provider-auth/chatgpt-bridge-auth-invalidation';
import path from "node:path";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  createCodexCredentialRefresh,
  type CodexAuthFile,
} from "@cindy/model-providers/provider-auth/codex-credentials";
import { codexWorkspaceIdFromTokens, readChatgptIdTokenClaims } from "@cindy/model-providers/provider-auth/codex-auth-identity";
import { CodexAgent, type Logger } from '@cindy/maker-core';
import { buildChatgptBridgeHeaders } from "@cindy/model-providers/provider-auth/chatgpt-bridge-headers";
import { mapCodexModelsToCatalog } from "@cindy/model-providers/provider-auth/codex-model-discovery";
import type { CatalogModel } from "@cindy/model-providers";
import { bundledEngineRelease } from "../engines/releases.js";
import type { TerminalDurableSecrets } from "../contracts.js";
import {
  atomicPrivateWrite,
  privateDirectory,
  readPrivateFile,
} from "../platform.js";
import { runNative } from "../engines/native.js";
import type { ProviderLoginState } from "./login.js";

type Login = {
  state: ProviderLoginState;
  controller: AbortController;
  current(): void;
  work?: Promise<void>;
};
const KEY = "terminal:native:openai";

/** Only the official CLI performs OpenAI sign-in. Its temporary credential file
 * is imported into this owner's encrypted vault; task processes get a proxy
 * capability, never this file or the user's system Codex home. */
export class TerminalNativeAccounts {
  readonly ready: Promise<void>;
  readonly invalidateFailure: ReturnType<typeof createChatgptBridgeAuthInvalidator>;
  private closed = false;
  private readonly abort = new AbortController();
  private readonly logins = new Map<string, Login>();
  private readonly refresh: ReturnType<typeof createCodexCredentialRefresh>;
  private discovered?: CatalogModel[];
  private discovery?: Promise<CatalogModel[]>;
  private generation = 0;
  private cacheRead = false;
  private readonly controls = new Set<CodexAgent>();
  constructor(
    private readonly options: {
      root: string;
      secrets: Pick<
        TerminalDurableSecrets,
        "getSync" | "setSync" | "deleteSync"
      >;
      binary(): Promise<string | null>;
      version?(): Promise<string | null>;
      assertCurrent(): void;
      changed(): void;
      fetch?: typeof fetch;
      run?: typeof runNative;
    },
  ) {
    this.invalidateFailure = createChatgptBridgeAuthInvalidator({getCurrentAccessToken:async()=>this.read()?.tokens?.access_token??null,invalidate:async()=>this.disconnect()});
    this.ready = this.recover();
    void this.ready.catch(() => {});
    this.refresh = createCodexCredentialRefresh({
      read: async () => this.read(),
      write: async (_key, value) => {
        this.current();
        options.secrets.setSync(KEY, JSON.stringify(value));
      },
      fetch: async (url, init) => {
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
      },
      log: { info() {}, warn() {} },
    });
  }
  private async recover() {
    const parent = path.join(this.options.root, "provider-login");
    await privateDirectory(parent);
    this.current();
    for (const name of await readdir(parent))
      if (/^openai-[A-Za-z0-9_-]+$/.test(name))
        await rm(path.join(parent, name), { recursive: true, force: true });
    this.current();
  }
  private current() {
    if (this.closed) throw new Error("OWNER_CHANGED");
    this.options.assertCurrent();
  }
  private read(): CodexAuthFile | null {
    this.current();
    const raw = this.options.secrets.getSync(KEY);
    if (!raw) return null;
    const value: CodexAuthFile = JSON.parse(raw);
    return typeof value.tokens?.access_token === "string" &&
      value.tokens.access_token &&
      codexWorkspaceIdFromTokens(value.tokens)
      ? value
      : null;
  }
  connected() {
    return Boolean(this.read());
  }
  async models(force = false): Promise<CatalogModel[]> {
    // The first request can arrive immediately after adding an account. Its
    // private cache directory must exist before discovery publishes the cache.
    await this.ready;
    this.current();
    if (this.discovery) return this.discovery;
    if (!force && this.discovered) return this.discovered;
    const generation = this.generation;
    this.discovery = (async () => {
      const auth = await this.credential();
      const identity = createHash("sha256")
        .update(auth.accountId)
        .digest("hex");
      const file = path.join(this.options.root, "openai-models.json");
      if (!force && !this.cacheRead) {
        this.cacheRead = true;
        try {
          const raw = await readPrivateFile(file);
          const cache = raw ? JSON.parse(raw.toString()) : null;
          this.current();
          if (
            generation === this.generation &&
            auth.canDispatch() &&
            cache?.version === 1 &&
            cache.identity === identity &&
            Array.isArray(cache.models) &&
            cache.models.every(
              (m: CatalogModel) =>
                m &&
                typeof m.id === "string" &&
                typeof m.name === "string" &&
                Number.isFinite(m.contextWindow) &&
                Array.isArray(m.efforts),
            )
          )
            return (this.discovered = cache.models);
        } catch {
          /* A public catalog cache is recoverable from its authority. */
        }
      }
      const version =
        (await this.options.version?.()) ??
        bundledEngineRelease("codex").version;
      if (!auth.canDispatch())
        throw new Error("PROVIDER_AUTHORIZATION_CHANGED");
      const response = await (this.options.fetch ?? fetch)(
        `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(version)}`,
        {
          headers: buildChatgptBridgeHeaders(auth),
          redirect: "error",
          signal: AbortSignal.any([
            this.abort.signal,
            AbortSignal.timeout(15_000),
          ]),
        },
      );
      if (!response.ok) throw new Error("PROVIDER_DISCOVERY_FAILED");
      const body: unknown = await response.json();
      this.current();
      if (generation !== this.generation || !auth.canDispatch())
        throw new Error("PROVIDER_AUTHORIZATION_CHANGED");
      if (
        !body ||
        typeof body !== "object" ||
        !Array.isArray((body as { models?: unknown }).models)
      )
        throw new Error("PROVIDER_DISCOVERY_FAILED");
      const models = mapCodexModelsToCatalog(body);
      await atomicPrivateWrite(
        file,
        JSON.stringify({ version: 1, identity, models }),
      );
      this.current();
      if (generation !== this.generation || !auth.canDispatch())
        throw new Error("PROVIDER_AUTHORIZATION_CHANGED");
      return (this.discovered = models);
    })().finally(() => {
      this.discovery = undefined;
    });
    return this.discovery;
  }
  async credential() {
    const value = this.read();
    if (!value) throw new Error("PROVIDER_LOGIN_REQUIRED");
    const refreshed = await this.refresh(KEY, value);
    this.current();
    const current = this.read();
    if (
      !current ||
      current.tokens?.access_token !== refreshed.tokens?.access_token
    )
      throw new Error("PROVIDER_AUTHORIZATION_CHANGED");
    const accessToken = current.tokens!.access_token!;
    return {
      accessToken,
      accountId: codexWorkspaceIdFromTokens(current.tokens)!,
      canDispatch: () => {
        try {
          return this.read()?.tokens?.access_token === accessToken;
        } catch {
          return false;
        }
      },
    };
  }
  accountIdentity() {
    const account = this.read();
    const claims = account?.tokens?.id_token ? readChatgptIdTokenClaims(account.tokens.id_token) as Record<string,unknown> | null : null;
    return { email: typeof claims?.email === 'string' ? claims.email : null, accountId: codexWorkspaceIdFromTokens(account?.tokens) };
  }
  /** Native account RPCs use the selected owner's private login staging home.
   * The official CLI receives its normal auth file; model workers and controllers
   * never receive this file, and closing the host disposes every active RPC. */
  async withAccountControl<T>(logger: Logger, operation: (agent: CodexAgent) => Promise<T>): Promise<T> {
    await this.ready;
    const credential = await this.credential();
    const value = this.read(), binary = await this.options.binary();
    this.current();
    if (!value || !binary || !credential.canDispatch()) throw new Error('PROVIDER_AUTHORIZATION_CHANGED');
    const home = await mkdtemp(path.join(this.options.root, 'provider-login', 'openai-control-'));
    let agent: CodexAgent | undefined;
    try {
      await atomicPrivateWrite(path.join(home, 'auth.json'), JSON.stringify(value));
      this.current();
      if (!credential.canDispatch()) throw new Error('PROVIDER_AUTHORIZATION_CHANGED');
      agent = new CodexAgent({ binaryPath: binary, logger, runtimeConfig: { userDataPath: this.options.root },
        auth: { getState: async () => ({ authenticated: credential.canDispatch(), authSource: 'oauth', identity: this.accountIdentity().email ?? undefined }),
          getAuthEnv: async () => { this.current(); if (!credential.canDispatch()) throw new Error('PROVIDER_AUTHORIZATION_CHANGED'); return { CODEX_HOME: home }; },
          triggerLogin: async () => { throw new Error('PROVIDER_LOGIN_REQUIRED'); }, logout: async () => { throw new Error('ACCOUNT_CONTROL_ONLY'); } },
      });
      this.controls.add(agent);
      const result = await operation(agent);
      this.current();
      if (!credential.canDispatch()) throw new Error('PROVIDER_AUTHORIZATION_CHANGED');
      return result;
    } finally {
      try { if (agent) await agent.dispose(); }
      finally { if (agent) this.controls.delete(agent); await rm(home, { recursive: true, force: true }); }
    }
  }
  invalidate(token: string) {
    if (this.read()?.tokens?.access_token === token) this.disconnect();
  }
  disconnect() {
    this.current();
    for (const id of this.logins.keys()) this.cancel(id);
    this.options.secrets.deleteSync(KEY);
    this.generation++;
    this.discovered = undefined;
    this.options.changed();
  }
  removeReversibly() {
    this.current();
    const previous = this.options.secrets.getSync(KEY);
    this.disconnect();
    return () => {
      this.current();
      if (previous === null) this.options.secrets.deleteSync(KEY);
      else this.options.secrets.setSync(KEY, previous);
      this.generation++;
      this.discovered = undefined;
      this.cacheRead = true;
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
      controller: new AbortController(),
      current: () => {
        this.current();
        current();
        if (login.controller.signal.aborted || login.state.status !== "pending")
          throw new Error("PROVIDER_LOGIN_STALE");
      },
    };
    this.logins.set(id, login);
    login.work = this.authorize(login)
      .then((credential) => {
        // Commit only after the native child has exited and its plaintext staging
        // directory is gone. Cancellation cannot leave a partially connected login.
        login.current();
        this.options.secrets.setSync(KEY, JSON.stringify(credential));
        this.generation++;
        this.discovered = undefined;
        this.cacheRead = true;
        login.state = { status: "success" };
        this.options.changed();
      })
      .catch(() => {
        if (login.state.status === "pending")
          login.state = {
            status: Date.now() >= expiresAt ? "expired" : "error",
          };
      });
    return { ...login.state };
  }
  private async authorize(login: Login) {
    await this.ready;
    login.current();
    const binary = await this.options.binary();
    login.current();
    if (!binary) throw new Error("ENGINE_NOT_INSTALLED");
    const parent = path.join(this.options.root, "provider-login");
    await privateDirectory(parent);
    login.current();
    const staging = await mkdtemp(path.join(parent, "openai-"));
    try {
      await privateDirectory(staging);
      await atomicPrivateWrite(
        path.join(staging, "config.toml"),
        'cli_auth_credentials_store = "file"\n',
      );
      login.current();
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const key of Object.keys(env))
        if (
          [
            "CODEX_HOME",
            "OPENAI_API_KEY",
            "CODEX_API_KEY",
            "CODEX_ACCESS_TOKEN",
            "OPENAI_FEDERATION_RULE_ID",
            "OPENAI_IDENTITY_TOKEN_FILE",
            "OPENAI_WORKLOAD_IDENTITY_CONTEXT",
          ].includes(key.toUpperCase())
        )
          delete env[key];
      env.CODEX_HOME = staging;
      const result = await (this.options.run ?? runNative)(
        binary,
        ["login", "--device-auth"],
        {
          env,
          cwd: staging,
          signal: login.controller.signal,
          timeout: Math.max(1, login.state.expiresAt! - Date.now()),
          onOutput: (text) => {
            if (
              login.controller.signal.aborted ||
              login.state.status !== "pending"
            )
              return;
            // Never forward arbitrary vendor output. Only the official device
            // page and its displayed one-time code cross the protected channel.
            const plain = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
            const url = plain.match(
              /https:\/\/auth\.openai\.com\/codex\/device\b/,
            );
            const code = plain.match(/\b[A-Z0-9]{4,6}-[A-Z0-9]{4,6}\b/);
            if (url && code)
              login.state = {
                ...login.state,
                verificationUrl: url[0],
                userCode: code[0],
              };
          },
        },
      );
      login.current();
      if (result.code !== 0) throw new Error("PROVIDER_LOGIN_FAILED");
      const raw = await readPrivateFile(path.join(staging, "auth.json"));
      login.current();
      if (!raw || raw.length > 128 * 1024)
        throw new Error("PROVIDER_LOGIN_FAILED");
      const value: CodexAuthFile = JSON.parse(raw.toString());
      if (
        !value.tokens?.access_token ||
        !codexWorkspaceIdFromTokens(value.tokens)
      )
        throw new Error("PROVIDER_LOGIN_FAILED");
      // Whitelist the OAuth contract; don't retain native history or API keys.
      const credential: CodexAuthFile = {
        auth_mode: "chatgpt",
        last_refresh: value.last_refresh,
        tokens: {
          access_token: value.tokens.access_token,
          refresh_token: value.tokens.refresh_token,
          id_token: value.tokens.id_token,
          account_id: codexWorkspaceIdFromTokens(value.tokens)!,
        },
      };
      login.current();
      return credential;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  state(id: string): ProviderLoginState {
    this.current();
    const login = this.logins.get(id);
    if (!login) throw new Error("PROVIDER_LOGIN_STALE");
    if (
      login.state.status === "pending" &&
      Date.now() >= login.state.expiresAt!
    )
      this.cancel(id, "expired");
    return { ...login.state };
  }
  cancel(id: string, status: "cancelled" | "expired" = "cancelled") {
    const login = this.logins.get(id);
    if (!login) return;
    if (login.state.status === "pending") {
      login.state = { status };
      login.controller.abort();
    }
  }
  async close() {
    this.closed = true;
    this.abort.abort();
    await Promise.allSettled([...this.controls].map(agent => agent.dispose()));
    for (const id of this.logins.keys()) this.cancel(id);
    await Promise.allSettled(
      [...this.logins.values()].map((login) => login.work),
    );
    await this.ready.catch(() => {});
    this.logins.clear();
  }
}
