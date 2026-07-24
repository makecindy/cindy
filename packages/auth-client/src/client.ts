import { z } from "zod";

import {
  accountDeletionAvailabilitySchema,
  accountDeletionChallengeSchema,
  accountDeletionStatusSchema,
  accountMembershipSchema,
  authRegionSchema,
  loginMethodSchema,
  loginOutcomeSchema,
  meResponseSchema,
  providerConfigSchema,
  ssoOrgDiscoverySchema,
  tokenPairSchema,
  type AuthClientType,
  type AccountDeletionAvailability,
  type AccountDeletionChallenge,
  type AccountDeletionStatus,
  type AccountMembership,
  type AuthMe,
  type AuthTokenPair,
  type AuthRegion,
  type LoginMethod,
  type LoginOutcome,
  type ProviderConfig,
  type SocialProvider,
  type SsoOrgDiscovery,
  type VerificationKind,
} from "./types.js";

export interface AuthFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type AuthFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<AuthFetchResponse>;

export interface AuthClientOptions {
  baseUrl: string;
  region: AuthRegion;
  deviceId: string;
  clientType: AuthClientType;
  locale?: string;
  fetch: AuthFetch;
  timeoutMs?: number;
}

/** Structured auth-server failure preserved across platform adapters. */
export class AuthApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "AuthApiError";
  }
}

const errorResponseSchema = z.object({
  error: z
    .object({ code: z.string().optional(), message: z.string().optional() })
    .optional(),
  code: z.string().optional(),
  message: z.string().optional(),
});

/** Platform-neutral REST client. It never persists or logs credentials. */
export class CindyAuthClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: AuthClientOptions) {
    // 逐字符去尾斜杠（不用 /\/+$/ 正则：CodeQL 判其在长 '/' 串上有多项式回溯）
    let baseUrl = options.baseUrl;
    while (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
    this.baseUrl = baseUrl;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    authRegionSchema.parse(options.region);
  }

  async getProviders(): Promise<ProviderConfig> {
    const providers = await this.request(
      "/api/auth/providers",
      providerConfigSchema,
    );
    if (providers.region !== this.options.region) {
      throw new AuthApiError(
        "REGION_MISMATCH",
        0,
        `Configured ${this.options.region} build received ${providers.region} auth deployment`,
      );
    }
    return providers;
  }

  async discover(email: string): Promise<LoginMethod[]> {
    const result = await this.request(
      "/api/auth/discovery",
      z.object({ methods: z.array(loginMethodSchema) }),
      { email },
    );
    return result.methods;
  }

  /** 企业 SSO 入口：组织 ID、slug 或已验证域名 → 已启用的 SSO 连接。 */
  async discoverSsoOrg(org: string): Promise<SsoOrgDiscovery> {
    const discovery = await this.request(
      "/api/auth/sso/discovery",
      ssoOrgDiscoverySchema,
      { org },
    );
    // 企业存在但未启用任何 SSO 连接（服务端可能以 200 + connections:[] 表达）：
    // 映射成精确的 ORG_SSO_NOT_FOUND（其文案已覆盖「未启用 SSO」语义），
    // 避免落到 INVALID_RESPONSE 的通用错误，也拦住空 methods 进入 method-choice。
    if (discovery.connections.length === 0) {
      throw new AuthApiError(
        "ORG_SSO_NOT_FOUND",
        200,
        "Enterprise exists but has no SSO connection enabled",
      );
    }
    return discovery;
  }

  async requestCode(kind: VerificationKind, identifier: string): Promise<void> {
    const body =
      kind === "email"
        ? { email: identifier, locale: this.options.locale }
        : { phone: identifier, locale: this.options.locale };
    await this.request(
      `/api/auth/${kind}/request-code`,
      z.object({ status: z.literal("sent") }),
      body,
    );
  }

  verifyCode(
    kind: VerificationKind,
    identifier: string,
    code: string,
  ): Promise<LoginOutcome> {
    const body = {
      ...(kind === "email" ? { email: identifier } : { phone: identifier }),
      code,
      deviceId: this.options.deviceId,
      clientType: this.options.clientType,
      locale: this.options.locale,
    };
    return this.request(
      `/api/auth/${kind}/verify-code`,
      loginOutcomeSchema,
      body,
    );
  }

  exchangeAuthorizationCode(
    code: string,
    codeVerifier: string,
  ): Promise<LoginOutcome> {
    return this.request("/api/auth/token", loginOutcomeSchema, {
      grantType: "authorization_code",
      code,
      codeVerifier,
      deviceId: this.options.deviceId,
    });
  }

  exchangeNativeSocial(
    provider: SocialProvider,
    credential:
      | { idToken: string }
      | {
          identityToken: string;
          authorizationCode?: string;
          rawNonce: string;
          user?: { name?: string };
          // Apple 首次授权的明文 email(客户端补传,消除 Guideline 4.2 索要 email)。
          email?: string | null;
        }
      | { code: string },
  ): Promise<LoginOutcome> {
    return this.request(`/api/auth/social/${provider}`, loginOutcomeSchema, {
      ...credential,
      deviceId: this.options.deviceId,
      clientType: this.options.clientType,
      locale: this.options.locale,
    });
  }

  selectAccount(loginTicket: string, accountId: string): Promise<LoginOutcome> {
    return this.request("/api/auth/select-account", loginOutcomeSchema, {
      loginTicket,
      accountId,
      deviceId: this.options.deviceId,
    });
  }

  async requestBindingCode(
    bindTicket: string,
    bindType: VerificationKind,
    contact: string,
  ): Promise<void> {
    await this.request(
      "/api/auth/binding/request-code",
      z.object({ status: z.literal("sent") }),
      {
        bindTicket,
        [bindType]: contact,
        locale: this.options.locale,
      },
    );
  }

  verifyBinding(
    bindTicket: string,
    bindType: VerificationKind,
    contact: string,
    code: string,
  ): Promise<LoginOutcome> {
    return this.request("/api/auth/binding/verify", loginOutcomeSchema, {
      bindTicket,
      [bindType]: contact,
      code,
      deviceId: this.options.deviceId,
    });
  }

  refresh(refreshToken: string): Promise<AuthTokenPair> {
    return this.request(
      "/api/auth/refresh",
      tokenPairSchema,
      {
        refreshToken,
        deviceId: this.options.deviceId,
      },
      { timeoutMs: 0 },
    );
  }

  async getAccountMemberships(
    accountToken: string,
  ): Promise<AccountMembership[]> {
    const response = await this.request(
      "/api/auth/account",
      z.object({ memberships: z.array(accountMembershipSchema) }),
      undefined,
      { token: accountToken },
    );
    return response.memberships;
  }

  exchangeAccountMembership(
    accountToken: string,
    membershipId: string,
  ): Promise<AuthTokenPair> {
    return this.request(
      "/api/auth/account/exchange",
      tokenPairSchema,
      { membershipId },
      { token: accountToken },
    );
  }

  async requestSsoVerificationCode(verificationTicket: string): Promise<void> {
    await this.request(
      "/api/auth/sso/verification/request-code",
      z.object({ status: z.literal("sent") }),
      { verificationTicket, deviceId: this.options.deviceId },
    );
  }

  verifySsoVerification(
    verificationTicket: string,
    code: string,
  ): Promise<LoginOutcome> {
    return this.request(
      "/api/auth/sso/verification/verify",
      loginOutcomeSchema,
      { verificationTicket, code, deviceId: this.options.deviceId },
    );
  }

  getMe(accessToken: string): Promise<AuthMe> {
    return this.request("/api/me", meResponseSchema, undefined, {
      token: accessToken,
    });
  }

  getAccountDeletionAvailability(
    accessToken: string,
  ): Promise<AccountDeletionAvailability> {
    return this.request(
      "/api/auth/account/deletion",
      accountDeletionAvailabilitySchema,
      undefined,
      { token: accessToken },
    );
  }

  requestAccountDeletionChallenge(
    accessToken: string,
  ): Promise<AccountDeletionChallenge> {
    return this.request(
      "/api/auth/account/deletion/challenge",
      accountDeletionChallengeSchema,
      { locale: this.options.locale },
      { token: accessToken },
    );
  }

  confirmAccountDeletion(
    accessToken: string,
    input: {
      challengeId: string;
      receiptToken: string;
      code: string;
      acknowledged: true;
    },
  ): Promise<AccountDeletionStatus> {
    return this.request(
      "/api/auth/account/deletion/confirm",
      accountDeletionStatusSchema,
      input,
      { token: accessToken },
    );
  }

  getAccountDeletionStatus(
    receiptToken: string,
  ): Promise<AccountDeletionStatus> {
    return this.request(
      "/api/auth/account/deletion/status",
      accountDeletionStatusSchema,
      { receiptToken },
    );
  }

  async logout(accessToken: string): Promise<void> {
    await this.request(
      "/api/auth/logout",
      z.object({ status: z.literal("ok") }),
      {},
      { token: accessToken },
    );
  }

  buildAuthorizeUrl(input: {
    kind: "social" | "sso";
    providerOrConnectionId: string;
    redirectUri: string;
    codeChallenge: string;
    state: string;
  }): string {
    const segment =
      input.kind === "social"
        ? `/api/auth/social/${encodeURIComponent(input.providerOrConnectionId)}/authorize`
        : `/api/auth/sso/${encodeURIComponent(input.providerOrConnectionId)}/authorize`;
    const url = new URL(this.baseUrl + segment);
    url.search = new URLSearchParams({
      client_type: this.options.clientType,
      device_id: this.options.deviceId,
      redirect_uri: input.redirectUri,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
      client_state: input.state,
      ...(this.options.locale ? { ui_locale: this.options.locale } : {}),
    }).toString();
    return url.toString();
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    requestOptions: { token?: string; timeoutMs?: number } = {},
  ): Promise<T> {
    const timeoutMs = requestOptions.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer =
      timeoutMs > 0
        ? setTimeout(() => controller.abort(), timeoutMs)
        : undefined;
    let response: AuthFetchResponse;
    try {
      response = await this.options.fetch(this.baseUrl + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          ...(requestOptions.token
            ? { Authorization: `Bearer ${requestOptions.token}` }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(timeoutMs > 0 ? { signal: controller.signal } : {}),
      });
    } catch (error) {
      const code =
        error instanceof Error && error.name === "AbortError"
          ? "REQUEST_TIMEOUT"
          : "NETWORK_ERROR";
      throw new AuthApiError(
        code,
        0,
        code === "REQUEST_TIMEOUT"
          ? "Authentication request timed out"
          : "Authentication network request failed",
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new AuthApiError(
        "INVALID_RESPONSE",
        response.status,
        "Authentication server returned invalid JSON",
      );
    }
    if (!response.ok) {
      const parsed = errorResponseSchema.safeParse(data);
      const code = parsed.success
        ? (parsed.data.error?.code ?? parsed.data.code ?? "AUTH_REQUEST_FAILED")
        : "AUTH_REQUEST_FAILED";
      const message = parsed.success
        ? (parsed.data.error?.message ??
          parsed.data.message ??
          "Authentication request failed")
        : "Authentication request failed";
      throw new AuthApiError(code, response.status, message);
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new AuthApiError(
        "INVALID_RESPONSE",
        response.status,
        "Authentication server response did not match the client contract",
      );
    }
    return parsed.data;
  }
}
