import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalAuthController, type AuthSecretStore, type TerminalAuthOptions, type TerminalAuthVault } from "./terminalAuth.js";
import { accountVaultKey } from "./accountMetadata.js";
import type { AuthFetch, AuthFetchResponse } from "./client.js";
import type { AuthMembership, AuthRegion, LoginOutcome } from "./types.js";

/* Test value: public controller actions must preserve the four login outcomes,
 * owner/realm isolation and encrypted-store transaction boundary. Existing REST
 * and reducer tests do not exercise a headless host or cancellation during save.
 * Minimal failure: delayed account A response after B takes ownership, or cancel
 * during an atomic credential write. Tier: unit, in-memory fake transport/store;
 * no real credentials, network, home directory, process or wall-clock waits.
 */
const member = (id = "one"): AuthMembership => ({ id, passportId: "fake-passport", kind: "personal", role: "owner", displayName: id, email: "person@example.invalid", orgId: null, orgName: null });
const pair = (id = "one") => ({ accessToken: `fake-access-${id}`, refreshToken: `fake-refresh-${id}`, membership: member(id) });
const ok = (id = "one"): LoginOutcome => ({ status: "ok", ...pair(id) });
const reply = (data: unknown, status = 200): AuthFetchResponse => ({ ok: status >= 200 && status < 300, status, json: async () => data });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
interface Request { realm: AuthRegion; path: string; body: Record<string, string>; signal?: AbortSignal }

function setup(input: {
  stored?: TerminalAuthVault;
  handler?: (request: Request) => AuthFetchResponse | Promise<AuthFetchResponse> | undefined;
  options?: Partial<Omit<TerminalAuthOptions, "secretStore" | "fetch">>;
  store?: AuthSecretStore;
} = {}) {
  let stored: TerminalAuthVault | null = input.stored ? structuredClone(input.stored) : null;
  const writes: TerminalAuthVault[] = [];
  const requests: Request[] = [];
  const urls: string[] = [];
  const store: AuthSecretStore = input.store ?? {
    load: async () => structuredClone(stored),
    save: async (value) => { stored = structuredClone(value); writes.push(structuredClone(value)); },
  };
  const fetch: AuthFetch = async (url, init) => {
    const parsed = new URL(url);
    const request: Request = { realm: parsed.hostname.startsWith("cn.") ? "cn" : "global", path: parsed.pathname,
      body: init?.body ? JSON.parse(init.body) : {}, signal: init?.signal };
    requests.push(request);
    const handled = await input.handler?.(request);
    if (handled) return handled;
    switch (request.path) {
      case "/api/auth/providers": return reply({ region: request.realm, email: true, phone: true, social: ["google"], attribution: "email" });
      case "/api/auth/sso/discovery": return reply({ code: "ORG_SSO_NOT_FOUND" }, 404);
      case "/api/auth/discovery": return reply({ methods: [{ type: "email_code" }] });
      case "/api/auth/email/request-code":
      case "/api/auth/phone/request-code":
      case "/api/auth/binding/request-code":
      case "/api/auth/sso/verification/request-code": return reply({ status: "sent" });
      case "/api/auth/email/verify-code":
      case "/api/auth/phone/verify-code":
      case "/api/auth/token": return reply(ok());
      case "/api/auth/desktop/callback/poll": return reply({ status: "ok", code: "fake-code" });
      case "/api/auth/refresh": return reply(pair(request.body.refreshToken.endsWith("two") ? "two" : "one"));
      case "/api/auth/logout":
      case "/api/auth/account/logout": return reply({ status: "ok" });
      default: throw new Error(`Unexpected fake endpoint ${request.path}`);
    }
  };
  const controller = new TerminalAuthController({
    deviceId: "fake-terminal-device", region: "global", fetch, secretStore: store,
    endpoints: {
      cn: { baseUrl: "https://cn.example.invalid", hostedCallbackUrl: "https://cn.example.invalid/api/auth/desktop/callback" },
      global: { baseUrl: "https://global.example.invalid", hostedCallbackUrl: "https://global.example.invalid/api/auth/desktop/callback" },
    },
    onAuthorizeUrl: ({ url }) => { urls.push(url); },
    ...input.options,
  });
  return { controller, requests, urls, writes, stored: () => structuredClone(stored) };
}

async function prepareEmail(controller: TerminalAuthController) {
  await controller.beginLogin();
  await controller.discoverEmail("person@example.invalid");
  await controller.requestCode("email", "person@example.invalid");
}

function savedAccounts(active = "one"): TerminalAuthVault {
  const accounts = Object.fromEntries(["one", "two"].map((id) => [accountVaultKey("global", id), {
    realm: "global" as const, membership: member(id), refreshToken: `fake-refresh-${id}`, accountRefreshToken: "fake-account-refresh",
  }]));
  return { version: 1, activeAccount: accountVaultKey("global", active), accounts };
}

function captchaProviders(request: Request) {
  return request.path === "/api/auth/providers" ? reply({ region: "global", email: true, phone: true, social: [], attribution: "email",
    captcha: { provider: "turnstile", siteKey: "fake-site-key", requiredFor: ["email_request_code", "phone_request_code"] } }) : undefined;
}

async function prepareCaptcha(controller: TerminalAuthController) {
  await controller.beginLogin();
  await controller.discoverEmail("person@example.invalid");
  return controller.startCaptcha("email", "person@example.invalid", { theme: "dark", lang: "zh-CN" });
}

afterEach(() => vi.useRealTimers());

describe("TerminalAuthController", () => {
  it("logs in, persists only refresh credentials and restores with the original realm", async () => {
    const host = setup();
    await prepareEmail(host.controller);
    const state = await host.controller.verifyCode("fake-123456");
    expect(state.session).toMatchObject({ status: "authenticated", realm: "global", membership: { id: "one" } });
    expect(host.controller.getAccessToken()).toBe("fake-access-one");
    expect(JSON.stringify(state)).not.toMatch(/fake-access|fake-refresh|fake-123456/);
    expect(JSON.stringify(host.stored())).not.toContain("fake-access");
    const restarted = setup({ stored: host.stored()! });
    expect((await restarted.controller.initialize()).session?.status).toBe("authenticated");
    expect(restarted.requests[0]).toMatchObject({ realm: "global", path: "/api/auth/refresh", body: { refreshToken: "fake-refresh-one" } });
  });

  it.each(["oidc", "saml", "cas"] as const)("runs %s through hosted PKCE without a local browser", async (protocol) => {
    const host = setup({ handler: (request) => {
      if (request.path === "/api/auth/sso/discovery" && request.realm === "cn") return reply({ region: "cn", orgName: "Fake Enterprise", connections: [{ connectionId: "fake-connection", connectionName: "Work", protocol }] });
    } });
    await host.controller.beginLogin();
    expect((await host.controller.discoverOrganization("enterprise.invalid")).flow?.step).toBe("realm-confirmation");
    await expect(host.controller.authorize("sso", "fake-connection")).rejects.toMatchObject({ code: "INVALID_AUTH_ACTION" });
    await host.controller.confirmRealm(true);
    expect((await host.controller.authorize("sso", "fake-connection")).session?.realm).toBe("cn");
    const url = new URL(host.urls[0]);
    const poll = host.requests.find((request) => request.path.endsWith("/poll"))!;
    const exchange = host.requests.find((request) => request.path === "/api/auth/token")!;
    const digest = async (text: string) => {
      const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
      return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    };
    expect(url.searchParams.get("code_challenge")).toBe(await digest(exchange.body.codeVerifier));
    expect(url.searchParams.get("client_state")).toBe(await digest(poll.body.pollSecret));
    expect(url.searchParams.get("client_state")).not.toBe(poll.body.pollSecret);
    expect(url.searchParams.get("client_type")).toBe("desktop");
    expect(JSON.stringify(host.controller.snapshot())).not.toMatch(/fake-code|codeVerifier|pollSecret/);
  });

  it("follows binding → SSO verification → legacy account selection → completed", async () => {
    const host = setup({ handler: (request) => {
      if (request.path === "/api/auth/token") return reply({ status: "binding_required", bindType: "email", bindTicket: "fake-bind-ticket" });
      if (request.path === "/api/auth/binding/verify") return reply({ status: "sso_verification_required", verificationTicket: "fake-verification-ticket", channel: "sms", targetMasked: "+1***" });
      if (request.path === "/api/auth/sso/verification/verify") return reply({ status: "select_account", loginTicket: "fake-login-ticket", accounts: [member()] });
      if (request.path === "/api/auth/select-account") return reply(ok());
    } });
    await host.controller.beginLogin();
    expect((await host.controller.authorize("social", "google")).flow?.step).toBe("binding");
    await host.controller.requestBindingCode("person@example.invalid");
    expect((await host.controller.verifyBinding("fake-bind-code")).flow?.step).toBe("sso-verification");
    await host.controller.requestSsoVerificationCode();
    expect((await host.controller.verifySsoVerification("fake-sms-code")).flow?.step).toBe("account-selection");
    await expect(host.controller.selectAccount("not-offered")).rejects.toMatchObject({ code: "INVALID_AUTH_ACTION" });
    expect((await host.controller.selectAccount("one")).session?.membership.id).toBe("one");
    expect(host.requests.find((request) => request.path.endsWith("select-account"))?.body.loginTicket).toBe("fake-login-ticket");
    await expect(host.controller.verifyBinding("replay")).rejects.toMatchObject({ code: "INVALID_AUTH_ACTION" });
  });

  it("uses account-token membership exchange without exposing it to the TUI", async () => {
    const host = setup({ handler: (request) => {
      if (request.path === "/api/auth/email/verify-code") return reply({ status: "select_account", loginTicket: "fake-unused-ticket", accounts: [member()], accountToken: "fake-account-access", accountRefreshToken: "fake-account-refresh" });
      if (request.path === "/api/auth/account/exchange") return reply(pair());
    } });
    await prepareEmail(host.controller);
    await host.controller.verifyCode("fake-code");
    const state = await host.controller.selectAccount("one");
    expect(state.session?.status).toBe("authenticated");
    expect(host.stored()?.accounts[accountVaultKey("global", "one")].accountRefreshToken).toBe("fake-account-refresh");
    expect(host.requests.some((request) => request.path.endsWith("select-account"))).toBe(false);
    expect(JSON.stringify(state)).not.toContain("fake-account");
  });

  it("cancels a browser attempt and never accepts its late reply into a newer login", async () => {
    const started = deferred<void>();
    const delayed = deferred<AuthFetchResponse>();
    const host = setup({ handler: (request) => {
      if (request.path.endsWith("/poll")) { started.resolve(); return delayed.promise; }
    } });
    await host.controller.beginLogin();
    const old = host.controller.authorize("social", "google").catch((error) => error);
    await started.promise;
    await host.controller.cancel();
    await prepareEmail(host.controller);
    await host.controller.verifyCode("new-code");
    delayed.resolve(reply({ status: "ok", code: "old-code" }));
    expect(await old).toMatchObject({ code: "USER_CANCELLED" });
    expect(host.requests.filter((request) => request.path === "/api/auth/token")).toHaveLength(0);
    expect(host.controller.snapshot().session?.status).toBe("authenticated");
  });

  it("rolls back a cancelled credential commit before a newer operation can continue", async () => {
    const writing = deferred<void>();
    const release = deferred<void>();
    let saved: TerminalAuthVault | null = null;
    let count = 0;
    const host = setup({ store: {
      load: async () => null,
      save: async (value) => {
        if (++count === 1) { writing.resolve(); await release.promise; }
        saved = structuredClone(value);
      },
    } });
    await prepareEmail(host.controller);
    const old = host.controller.verifyCode("fake-code").catch((error) => error);
    await writing.promise;
    const cancelling = host.controller.cancel();
    release.resolve();
    await cancelling;
    expect(await old).toMatchObject({ code: "USER_CANCELLED" });
    expect(saved).toEqual({ version: 1, activeAccount: null, accounts: {} });
    expect(host.controller.snapshot().session).toBeNull();
    expect(host.controller.getAccessToken()).toBeNull();
  });

  it("fences a stale refresh when switching to another stored account", async () => {
    const started = deferred<void>();
    const delayed = deferred<AuthFetchResponse>();
    let block = false;
    const host = setup({ stored: savedAccounts(), handler: (request) => {
      if (block && request.path === "/api/auth/refresh" && request.body.refreshToken.endsWith("one")) { started.resolve(); return delayed.promise; }
    } });
    await host.controller.initialize();
    block = true;
    const old = host.controller.refresh().catch((error) => error);
    await started.promise;
    await host.controller.switchAccount(accountVaultKey("global", "two"));
    delayed.resolve(reply(pair("one")));
    expect(await old).toMatchObject({ code: "USER_CANCELLED" });
    expect(host.controller.getAccessToken()).toBe("fake-access-two");
    expect(host.stored()?.activeAccount).toBe(accountVaultKey("global", "two"));
  });

  it("retains a cancelled account's rotated refresh token without reclaiming active ownership", async () => {
    const started = deferred<void>();
    const delayed = deferred<AuthFetchResponse>();
    const savedRotation = deferred<void>();
    let disk = savedAccounts();
    let block = false;
    const host = setup({ store: {
      load: async () => structuredClone(disk),
      save: async (next) => {
        disk = structuredClone(next);
        if (disk.accounts[accountVaultKey("global", "one")]?.refreshToken === "fake-rotated-one") savedRotation.resolve();
      },
    }, handler: (request) => {
      if (block && request.path === "/api/auth/refresh" && request.body.refreshToken === "fake-refresh-one") { started.resolve(); return delayed.promise; }
    } });
    await host.controller.initialize();
    block = true;
    const old = host.controller.refresh().catch((error) => error);
    await started.promise;
    await host.controller.switchAccount(accountVaultKey("global", "two"));
    delayed.resolve(reply({ ...pair(), refreshToken: "fake-rotated-one" }));
    await savedRotation.promise;
    expect(await old).toMatchObject({ code: "USER_CANCELLED" });
    expect(disk.activeAccount).toBe(accountVaultKey("global", "two"));
    expect(disk.accounts[accountVaultKey("global", "one")].refreshToken).toBe("fake-rotated-one");
    expect(host.controller.getAccessToken()).toBe("fake-access-two");
  });

  it("retains credentials during outages, shares refresh work and enforces backoff", async () => {
    let now = 0;
    let fail = true;
    const host = setup({ stored: savedAccounts(), options: { now: () => now }, handler: (request) => {
      if (request.path === "/api/auth/refresh" && fail) return reply({ code: "RATE_LIMITED", message: "private server details" }, 429);
    } });
    await expect(host.controller.initialize()).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(host.controller.snapshot().session?.status).toBe("temporarily-unavailable");
    expect(host.stored()?.accounts).toEqual(savedAccounts().accounts);
    await host.controller.refresh();
    expect(host.requests).toHaveLength(1);
    now = 60_001;
    fail = false;
    const a = host.controller.refresh();
    const b = host.controller.refresh();
    expect(a).toBe(b);
    await a;
    expect(host.controller.snapshot().session?.status).toBe("authenticated");
    expect(host.requests).toHaveLength(2);
    expect(JSON.stringify(host.controller.snapshot())).not.toContain("private server");
  });

  it.each(["MEMBERSHIP_DISABLED", "REFRESH_TOKEN_EXPIRED", "INVALID_REFRESH_TOKEN", "DEVICE_MISMATCH"])("handles %s without deleting a foreign device's credential", async (code) => {
    const host = setup({ stored: savedAccounts(), handler: (request) => request.path === "/api/auth/refresh" ? reply({ code }, 401) : undefined });
    await expect(host.controller.initialize()).rejects.toMatchObject({ code });
    expect(host.controller.snapshot().session).toMatchObject({ status: "reauthentication-required", reason: code });
    expect(host.controller.getAccessToken()).toBeNull();
    expect(Boolean(host.stored()?.accounts[accountVaultKey("global", "one")])).toBe(code === "DEVICE_MISMATCH");
    expect(host.stored()?.accounts[accountVaultKey("global", "two")]).toBeDefined();
  });

  it("rejects a refresh that returns a different membership", async () => {
    const host = setup({ stored: savedAccounts(), handler: (request) => request.path === "/api/auth/refresh" ? reply(pair("two")) : undefined });
    await expect(host.controller.initialize()).rejects.toMatchObject({ code: "ACCOUNT_IDENTITY_MISMATCH" });
    expect(host.stored()?.activeAccount).toBe(accountVaultKey("global", "one"));
    expect(host.controller.getAccessToken()).toBeNull();
  });

  it("rotates the passport refresh token for all same-passport memberships and switches via the server", async () => {
    const host = setup({ stored: savedAccounts(), handler: (request) => {
      if (request.path === "/api/auth/account/refresh") return reply({ accountToken: "fake-account-access", accountRefreshToken: "fake-account-rotated" });
      if (request.path === "/api/auth/account") return reply({ memberships: [{ ...member("one"), orgSlug: null }, { ...member("two"), orgSlug: null }] });
      if (request.path === "/api/auth/account/exchange") return reply(pair(request.body.membershipId));
    } });
    await host.controller.initialize();
    expect(await host.controller.memberships()).toHaveLength(2);
    expect(Object.values(host.stored()!.accounts).map((account) => account.accountRefreshToken)).toEqual(["fake-account-rotated", "fake-account-rotated"]);
    const result = await host.controller.switchMembership("two");
    expect(result.session?.membership.id).toBe("two");
  });

  it("does not grant a fresh identity when the owner boundary rejects it", async () => {
    const beforeAccountChange = vi.fn(async () => { throw new Error("fake host still stopping"); });
    const host = setup({ options: { beforeAccountChange } });
    await prepareEmail(host.controller);
    await expect(host.controller.verifyCode("fake-code")).rejects.toMatchObject({ code: "AUTH_REQUEST_FAILED" });
    expect(host.writes).toHaveLength(0);
    expect(host.controller.snapshot().session).toBeNull();
  });

  it("keeps pending verification tickets after rate limiting and never publishes their values", async () => {
    let limited = true;
    const host = setup({ handler: (request) => {
      if (request.path === "/api/auth/token") return reply({ status: "sso_verification_required", channel: "email", targetMasked: "p***", verificationTicket: "fake-secret-ticket" });
      if (request.path === "/api/auth/sso/verification/verify") return limited
        ? reply({ code: "RATE_LIMITED", message: "fake-secret-ticket" }, 429) : reply(ok());
    } });
    await host.controller.beginLogin();
    await host.controller.authorize("social", "google");
    await host.controller.requestSsoVerificationCode();
    await expect(host.controller.verifySsoVerification("fake-code")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(host.controller.snapshot().flow?.step).toBe("sso-verification");
    expect(JSON.stringify(host.controller.snapshot())).not.toContain("fake-secret-ticket");
    limited = false;
    expect((await host.controller.verifySsoVerification("fake-code-2")).session?.status).toBe("authenticated");
  });

  it("requires CAPTCHA without fabricating a challenge result", async () => {
    const events: unknown[] = [];
    const host = setup({ handler: captchaProviders, options: { onChange: (state) => events.push(state) } });
    await host.controller.beginLogin();
    await host.controller.discoverEmail("person@example.invalid");
    await expect(host.controller.requestCode("email", "person@example.invalid")).rejects.toMatchObject({ code: "CAPTCHA_REQUIRED" });
    expect(host.requests.some((request) => request.path.endsWith("request-code"))).toBe(false);
    const challenge = await host.controller.startCaptcha("email", "person@example.invalid", { theme: "dark", lang: "zh-CN" });
    expect(challenge.url).toBe("https://global.example.invalid/captcha/turnstile?action=email_request_code&theme=dark&lang=zh-CN");
    const state = await host.controller.completeCaptcha(challenge.id, `${challenge.url}#cindy-captcha=ok.fake%2Bexternal%2Fcaptcha`);
    expect(host.requests.at(-1)?.body).toMatchObject({ email: "person@example.invalid", captchaToken: "fake+external/captcha" });
    expect(state.flow?.step).toBe("verification-code");
    expect(JSON.stringify([events, challenge, state, host.stored()])).not.toContain("fake+external/captcha");
    await expect(host.controller.completeCaptcha(challenge.id, `${challenge.url}#cindy-captcha=ok.replay`)).rejects.toMatchObject({ code: "CAPTCHA_ATTEMPT_INVALID" });
    expect(host.requests.filter((request) => request.path.endsWith("request-code"))).toHaveLength(1);
  });

  it.each([
    ["origin", (url: string) => url.replace("global.example.invalid", "evil.example.invalid")],
    ["scheme", (url: string) => `blob:${url}`],
    ["path", (url: string) => url.replace("/captcha/turnstile", "/captcha/other")],
    ["action", (url: string) => url.replace("email_request_code", "phone_request_code")],
    ["duplicate action", (url: string) => `${url}&action=email_request_code`],
    ["extra parameter", (url: string) => `${url}&redirect=https://evil.example.invalid`],
    ["theme", (url: string) => url.replace("theme=dark", "theme=light")],
    ["userinfo", (url: string) => url.replace("https://", "https://attacker@")],
  ] as const)("rejects a CAPTCHA return with an unexpected %s without consuming the real challenge", async (_, change) => {
    const host = setup({ handler: captchaProviders });
    const challenge = await prepareCaptcha(host.controller);
    await expect(host.controller.completeCaptcha(challenge.id, `${change(challenge.url)}#cindy-captcha=ok.fake-token`)).rejects.toMatchObject({ code: "CAPTCHA_RETURN_INVALID" });
    expect(host.requests.some((request) => request.path.endsWith("request-code"))).toBe(false);
    await host.controller.completeCaptcha(challenge.id, `${challenge.url}#cindy-captcha=ok.fake-valid-token`);
    expect(host.requests.at(-1)?.body.captchaToken).toBe("fake-valid-token");
  });

  it("rejects malformed CAPTCHA payloads without disclosing or consuming them", async () => {
    const events: unknown[] = [];
    const host = setup({ handler: captchaProviders, options: { onChange: (state) => events.push(state) } });
    const challenge = await prepareCaptcha(host.controller);
    for (const payload of ["ok.", "ok.%E0%A4%A", "ok.%00fake-secret", `ok.${"x".repeat(2049)}`, "err.<fake-secret>"]) {
      await expect(host.controller.completeCaptcha(challenge.id, `${challenge.url}#cindy-captcha=${payload}`)).rejects.toMatchObject({ code: "CAPTCHA_RETURN_INVALID" });
    }
    await expect(host.controller.completeCaptcha(challenge.id, `${challenge.url}\n#cindy-captcha=ok.fake-secret`)).rejects.toMatchObject({ code: "CAPTCHA_RETURN_INVALID" });
    expect(JSON.stringify(events)).not.toContain("fake-secret");
    await host.controller.completeCaptcha(challenge.id, `${challenge.url}#cindy-captcha=ok.fake-valid-token`);
  });

  it("expires, cancels and replaces CAPTCHA challenges independently of their browser page", async () => {
    let now = 1000;
    const host = setup({ handler: captchaProviders, options: { now: () => now } });
    const expired = await prepareCaptcha(host.controller);
    now = expired.expiresAt;
    await expect(host.controller.completeCaptcha(expired.id, `${expired.url}#cindy-captcha=ok.fake-token`)).rejects.toMatchObject({ code: "CAPTCHA_EXPIRED" });
    const cancelled = await host.controller.startCaptcha("email", "person@example.invalid");
    await host.controller.cancel();
    await expect(host.controller.completeCaptcha(cancelled.id, `${cancelled.url}#cindy-captcha=ok.fake-token`)).rejects.toMatchObject({ code: "CAPTCHA_ATTEMPT_INVALID" });
    const replaced = await prepareCaptcha(host.controller);
    const current = await host.controller.startCaptcha("email", "person@example.invalid");
    expect(current.id).not.toBe(replaced.id);
    await expect(host.controller.completeCaptcha(replaced.id, `${replaced.url}#cindy-captcha=ok.fake-token`)).rejects.toMatchObject({ code: "CAPTCHA_ATTEMPT_INVALID" });
    await host.controller.completeCaptcha(current.id, `${current.url}#cindy-captcha=ok.fake-current-token`);
    expect(host.requests.at(-1)?.body.captchaToken).toBe("fake-current-token");
  });

  it.each([["expired", "CAPTCHA_EXPIRED"], ["cancelled", "USER_CANCELLED"], ["fake-secret", "CAPTCHA_FAILED"]])("consumes a %s CAPTCHA failure and only publishes a fixed code", async (reason, code) => {
    const events: unknown[] = [];
    const host = setup({ handler: captchaProviders, options: { onChange: (state) => events.push(state) } });
    const challenge = await prepareCaptcha(host.controller);
    await expect(host.controller.completeCaptcha(challenge.id, `${challenge.url}#cindy-captcha=err.${reason}`)).rejects.toMatchObject({ code });
    expect(JSON.stringify(events)).not.toContain("fake-secret");
    await expect(host.controller.completeCaptcha(challenge.id, `${challenge.url}#cindy-captcha=ok.replay`)).rejects.toMatchObject({ code: "CAPTCHA_ATTEMPT_INVALID" });
    expect(host.requests.some((request) => request.path.endsWith("request-code"))).toBe(false);
  });

  it("consumes a CAPTCHA token before transport and rejects replay without aborting its request", async () => {
    const started = deferred<void>();
    const response = deferred<AuthFetchResponse>();
    const host = setup({ handler: (request) => {
      if (request.path.endsWith("request-code")) { started.resolve(); return response.promise; }
      return captchaProviders(request);
    } });
    const challenge = await prepareCaptcha(host.controller);
    const pending = host.controller.completeCaptcha(challenge.id, `${challenge.url}#cindy-captcha=ok.fake-token`);
    await started.promise;
    await expect(host.controller.completeCaptcha(challenge.id, `${challenge.url}#cindy-captcha=ok.replay`)).rejects.toMatchObject({ code: "CAPTCHA_ATTEMPT_INVALID" });
    expect(host.requests.at(-1)?.signal?.aborted).toBe(false);
    response.resolve(reply({ code: "CAPTCHA_INVALID", message: "fake-token" }, 400));
    await expect(pending).rejects.toMatchObject({ code: "CAPTCHA_INVALID" });
    await expect(host.controller.completeCaptcha(challenge.id, `${challenge.url}#cindy-captcha=ok.replay`)).rejects.toMatchObject({ code: "CAPTCHA_ATTEMPT_INVALID" });
    expect(host.requests.filter((request) => request.path.endsWith("request-code"))).toHaveLength(1);
    expect(JSON.stringify(host.controller.snapshot())).not.toContain("fake-token");
  });

  it("uses the phone action and refuses an unnecessary or insecure CAPTCHA page", async () => {
    const host = setup({ handler: captchaProviders });
    await host.controller.beginLogin();
    const challenge = await host.controller.startCaptcha("phone", "+15555550123");
    expect(challenge.action).toBe("phone_request_code");
    await host.controller.completeCaptcha(challenge.id, `${challenge.url}#cindy-captcha=ok.fake-phone-token`);
    expect(host.requests.at(-1)?.body).toMatchObject({ phone: "+15555550123", captchaToken: "fake-phone-token" });
    const ordinary = setup();
    await ordinary.controller.beginLogin();
    await expect(ordinary.controller.startCaptcha("phone", "+15555550123")).rejects.toMatchObject({ code: "CAPTCHA_NOT_REQUIRED" });
    const insecure = setup({ handler: captchaProviders, options: { endpoints: { cn: { baseUrl: "https://cn.example.invalid" }, global: { baseUrl: "http://global.example.invalid" } } } });
    await insecure.controller.beginLogin();
    await expect(insecure.controller.startCaptcha("phone", "+15555550123")).rejects.toMatchObject({ code: "CAPTCHA_UNAVAILABLE" });
  });

  it("quiesces only identity changes and not successful renewal of the same account", async () => {
    const changes: Array<[string | null, string | null]> = [];
    const host = setup({ stored: savedAccounts(), options: { beforeAccountChange: async (previous, next) => { changes.push([previous?.key ?? null, next?.key ?? null]); } } });
    const one = accountVaultKey("global", "one");
    const two = accountVaultKey("global", "two");
    await host.controller.initialize();
    await host.controller.refresh();
    await host.controller.switchAccount(one);
    expect(changes).toEqual([[null, one]]);
    await host.controller.switchAccount(two);
    await host.controller.logout();
    expect(changes).toEqual([[null, one], [one, two], [two, null]]);
  });

  it("enforces forced SSO even if the server lists an email method", async () => {
    const host = setup({ handler: (request) => request.path === "/api/auth/discovery" ? reply({ methods: [{ type: "email_code" }, { type: "sso", connectionId: "forced", protocol: "oidc", orgName: "Work", connectionName: "Work", ssoRequired: true }] }) : undefined });
    await host.controller.beginLogin();
    await host.controller.discoverEmail("person@example.invalid");
    await expect(host.controller.requestCode("email", "person@example.invalid")).rejects.toMatchObject({ code: "SSO_REQUIRED" });
    await expect(host.controller.startCaptcha("email", "person@example.invalid")).rejects.toMatchObject({ code: "SSO_REQUIRED" });
    expect(host.requests.some((request) => request.path.endsWith("request-code"))).toBe(false);
  });

  it("distinguishes absent hosted callback and expired authorization from a successful login", async () => {
    const missing = setup({ options: { endpoints: { cn: { baseUrl: "https://cn.example.invalid" }, global: { baseUrl: "https://global.example.invalid" } } } });
    await missing.controller.beginLogin();
    await expect(missing.controller.authorize("social", "google")).rejects.toMatchObject({ code: "HOSTED_CALLBACK_UNAVAILABLE" });
    expect(missing.urls).toHaveLength(0);
    const expired = setup({ handler: (request) => request.path.endsWith("/poll") ? reply({ status: "expired" }) : undefined });
    await expired.controller.beginLogin();
    await expect(expired.controller.authorize("social", "google")).rejects.toMatchObject({ code: "INVALID_AUTH_CODE" });
    expect(expired.controller.snapshot().session).toBeNull();
  });

  it("times out a stalled authorization URL presenter and cancels its signal", async () => {
    vi.useFakeTimers();
    const shown = deferred<AbortSignal>();
    const host = setup({ options: { authorizationTimeoutMs: 1000, onAuthorizeUrl: ({ signal }) => { shown.resolve(signal); return new Promise(() => {}); } } });
    await host.controller.beginLogin();
    const pending = host.controller.authorize("social", "google").catch((error) => error);
    const signal = await shown.promise;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ code: "REQUEST_TIMEOUT" });
    expect(signal.aborted).toBe(true);
    expect(host.controller.snapshot().session).toBeNull();
  });

  it("refuses malformed or unavailable secret stores without overwriting them", async () => {
    const save = vi.fn();
    const broken = setup({ store: { load: async () => ({ version: 1, activeAccount: "foreign", accounts: {} }), save } });
    await expect(broken.controller.initialize()).rejects.toMatchObject({ code: "CREDENTIAL_STORE_INVALID" });
    const unavailable = setup({ store: { load: async () => { throw new Error("secret details"); }, save } });
    await expect(unavailable.controller.beginLogin()).rejects.toMatchObject({ code: "CREDENTIAL_STORE_UNAVAILABLE" });
    expect(save).not.toHaveBeenCalled();
  });

  it("removes only the active local account and still reports remote logout failure", async () => {
    const host = setup({ stored: savedAccounts(), handler: (request) => request.path === "/api/auth/logout" ? reply({ code: "NETWORK_ERROR" }, 503) : undefined });
    await host.controller.initialize();
    await expect(host.controller.logout()).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(host.controller.snapshot().session).toBeNull();
    expect(host.stored()?.activeAccount).toBeNull();
    expect(Object.keys(host.stored()!.accounts)).toEqual([accountVaultKey("global", "two")]);
  });

  it("keeps an already authenticated passport separate from an abandoned account-selection attempt", async () => {
    let accountRefreshes = 0;
    const host = setup({ stored: savedAccounts(), handler: (request) => {
      if (request.path === "/api/auth/account/refresh") { accountRefreshes++; return reply({ accountToken: "fake-original-passport", accountRefreshToken: "fake-rotated-original" }); }
      if (request.path === "/api/auth/account") return reply({ memberships: [{ ...member(), orgSlug: null }] });
      if (request.path === "/api/auth/email/verify-code") return reply({ status: "select_account", loginTicket: "fake-new-login", accounts: [member("two")], accountToken: "fake-uncommitted-passport", accountRefreshToken: "fake-uncommitted-refresh" });
    } });
    await host.controller.initialize();
    await host.controller.memberships();
    await prepareEmail(host.controller);
    await host.controller.verifyCode("fake-code");
    await host.controller.cancel();
    await host.controller.memberships();
    expect(accountRefreshes).toBe(1);
    expect(host.controller.getAccessToken()).toBe("fake-access-one");
    expect(host.stored()?.activeAccount).toBe(accountVaultKey("global", "one"));
    expect(JSON.stringify(host.stored())).not.toContain("uncommitted");
  });

  it("declining an optional cross-realm enterprise offer commits the original personal login", async () => {
    const host = setup({ handler: (request) => {
      if (request.path === "/api/auth/sso/discovery" && request.realm === "cn") return reply({ region: "cn", orgName: "Work", connections: [{ connectionId: "fake-work", connectionName: "Work", protocol: "oidc" }] });
    } });
    await host.controller.beginLogin();
    const offer = await host.controller.authorize("social", "google");
    expect(offer.flow).toMatchObject({ step: "realm-confirmation", personalLoginAvailable: true, targetRegion: "cn" });
    expect(host.writes).toHaveLength(0);
    expect((await host.controller.confirmRealm(false)).session?.realm).toBe("global");
    expect(host.stored()?.accounts[accountVaultKey("global", "one")]).toBeDefined();
  });

  it("does not retry a rate-limited hosted callback or lose its server deadline", async () => {
    const host = setup({ handler: (request) => request.path.endsWith("/poll")
      ? { ...reply({ code: "RATE_LIMITED" }, 429), headers: { get: (name) => name === "retry-after" ? "120" : null } }
      : undefined });
    await host.controller.beginLogin();
    await expect(host.controller.authorize("social", "google")).rejects.toMatchObject({ code: "RATE_LIMITED", retryAt: expect.any(Number) });
    expect(host.requests.filter((request) => request.path.endsWith("/poll"))).toHaveLength(1);
    expect(host.controller.snapshot().error?.retryAt).toBeGreaterThan(Date.now());
  });

  it("does not publish a successful login when encrypted persistence rejects", async () => {
    const host = setup({ store: { load: async () => null, save: async () => { throw new Error("fake secret backend unavailable"); } } });
    await prepareEmail(host.controller);
    await expect(host.controller.verifyCode("fake-code")).rejects.toMatchObject({ code: "CREDENTIAL_STORE_UNAVAILABLE" });
    expect(host.controller.snapshot().session).toBeNull();
    expect(host.controller.getAccessToken()).toBeNull();
    expect(host.controller.snapshot().flow?.step).toBe("verification-code");
  });

  it("repairs failed rollback from the last committed vault, never adopts the cancelled account", async () => {
    const writing = deferred<void>();
    const release = deferred<void>();
    let disk: TerminalAuthVault | null = null;
    let count = 0;
    let backendFailed = true;
    const host = setup({ store: {
      load: async () => disk,
      save: async (value) => {
        if (++count === 1) { writing.resolve(); await release.promise; disk = structuredClone(value); return; }
        if (backendFailed) throw new Error("fake rollback failure");
        disk = structuredClone(value);
      },
    } });
    await prepareEmail(host.controller);
    const login = host.controller.verifyCode("fake-code").catch((error) => error);
    await writing.promise;
    const cancelled = host.controller.cancel();
    release.resolve();
    await cancelled;
    expect(await login).toMatchObject({ code: "CREDENTIAL_STORE_UNAVAILABLE" });
    await expect(host.controller.beginLogin()).rejects.toMatchObject({ code: "CREDENTIAL_STORE_UNAVAILABLE" });
    backendFailed = false;
    await host.controller.beginLogin();
    expect(disk).toEqual({ version: 1, activeAccount: null, accounts: {} });
    expect(host.controller.snapshot().session).toBeNull();
  });
});
