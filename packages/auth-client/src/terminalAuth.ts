import { z } from "zod";
import { accountVaultKey } from "./accountMetadata.js";
import { AuthApiError, CindyAuthClient, type AuthFetch } from "./client.js";
import { discoverEmailLogin, discoverPersonalLoginOrganization } from "./emailLoginDiscovery.js";
import { discoverSsoOrgRealm } from "./orgRealmDiscovery.js";
import {
  authRegionSchema, membershipSchema, reduceAuthFlow, ssoOrgDiscoveryToMethods,
  CAPTCHA_CHALLENGE_PAGE_PATH, captchaRequiredActionForVerificationKind,
  type AccountMembership, type AuthFlowState, type AuthMembership,
  type AuthRegion, type AuthSuccess, type AuthTokenPair, type LoginMethod, type LoginOutcome,
  type CaptchaRequiredAction, type ProviderConfig, type SocialProvider, type VerificationKind,
} from "./types.js";

const storedAccountSchema = z.object({
  realm: authRegionSchema,
  membership: membershipSchema,
  refreshToken: z.string().min(1),
  accountRefreshToken: z.string().min(1).optional(),
});
const vaultSchema = z.object({
  version: z.literal(1),
  activeAccount: z.string().nullable(),
  accounts: z.record(z.string(), storedAccountSchema),
}).superRefine((vault, ctx) => {
  if (vault.activeAccount !== null && !Object.hasOwn(vault.accounts, vault.activeAccount)) {
    ctx.addIssue({ code: "custom", message: "Unknown active account" });
  }
  for (const [key, account] of Object.entries(vault.accounts)) {
    if (key !== accountVaultKey(account.realm, account.membership.id)) {
      ctx.addIssue({ code: "custom", message: "Invalid account identity" });
    }
  }
});

export type TerminalAuthVault = z.infer<typeof vaultSchema>;

/** Trusted host boundary. Implement using encrypted storage; never a plain JSON file.
 * save must atomically replace the complete vault or reject without changing it.
 * One controller owns this vault; hosts must lock the profile across processes.
 */
export interface AuthSecretStore {
  load(): Promise<unknown | null>;
  save(vault: TerminalAuthVault): Promise<void>;
}

export interface TerminalAuthAccount {
  key: string;
  realm: AuthRegion;
  membership: AuthMembership;
}

export interface TerminalAuthSnapshot {
  accounts: TerminalAuthAccount[];
  session: (TerminalAuthAccount & {
    status: "authenticated" | "temporarily-unavailable" | "reauthentication-required";
    reason?: string;
  }) | null;
  flow: AuthFlowState | null;
  error: { code: string; retryAt?: number } | null;
}

/** Safe to show locally. The id binds a protected submission to this controller's
 * pending action; the existing hosted page does not echo a server challenge id.
 */
export interface TerminalCaptchaChallenge {
  id: string;
  url: string;
  action: CaptchaRequiredAction;
  expiresAt: number;
}

export interface TerminalAuthOptions {
  /** Existing wire identity: no new client_type is sent to old auth servers. */
  deviceId: string;
  region?: AuthRegion;
  locale?: string;
  endpoints: Record<AuthRegion, { baseUrl: string; hostedCallbackUrl?: string }>;
  fetch: AuthFetch;
  secretStore: AuthSecretStore;
  /** Display locally to the human. Do not send URLs/codes to an agent or logs. */
  onAuthorizeUrl: (request: { url: string; expiresAt: number; signal: AbortSignal }) => void | Promise<void>;
  onChange?: (snapshot: TerminalAuthSnapshot) => void;
  /** Quiesce the previous owner before its key changes (also initial null → key).
   * Same-key refresh/relogin does not call this hook. Reconcile the committed
   * snapshot after every action, including failures; this is not an after hook.
   */
  beforeAccountChange?: (previous: TerminalAuthAccount | null, next: TerminalAuthAccount | null) => Promise<void>;
  crypto?: Crypto;
  now?: () => number;
  requestTimeoutMs?: number;
  authorizationTimeoutMs?: number;
}

/** Public errors contain fixed codes only, never server messages or credential values. */
export class TerminalAuthError extends Error {
  constructor(public readonly code: string, public readonly retryAt?: number) {
    super(code);
    this.name = "TerminalAuthError";
  }
}

interface Attempt { epoch: number; controller: AbortController; timedOut?: boolean }
interface PendingCaptcha extends TerminalCaptchaChallenge { kind: VerificationKind; identifier: string }
const emptyVault = (): TerminalAuthVault => ({ version: 1, activeAccount: null, accounts: {} });
const clone = <T>(value: T): T => structuredClone(value);
const invalid = () => new TerminalAuthError("INVALID_AUTH_ACTION");

function publicError(error: unknown): TerminalAuthError {
  if (error instanceof TerminalAuthError) return error;
  if (error instanceof AuthApiError && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)) {
    return new TerminalAuthError(error.code, error.retryAt);
  }
  return new TerminalAuthError("AUTH_REQUEST_FAILED");
}

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Pure Node/browser-compatible controller. No Electron, OS browser, filesystem,
 * native login, UI, or process environment dependency. Tickets and access tokens
 * remain private; only refresh credentials cross the injected secret-store port.
 */
export class TerminalAuthController {
  private readonly region: AuthRegion;
  private readonly now: () => number;
  private vault = emptyVault();
  private loaded = false;
  private state: TerminalAuthSnapshot = { accounts: [], session: null, flow: null, error: null };
  private attempt: Attempt | null = null;
  private epoch = 0;
  private writes: Promise<void> = Promise.resolve();
  private accessToken: string | null = null;
  private accountToken: string | null = null;
  private pendingAccountToken: string | null = null;
  private loginRealm: AuthRegion;
  private providers: ProviderConfig | null = null;
  private methods: LoginMethod[] = [];
  private pendingLoginTicket: string | null = null;
  private pendingBindTicket: string | null = null;
  private pendingVerificationTicket: string | null = null;
  private pendingAccountRefreshToken: string | undefined;
  private pendingPersonal: { realm: AuthRegion; outcome: AuthSuccess } | null = null;
  private codeRequest: { kind: VerificationKind; identifier: string } | null = null;
  private bindingContact: string | null = null;
  private handledEmail: string | null = null;
  private source: "personal" | "sso" = "personal";
  private refreshPending: Promise<TerminalAuthSnapshot> | null = null;
  private refreshRetryAt = 0;
  private storageRecoveryRequired = false;
  private pendingCaptcha: PendingCaptcha | null = null;

  constructor(private readonly options: TerminalAuthOptions) {
    this.region = options.region ?? "global";
    this.loginRealm = this.region;
    this.now = options.now ?? Date.now;
  }

  snapshot(): TerminalAuthSnapshot { return clone(this.state); }

  /** Trusted runtime host only. Never serialize this result over the public UI API. */
  getAccessToken(): string | null {
    return this.state.session?.status === "authenticated" ? this.accessToken : null;
  }

  initialize(): Promise<TerminalAuthSnapshot> {
    return this.run(async (attempt) => {
      await this.ensureLoaded(attempt);
      if (this.vault.activeAccount) await this.refreshActive(attempt);
    });
  }

  beginLogin(): Promise<TerminalAuthSnapshot> {
    return this.run(async (attempt) => {
      await this.ensureLoaded(attempt);
      this.clearFlow();
      this.providers = await this.client(attempt, this.region).getProviders();
      this.check(attempt);
      this.state.flow = reduceAuthFlow(null, { type: "providers-loaded", providers: this.providers });
    });
  }

  discoverEmail(email: string): Promise<TerminalAuthSnapshot> {
    return this.run(async (attempt) => {
      this.requireProviders();
      const result = await discoverEmailLogin(email, {
        buildRegion: this.region,
        discoverPersonal: (value) => this.client(attempt, this.region).discover(value),
        discoverOrganization: async (domain) => (await this.discoverRealm(attempt, domain)).discovery,
      });
      this.check(attempt);
      this.handledEmail = result.email;
      this.loginRealm = result.region;
      this.methods = result.region === this.region ? result.methods : [];
      this.state.flow = result.region === this.region
        ? reduceAuthFlow(null, { type: "discovery-loaded", email: result.email, methods: result.methods })
        : reduceAuthFlow(null, { type: "realm-switch-required", targetRegion: result.region,
          email: result.email, providers: this.providers!, methods: result.methods });
    });
  }

  discoverOrganization(identifier: string): Promise<TerminalAuthSnapshot> {
    return this.run(async (attempt) => {
      this.requireProviders();
      const normalized = identifier.trim().toLowerCase();
      if (!normalized || normalized.length > 253) throw new TerminalAuthError("INVALID_PARAMS");
      const result = await this.discoverRealm(attempt, normalized);
      this.check(attempt);
      this.loginRealm = result.region;
      const methods = ssoOrgDiscoveryToMethods(result.discovery);
      this.methods = result.region === this.region ? methods : [];
      this.state.flow = result.region === this.region
        ? reduceAuthFlow(null, { type: "discovery-loaded", email: "", methods })
        : reduceAuthFlow(null, { type: "realm-switch-required", targetRegion: result.region,
          providers: this.providers!, methods });
    });
  }

  confirmRealm(accept: boolean): Promise<TerminalAuthSnapshot> {
    return this.run(async (attempt) => {
      const flow = this.state.flow;
      if (flow?.step !== "realm-confirmation") throw invalid();
      const personal = this.pendingPersonal;
      this.pendingPersonal = null;
      if (!accept) {
        if (personal) await this.commitLogin(attempt, personal.realm, personal.outcome);
        else {
          this.loginRealm = this.region;
          this.methods = [];
          this.state.flow = { step: "identifier", providers: this.requireProviders() };
        }
        return;
      }
      this.loginRealm = flow.targetRegion;
      this.methods = flow.methods;
      this.state.flow = { step: "method-choice", email: flow.email ?? "", methods: flow.methods };
    });
  }

  requestCode(kind: VerificationKind, identifier: string): Promise<TerminalAuthSnapshot> {
    return this.run(async (attempt) => {
      const value = this.codeIdentifier(kind, identifier);
      if (this.requiresCaptcha(kind)) {
        throw new TerminalAuthError("CAPTCHA_REQUIRED");
      }
      await this.sendCode(attempt, kind, value);
    });
  }

  /** Display/open url on the human's device, then submit the complete return URL
   * through protected input. No clipboard, browser, log or remote input is used
   * here. Any other action, cancel, or a replacement challenge invalidates id.
   */
  startCaptcha(kind: VerificationKind, identifier: string, appearance: { theme?: "light" | "dark"; lang?: string } = {}): Promise<TerminalCaptchaChallenge> {
    let challenge: TerminalCaptchaChallenge;
    return this.run(async () => {
      const value = this.codeIdentifier(kind, identifier);
      if (!this.requiresCaptcha(kind)) throw new TerminalAuthError("CAPTCHA_NOT_REQUIRED");
      let url: URL;
      try { url = new URL(CAPTCHA_CHALLENGE_PAGE_PATH, this.options.endpoints[this.region].baseUrl); }
      catch { throw new TerminalAuthError("CAPTCHA_UNAVAILABLE"); }
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password) {
        throw new TerminalAuthError("CAPTCHA_UNAVAILABLE");
      }
      const theme = appearance.theme ?? "light";
      const lang = appearance.lang ?? this.options.locale ?? "en";
      if (!["light", "dark"].includes(theme) || !/^[a-zA-Z0-9_-]{1,35}$/.test(lang)) throw new TerminalAuthError("INVALID_PARAMS");
      const action = captchaRequiredActionForVerificationKind(kind);
      url.searchParams.set("action", action);
      url.searchParams.set("theme", theme);
      url.searchParams.set("lang", lang);
      const bytes = new Uint8Array(24);
      (this.options.crypto ?? globalThis.crypto).getRandomValues(bytes);
      challenge = { id: base64url(bytes), url: url.toString(), action, expiresAt: this.now() + 120_000 };
      this.pendingCaptcha = { ...challenge, kind, identifier: value };
    }).then(() => clone(challenge));
  }

  /** Trusted human-input boundary: never expose returnedUrl to a model, public
   * control event, command-line argument, history or log. The token is decoded
   * once and forwarded directly to request-code, never retained or returned.
   */
  completeCaptcha(id: string, returnedUrl: string): Promise<TerminalAuthSnapshot> {
    // Do not cancel an already-running submission when its consumed id is
    // replayed, or when a stale UI sends a different challenge id.
    if (!this.pendingCaptcha || this.pendingCaptcha.id !== id) {
      return Promise.reject(new TerminalAuthError("CAPTCHA_ATTEMPT_INVALID"));
    }
    return this.run(async (attempt) => {
      const challenge = this.pendingCaptcha;
      if (!challenge || challenge.id !== id) throw new TerminalAuthError("CAPTCHA_ATTEMPT_INVALID");
      if (this.now() >= challenge.expiresAt) {
        this.pendingCaptcha = null;
        throw new TerminalAuthError("CAPTCHA_EXPIRED");
      }
      const result = this.captchaResult(returnedUrl, challenge.url);
      if (!result) throw new TerminalAuthError("CAPTCHA_RETURN_INVALID");
      // Consume before any request/await: a transport failure or duplicate
      // submission must never reuse a token the server might have consumed.
      this.pendingCaptcha = null;
      if (result.status === "err") {
        throw new TerminalAuthError(result.code === "expired" ? "CAPTCHA_EXPIRED" : result.code === "cancelled" ? "USER_CANCELLED" : "CAPTCHA_FAILED");
      }
      const value = this.codeIdentifier(challenge.kind, challenge.identifier);
      await this.sendCode(attempt, challenge.kind, value, result.token);
    }, true);
  }

  verifyCode(code: string): Promise<TerminalAuthSnapshot> {
    return this.run(async (attempt) => {
      if (!this.codeRequest || this.state.flow?.step !== "verification-code" || !code.trim()) throw invalid();
      const request = this.codeRequest;
      await this.accept(attempt, await this.client(attempt, this.region).verifyCode(request.kind, request.identifier, code));
    });
  }

  authorize(kind: "sso" | "social", providerOrConnectionId: string): Promise<TerminalAuthSnapshot> {
    return this.run(async (attempt) => {
      const providers = this.requireProviders();
      if (kind === "sso" && !this.methods.some((method) => method.type === "sso" && method.connectionId === providerOrConnectionId)) throw invalid();
      if (kind === "social" && !providers.social.includes(providerOrConnectionId as SocialProvider)) throw invalid();
      const realm = kind === "social" ? this.region : this.loginRealm;
      const callback = this.options.endpoints[realm].hostedCallbackUrl;
      if (!callback) throw new TerminalAuthError("HOSTED_CALLBACK_UNAVAILABLE");
      const callbackUrl = new URL(callback);
      if (callbackUrl.protocol !== "https:" && !(callbackUrl.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(callbackUrl.hostname))) {
        throw new TerminalAuthError("INVALID_AUTH_CONFIGURATION");
      }
      const crypto = this.options.crypto ?? globalThis.crypto;
      if (!crypto?.subtle) throw new TerminalAuthError("CRYPTO_UNAVAILABLE");
      const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
      const pollSecret = base64url(crypto.getRandomValues(new Uint8Array(32)));
      const digest = async (value: string) => base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
      const client = this.client(attempt, realm);
      const url = client.buildAuthorizeUrl({ kind, providerOrConnectionId, redirectUri: callback,
        codeChallenge: await digest(verifier), state: await digest(pollSecret) });
      this.check(attempt);
      this.loginRealm = realm;
      this.source = kind === "sso" ? "sso" : "personal";
      if (kind === "social") this.handledEmail = null;
      this.state.flow = { step: "browser-redirect", label: providerOrConnectionId };
      this.emit();
      const timeout = this.options.authorizationTimeoutMs ?? 300_000;
      const expiresAt = this.now() + timeout;
      const timer = setTimeout(() => { attempt.timedOut = true; attempt.controller.abort(); }, timeout);
      try {
        await this.wait(attempt, Promise.resolve(this.options.onAuthorizeUrl({ url, expiresAt, signal: attempt.controller.signal })));
        let failures = 0;
        const started = this.now();
        for (;;) {
          this.check(attempt);
          let poll;
          try {
            poll = await client.pollDesktopAuthorization(pollSecret, { signal: attempt.controller.signal });
            failures = 0;
          } catch (error) {
            this.check(attempt);
            if (++failures >= 8 || (error instanceof AuthApiError && error.statusCode >= 400 && error.statusCode < 500)) throw error;
          }
          if (poll?.status === "ok") {
            await this.accept(attempt, await client.exchangeAuthorizationCode(poll.code, verifier));
            return;
          }
          if (poll?.status === "expired") throw new TerminalAuthError("INVALID_AUTH_CODE");
          if (poll?.status === "error") throw new TerminalAuthError(/^[A-Z][A-Z0-9_]{0,79}$/.test(poll.error) ? poll.error : "AUTH_REQUEST_FAILED");
          await this.pause(attempt, this.now() - started >= 30_000 ? 2_000 : 1_000);
        }
      } finally { clearTimeout(timer); }
    });
  }

  selectAccount(membershipId: string): Promise<TerminalAuthSnapshot> {
    return this.run(async (attempt) => {
      const flow = this.state.flow;
      if (flow?.step !== "account-selection" || !flow.accounts.some((account) => account.id === membershipId)) throw invalid();
      const client = this.client(attempt, this.loginRealm);
      const outcome: LoginOutcome = this.pendingAccountToken
        ? { status: "ok", ...await client.exchangeAccountMembership(this.pendingAccountToken, membershipId),
          ...(this.pendingAccountRefreshToken ? { accountRefreshToken: this.pendingAccountRefreshToken, accountToken: this.pendingAccountToken } : {}) }
        : this.pendingLoginTicket ? await client.selectAccount(this.pendingLoginTicket, membershipId) : (() => { throw invalid(); })();
      await this.accept(attempt, outcome);
    });
  }

  requestBindingCode(contact: string): Promise<TerminalAuthSnapshot> {
    return this.run(async (attempt) => {
      const flow = this.state.flow;
      if (flow?.step !== "binding" || !this.pendingBindTicket || !contact.trim()) throw invalid();
      await this.client(attempt, this.loginRealm).requestBindingCode(this.pendingBindTicket, flow.bindType, contact.trim());
      this.check(attempt);
      this.bindingContact = contact.trim();
      this.state.flow = { ...flow, codeRequested: true, contact: this.bindingContact };
    });
  }

  verifyBinding(code: string): Promise<TerminalAuthSnapshot> {
    return this.run(async (attempt) => {
      const flow = this.state.flow;
      if (flow?.step !== "binding" || !flow.codeRequested || !this.pendingBindTicket || !this.bindingContact || !code.trim()) throw invalid();
      await this.accept(attempt, await this.client(attempt, this.loginRealm).verifyBinding(this.pendingBindTicket, flow.bindType, this.bindingContact, code));
    });
  }

  requestSsoVerificationCode(): Promise<TerminalAuthSnapshot> {
    return this.run(async (attempt) => {
      const flow = this.state.flow;
      if (flow?.step !== "sso-verification" || !this.pendingVerificationTicket) throw invalid();
      await this.client(attempt, this.loginRealm).requestSsoVerificationCode(this.pendingVerificationTicket);
      this.check(attempt);
      this.state.flow = { ...flow, codeRequested: true };
    });
  }

  verifySsoVerification(code: string): Promise<TerminalAuthSnapshot> {
    return this.run(async (attempt) => {
      if (this.state.flow?.step !== "sso-verification" || !this.pendingVerificationTicket || !code.trim()) throw invalid();
      await this.accept(attempt, await this.client(attempt, this.loginRealm).verifySsoVerification(this.pendingVerificationTicket, code));
    });
  }

  cancel(): Promise<TerminalAuthSnapshot> {
    return this.run(async () => { this.clearFlow(); });
  }

  refresh(): Promise<TerminalAuthSnapshot> {
    if (this.refreshPending) return this.refreshPending;
    if (this.now() < this.refreshRetryAt) return Promise.resolve(this.snapshot());
    const pending = this.run(async (attempt) => {
      await this.ensureLoaded(attempt);
      await this.refreshActive(attempt);
    });
    this.refreshPending = pending;
    void pending.finally(() => { if (this.refreshPending === pending) this.refreshPending = null; }).catch(() => {});
    return pending;
  }

  switchAccount(key: string): Promise<TerminalAuthSnapshot> {
    return this.run(async (attempt) => {
      await this.ensureLoaded(attempt);
      const account = this.vault.accounts[key];
      if (!account) throw new TerminalAuthError("ACCOUNT_NOT_FOUND");
      this.clearFlow();
      const pair = await this.refreshStored(attempt, account);
      await this.commitLogin(attempt, account.realm, { status: "ok", ...pair }, account.accountRefreshToken);
    });
  }

  /** Get current passport memberships without exposing passport tokens to the UI. */
  memberships(): Promise<AccountMembership[]> {
    let result: AccountMembership[] = [];
    return this.run(async (attempt) => {
      await this.ensureLoaded(attempt);
      const account = this.activeStored();
      const token = await this.getAccountToken(attempt, account);
      result = await this.client(attempt, account.realm).getAccountMemberships(token);
      this.check(attempt);
    }).then(() => clone(result));
  }

  switchMembership(membershipId: string): Promise<TerminalAuthSnapshot> {
    return this.run(async (attempt) => {
      await this.ensureLoaded(attempt);
      const account = this.activeStored();
      const token = await this.getAccountToken(attempt, account);
      const client = this.client(attempt, account.realm);
      const memberships = await client.getAccountMemberships(token);
      this.check(attempt);
      if (!memberships.some((item) => item.id === membershipId)) throw new TerminalAuthError("ACCOUNT_NOT_FOUND");
      const pair = await client.exchangeAccountMembership(token, membershipId);
      if (pair.membership.id !== membershipId) throw new TerminalAuthError("ACCOUNT_IDENTITY_MISMATCH");
      const current = this.activeStored();
      await this.commitLogin(attempt, account.realm, { status: "ok", ...pair }, current.accountRefreshToken);
    });
  }

  /** Removes the active saved account, or all local accounts. Only the active
   * remote session/passport is revoked; other saved identities need their own
   * login to revoke remotely. Remote failure is reported after local removal.
   */
  logout(options: { all?: boolean } = {}): Promise<TerminalAuthSnapshot> {
    return this.run(async (attempt) => {
      await this.ensureLoaded(attempt);
      this.clearFlow();
      const session = this.state.session;
      const accessToken = this.accessToken;
      const accountToken = this.accountToken;
      const next = options.all ? emptyVault() : clone(this.vault);
      if (!options.all && next.activeAccount) delete next.accounts[next.activeAccount];
      next.activeAccount = null;
      await this.persist(attempt, next, null);
      this.accessToken = null;
      this.accountToken = null;
      this.state.session = null;
      this.refreshRetryAt = 0;
      this.emit();
      if (session && accessToken) await this.client(attempt, session.realm).logout(accessToken);
      if (options.all && session && accountToken) await this.client(attempt, session.realm).logoutAccount(accountToken);
    });
  }

  private async getAccountToken(attempt: Attempt, account: TerminalAuthVault["accounts"][string]): Promise<string> {
    if (this.accountToken) return this.accountToken;
    if (!account.accountRefreshToken) throw new TerminalAuthError("ACCOUNT_LOGIN_REQUIRED");
    const expectedToken = account.accountRefreshToken;
    const completion = this.client(attempt, account.realm, true).refreshAccount(expectedToken).then(async (pair) => {
      await this.preserveRotation((next) => {
        let changed = false;
        for (const item of Object.values(next.accounts)) {
          if (item.realm === account.realm && item.membership.passportId === account.membership.passportId && item.accountRefreshToken === expectedToken) {
            item.accountRefreshToken = pair.accountRefreshToken;
            changed = true;
          }
        }
        return changed;
      });
      return pair;
    });
    const pair = await this.wait(attempt, completion);
    this.check(attempt);
    this.accountToken = pair.accountToken;
    return pair.accountToken;
  }

  private refreshStored(attempt: Attempt, account: TerminalAuthVault["accounts"][string]): Promise<AuthTokenPair> {
    // Refresh rotates credentials on the server. Once sent, let the bounded
    // request finish even if its UI operation is cancelled; save only this
    // account's replacement token, never restore its active-owner selection.
    const completion = this.client(attempt, account.realm, true).refresh(account.refreshToken).then(async (pair) => {
      this.checkMembership(account.membership, pair.membership);
      await this.preserveRotation((next) => {
        const current = next.accounts[accountVaultKey(account.realm, account.membership.id)];
        if (!current || current.refreshToken !== account.refreshToken) return false;
        current.refreshToken = pair.refreshToken;
        current.membership = clone(pair.membership);
        return true;
      });
      return pair;
    });
    return this.wait(attempt, completion);
  }

  private preserveRotation(update: (vault: TerminalAuthVault) => boolean): Promise<void> {
    const write = this.writes.then(async () => {
      const next = clone(this.vault);
      if (!update(next)) return;
      try { await this.options.secretStore.save(clone(next)); }
      catch {
        // Keep the only still-valid rotated token in trusted memory so a
        // recovered secret backend can persist it before the next refresh.
        this.vault = next;
        this.storageRecoveryRequired = true;
        this.state.error = { code: "CREDENTIAL_STORE_UNAVAILABLE" };
        this.emit();
        throw new TerminalAuthError("CREDENTIAL_STORE_UNAVAILABLE");
      }
      this.vault = next;
      this.projectAccounts();
    });
    this.writes = write.then(() => {}, () => {});
    return write;
  }

  private async refreshActive(attempt: Attempt): Promise<void> {
    const key = this.vault.activeAccount;
    if (!key) return;
    const account = this.vault.accounts[key];
    try {
      const pair = await this.refreshStored(attempt, account);
      this.check(attempt);
      this.checkMembership(account.membership, pair.membership);
      await this.commitLogin(attempt, account.realm, { status: "ok", ...pair }, account.accountRefreshToken);
    } catch (error) {
      this.check(attempt);
      const failure = publicError(error);
      const definitive = ["REFRESH_TOKEN_EXPIRED", "INVALID_REFRESH_TOKEN", "MEMBERSHIP_DISABLED"].includes(failure.code);
      const mismatched = failure.code === "DEVICE_MISMATCH" || failure.code === "ACCOUNT_IDENTITY_MISMATCH";
      if (definitive || mismatched) {
        if (definitive) {
          const next = clone(this.vault);
          delete next.accounts[key];
          next.activeAccount = null;
          await this.persist(attempt, next, null);
        } else if (this.state.session?.status === "authenticated") {
          await this.options.beforeAccountChange?.(clone(this.state.session), null);
          this.check(attempt);
        }
        this.accessToken = null;
        this.accountToken = null;
        this.state.session = { key, realm: account.realm, membership: clone(account.membership), status: "reauthentication-required", reason: failure.code };
      } else {
        this.state.session = { key, realm: account.realm, membership: clone(account.membership), status: "temporarily-unavailable", reason: failure.code };
        this.refreshRetryAt = Math.max(this.now() + 60_000, failure.retryAt ?? 0);
      }
      throw failure;
    }
  }

  private async accept(attempt: Attempt, outcome: LoginOutcome): Promise<void> {
    this.check(attempt);
    if (outcome.status === "ok") {
      if (this.source === "personal") {
        const discovery = await discoverPersonalLoginOrganization(outcome.membership, {
          handledEmail: this.handledEmail,
          discoverOrganization: async (domain) => (await this.discoverRealm(attempt, domain)).discovery,
        });
        this.check(attempt);
        if (discovery) {
          this.pendingPersonal = { realm: this.loginRealm, outcome };
          this.state.flow = { step: "realm-confirmation", targetRegion: discovery.region, personalLoginAvailable: true,
            providers: this.requireProviders(), methods: ssoOrgDiscoveryToMethods(discovery) };
          return;
        }
      }
      await this.commitLogin(attempt, this.loginRealm, outcome);
      return;
    }
    this.pendingLoginTicket = outcome.status === "select_account" ? outcome.loginTicket : null;
    this.pendingBindTicket = outcome.status === "binding_required" ? outcome.bindTicket : null;
    this.pendingVerificationTicket = outcome.status === "sso_verification_required" ? outcome.verificationTicket : null;
    this.pendingAccountToken = outcome.status === "select_account" ? outcome.accountToken ?? null : null;
    this.pendingAccountRefreshToken = outcome.status === "select_account" ? outcome.accountRefreshToken : undefined;
    this.bindingContact = null;
    this.state.flow = reduceAuthFlow(this.state.flow, { type: "outcome", outcome });
  }

  private async commitLogin(attempt: Attempt, realm: AuthRegion, outcome: AuthSuccess, accountRefreshToken?: string): Promise<void> {
    this.check(attempt);
    const key = accountVaultKey(realm, outcome.membership.id);
    const next = clone(this.vault);
    const passportRefresh = outcome.accountRefreshToken ?? accountRefreshToken;
    next.accounts[key] = { realm, membership: clone(outcome.membership), refreshToken: outcome.refreshToken,
      ...(passportRefresh ? { accountRefreshToken: passportRefresh } : {}) };
    next.activeAccount = key;
    const publicAccount = { key, realm, membership: clone(outcome.membership) };
    await this.persist(attempt, next, publicAccount);
    this.accessToken = outcome.accessToken;
    this.accountToken = outcome.accountToken ?? null;
    this.state.session = { ...publicAccount, status: "authenticated" };
    this.refreshRetryAt = 0;
    this.clearFlow();
    this.state.flow = { step: "completed", membership: clone(outcome.membership) };
  }

  private checkMembership(expected: AuthMembership, actual: AuthMembership): void {
    if (expected.id !== actual.id || (expected.passportId && actual.passportId !== expected.passportId)) throw new TerminalAuthError("ACCOUNT_IDENTITY_MISMATCH");
  }

  private activeStored(): TerminalAuthVault["accounts"][string] {
    const account = this.vault.activeAccount ? this.vault.accounts[this.vault.activeAccount] : null;
    if (!account) throw new TerminalAuthError("LOGIN_REQUIRED");
    return account;
  }

  private requireProviders(): ProviderConfig {
    if (!this.providers) throw invalid();
    return this.providers;
  }

  private codeIdentifier(kind: VerificationKind, identifier: string): string {
    if (kind !== "email" && kind !== "phone") throw new TerminalAuthError("INVALID_PARAMS");
    const providers = this.requireProviders();
    const normalized = identifier.trim();
    if (!normalized || normalized.length > 254) throw new TerminalAuthError("INVALID_PARAMS");
    if (!providers[kind]) throw new TerminalAuthError(kind === "email" ? "EMAIL_LOGIN_DISABLED" : "PHONE_LOGIN_DISABLED");
    if (kind === "email") {
      const flow = this.state.flow;
      if (!((flow?.step === "method-choice" && flow.email === normalized.toLowerCase()) ||
        (flow?.step === "verification-code" && flow.kind === kind && flow.identifier === normalized.toLowerCase()))) throw invalid();
      if (this.methods.some((method) => method.type === "sso" && method.ssoRequired) ||
        !this.methods.some((method) => method.type === "email_code")) throw new TerminalAuthError("SSO_REQUIRED");
    }
    return kind === "email" ? normalized.toLowerCase() : normalized;
  }

  private requiresCaptcha(kind: VerificationKind): boolean {
    return this.requireProviders().captcha?.requiredFor.includes(captchaRequiredActionForVerificationKind(kind)) ?? false;
  }

  private async sendCode(attempt: Attempt, kind: VerificationKind, identifier: string, captchaToken?: string): Promise<void> {
    await this.client(attempt, this.region).requestCode(kind, identifier, { captchaToken });
    this.check(attempt);
    this.loginRealm = this.region;
    this.source = "personal";
    this.codeRequest = { kind, identifier };
    this.state.flow = { step: "verification-code", kind, identifier };
  }

  private captchaResult(raw: string, expectedUrl: string): { status: "ok"; token: string } | { status: "err"; code: string } | null {
    // URL() silently trims controls/whitespace. Reject them instead so pasted
    // extra text cannot be interpreted as a trusted auth-page result.
    if (!raw || raw.length > 8192 || /[\u0000-\u0020\u007f]/.test(raw)) return null;
    let target: URL;
    let expected: URL;
    try { target = new URL(raw); expected = new URL(expectedUrl); }
    catch { return null; }
    const query = (url: URL) => [...url.searchParams.entries()].sort(([a, x], [b, y]) => a.localeCompare(b) || x.localeCompare(y));
    if (target.protocol !== expected.protocol || target.origin !== expected.origin || target.username || target.password ||
      target.pathname !== CAPTCHA_CHALLENGE_PAGE_PATH || expected.pathname !== CAPTCHA_CHALLENGE_PAGE_PATH ||
      JSON.stringify(query(target)) !== JSON.stringify(query(expected))) return null;
    const prefix = "#cindy-captcha=";
    if (!target.hash.startsWith(prefix)) return null;
    const payload = target.hash.slice(prefix.length);
    if (payload.startsWith("ok.")) {
      let token: string;
      try { token = decodeURIComponent(payload.slice(3)); } catch { return null; }
      if (!token || token.length > 2048 || /[\u0000-\u0020\u007f]/.test(token)) return null;
      return { status: "ok", token };
    }
    if (payload.startsWith("err.")) {
      const code = payload.slice(4);
      return /^[a-z0-9_-]{1,64}$/i.test(code) ? { status: "err", code } : null;
    }
    return null;
  }

  private clearFlow(): void {
    this.loginRealm = this.region;
    this.state.flow = null;
    this.methods = [];
    this.pendingLoginTicket = null;
    this.pendingBindTicket = null;
    this.pendingVerificationTicket = null;
    this.pendingAccountToken = null;
    this.pendingAccountRefreshToken = undefined;
    this.pendingPersonal = null;
    this.codeRequest = null;
    this.bindingContact = null;
    this.handledEmail = null;
    this.source = "personal";
    this.pendingCaptcha = null;
  }

  private discoverRealm(attempt: Attempt, org: string) {
    return discoverSsoOrgRealm(org, { cn: this.client(attempt, "cn"), global: this.client(attempt, "global") });
  }

  private async ensureLoaded(attempt: Attempt): Promise<void> {
    await this.writes;
    this.check(attempt);
    if (this.storageRecoveryRequired) {
      // An interrupted write whose rollback failed is not a fresh login. Repair
      // from the last authoritative in-memory vault before trusting disk again.
      const repair = this.writes.then(async () => {
        this.check(attempt);
        try { await this.options.secretStore.save(clone(this.vault)); }
        catch { throw new TerminalAuthError("CREDENTIAL_STORE_UNAVAILABLE"); }
        this.check(attempt);
        this.storageRecoveryRequired = false;
      });
      this.writes = repair.then(() => {}, () => {});
      await repair;
    }
    if (this.loaded) return;
    let raw: unknown;
    try { raw = await this.options.secretStore.load(); }
    catch { throw new TerminalAuthError("CREDENTIAL_STORE_UNAVAILABLE"); }
    this.check(attempt);
    const parsed = raw === null ? { success: true as const, data: emptyVault() } : vaultSchema.safeParse(raw);
    if (!parsed.success) throw new TerminalAuthError("CREDENTIAL_STORE_INVALID");
    this.vault = clone(parsed.data);
    this.loaded = true;
    this.projectAccounts();
  }

  private persist(attempt: Attempt, next: TerminalAuthVault, nextOwner?: TerminalAuthAccount | null): Promise<void> {
    const operation = this.writes.then(async () => {
      this.check(attempt);
      if (nextOwner !== undefined && this.state.session?.key !== nextOwner?.key) {
        await this.options.beforeAccountChange?.(this.state.session ? clone(this.state.session) : null, nextOwner ? clone(nextOwner) : null);
        this.check(attempt);
      }
      try { await this.options.secretStore.save(clone(next)); }
      catch { throw new TerminalAuthError("CREDENTIAL_STORE_UNAVAILABLE"); }
      if (attempt.epoch !== this.epoch || attempt.controller.signal.aborted) {
        // A cancellation may arrive during an atomic store write. Roll back before
        // the newer operation may read/write; never publish the stale identity.
        try { await this.options.secretStore.save(clone(this.vault)); }
        catch {
          this.storageRecoveryRequired = true;
          this.accessToken = null;
          this.accountToken = null;
          this.state.error = { code: "CREDENTIAL_STORE_UNAVAILABLE" };
          if (this.state.session) this.state.session = { ...this.state.session, status: "temporarily-unavailable", reason: "CREDENTIAL_STORE_UNAVAILABLE" };
          throw new TerminalAuthError("CREDENTIAL_STORE_UNAVAILABLE");
        }
        this.check(attempt);
      }
      this.vault = clone(next);
      this.projectAccounts();
    });
    this.writes = operation.then(() => {}, () => {});
    return operation;
  }

  private projectAccounts(): void {
    this.state.accounts = Object.entries(this.vault.accounts).map(([key, value]) => ({ key, realm: value.realm, membership: clone(value.membership) }));
  }

  private client(attempt: Attempt, realm: AuthRegion, retainRotation = false): CindyAuthClient {
    const fetch: AuthFetch = async (input, init = {}) => {
      this.check(attempt);
      const combined = new AbortController();
      const cancel = () => combined.abort();
      const cleanup = () => {
        clearTimeout(timer);
        init.signal?.removeEventListener("abort", cancel);
        if (!retainRotation) attempt.controller.signal.removeEventListener("abort", cancel);
      };
      const timer = setTimeout(cancel, this.options.requestTimeoutMs ?? 15_000);
      if (init.signal?.aborted || (!retainRotation && attempt.controller.signal.aborted)) combined.abort();
      init.signal?.addEventListener("abort", cancel, { once: true });
      if (!retainRotation) attempt.controller.signal.addEventListener("abort", cancel, { once: true });
      try {
        const pending = this.options.fetch(input, { ...init, signal: combined.signal });
        const response = retainRotation ? await pending : await this.wait(attempt, pending);
        return { ...response, headers: response.headers, ok: response.ok, status: response.status,
          json: async () => {
            try { return retainRotation ? await response.json() : await this.wait(attempt, response.json()); }
            finally { cleanup(); }
          } };
      } catch (error) { cleanup(); throw error; }
    };
    return new CindyAuthClient({ baseUrl: this.options.endpoints[realm].baseUrl, region: realm,
      deviceId: this.options.deviceId, clientType: "desktop", locale: this.options.locale, fetch });
  }

  private check(attempt: Attempt): void {
    if (attempt.epoch !== this.epoch || attempt.controller.signal.aborted) {
      throw new TerminalAuthError(attempt.timedOut ? "REQUEST_TIMEOUT" : "USER_CANCELLED");
    }
  }

  private wait<T>(attempt: Attempt, work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const aborted = () => reject(new TerminalAuthError(attempt.timedOut ? "REQUEST_TIMEOUT" : "USER_CANCELLED"));
      if (attempt.controller.signal.aborted) { void work.catch(() => {}); aborted(); return; }
      attempt.controller.signal.addEventListener("abort", aborted, { once: true });
      work.then(resolve, reject).finally(() => attempt.controller.signal.removeEventListener("abort", aborted));
    });
  }

  private pause(attempt: Attempt, milliseconds: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = () => { attempt.controller.signal.removeEventListener("abort", abort); resolve(); };
      const timer = setTimeout(done, milliseconds);
      const abort = () => { clearTimeout(timer); reject(new TerminalAuthError(attempt.timedOut ? "REQUEST_TIMEOUT" : "USER_CANCELLED")); };
      attempt.controller.signal.addEventListener("abort", abort, { once: true });
      if (attempt.controller.signal.aborted) abort();
    });
  }

  private run(work: (attempt: Attempt) => Promise<void>, keepCaptcha = false): Promise<TerminalAuthSnapshot> {
    this.attempt?.controller.abort();
    if (!keepCaptcha) this.pendingCaptcha = null;
    const attempt = { epoch: ++this.epoch, controller: new AbortController() };
    this.attempt = attempt;
    this.state.error = null;
    return (async () => {
      try {
        await this.writes;
        this.check(attempt);
        await work(attempt);
        this.check(attempt);
        this.emit();
        return this.snapshot();
      } catch (error) {
        const safe = publicError(error);
        if (attempt.epoch === this.epoch) {
          this.state.error = { code: safe.code, ...(safe.retryAt === undefined ? {} : { retryAt: safe.retryAt }) };
          this.emit();
        }
        throw safe;
      }
    })();
  }

  private emit(): void {
    try { this.options.onChange?.(this.snapshot()); } catch { /* observers cannot change auth */ }
  }
}
