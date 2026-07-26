import { describe, expect, it, vi } from "vitest";

import {
  CindyAuthClient,
  reduceAuthFlow,
  ssoOrgDiscoveryToMethods,
  type AuthFetch,
  type AuthFetchResponse,
} from "../index.js";

function response(status: number, data: unknown): AuthFetchResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function client(fetch = vi.fn(async () => response(200, {}))) {
  return new CindyAuthClient({
    baseUrl: "https://auth.example.com/",
    region: "cn",
    deviceId: "device-1",
    clientType: "desktop",
    locale: "zh-CN",
    fetch,
  });
}

describe("CindyAuthClient", () => {
  it("validates provider region and normalizes the base URL", async () => {
    const fetch = vi.fn(async () =>
      response(200, {
        region: "cn",
        attribution: "phone",
        email: true,
        phone: true,
        social: ["apple"],
      }),
    );
    await expect(client(fetch).getProviders()).resolves.toMatchObject({
      region: "cn",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://auth.example.com/api/auth/providers",
      expect.anything(),
    );
  });

  it("fails closed on a region mismatch", async () => {
    const fetch = vi.fn(async () =>
      response(200, {
        region: "global",
        attribution: "email",
        email: true,
        phone: false,
        social: ["google"],
      }),
    );
    await expect(client(fetch).getProviders()).rejects.toMatchObject({
      code: "REGION_MISMATCH",
    });
  });

  it("parses all auth-server outcome states", async () => {
    const outcomes = [
      { status: "binding_required", bindType: "phone", bindTicket: "bind-1" },
      {
        status: "sso_verification_required",
        verificationTicket: "sso-ticket-1",
        channel: "email",
        targetMasked: "a***@example.com",
      },
      {
        status: "select_account",
        loginTicket: "login-1",
        accountToken: "account-access",
        accountRefreshToken: "account-refresh",
        accounts: [
          {
            id: "m1",
            kind: "personal",
            role: "owner",
            displayName: "Cindy",
            email: null,
            orgId: null,
            orgName: null,
          },
        ],
      },
      {
        status: "ok",
        accountDeletionRestored: true,
        accessToken: "access",
        refreshToken: "refresh",
        membership: {
          id: "m1",
          passportId: "p1",
          kind: "personal",
          role: "owner",
          displayName: "Cindy",
          email: null,
          orgId: null,
          orgName: null,
        },
      },
    ];
    const fetch = vi.fn(async () => response(200, outcomes.shift()));
    await expect(
      client(fetch).verifyCode("email", "a@example.com", "123456"),
    ).resolves.toMatchObject({ status: "binding_required" });
    await expect(
      client(fetch).verifyCode("phone", "+8613800000000", "123456"),
    ).resolves.toMatchObject({ status: "sso_verification_required" });
    await expect(
      client(fetch).verifyCode("phone", "+8613800000000", "123456"),
    ).resolves.toMatchObject({ status: "select_account" });
    await expect(
      client(fetch).selectAccount("login-1", "m1"),
    ).resolves.toMatchObject({
      status: "ok",
      accountDeletionRestored: true,
    });
  });

  it("keeps Apple native login compatible when the SDK omits authorizationCode", async () => {
    const fetch = vi.fn<AuthFetch>(async () =>
      response(200, {
        status: "binding_required",
        bindType: "email",
        bindTicket: "bind-apple",
      }),
    );
    const auth = client(fetch);

    await expect(
      auth.exchangeNativeSocial("apple", {
        identityToken: "identity-token",
        rawNonce: "raw-nonce-placeholder",
      }),
    ).resolves.toMatchObject({ status: "binding_required" });

    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      identityToken: "identity-token",
      rawNonce: "raw-nonce-placeholder",
    });
    expect(body).not.toHaveProperty("authorizationCode");
  });

  it("uses an authenticated challenge and an unauthenticated receipt for account deletion", async () => {
    const pending = {
      status: "pending" as const,
      requestedAt: "2026-07-22T00:00:00.000Z",
      deleteAfter: "2026-08-21T00:00:00.000Z",
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(200, {
          available: true,
          verification: {
            channel: "email",
            maskedTarget: "a***@example.com",
          },
          manualAppleRevocationRequired: false,
        }),
      )
      .mockResolvedValueOnce(
        response(200, {
          challengeId: "challenge-1",
          receiptToken: "receipt-1",
          channel: "email",
          maskedTarget: "a***@example.com",
          expiresAt: "2026-07-22T00:10:00.000Z",
        }),
      )
      .mockResolvedValueOnce(response(200, pending))
      .mockResolvedValueOnce(response(200, pending));
    const auth = client(fetch);

    await expect(
      auth.getAccountDeletionAvailability("access-token"),
    ).resolves.toMatchObject({ available: true });
    const challenge = await auth.requestAccountDeletionChallenge("access-token");
    await expect(
      auth.confirmAccountDeletion("access-token", {
        challengeId: challenge.challengeId,
        receiptToken: challenge.receiptToken,
        code: "123456",
        acknowledged: true,
      }),
    ).resolves.toEqual(pending);
    await expect(
      auth.getAccountDeletionStatus(challenge.receiptToken),
    ).resolves.toEqual(pending);

    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer access-token",
    });
    expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer access-token",
    });
    expect(fetch.mock.calls[2]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer access-token",
    });
    expect(fetch.mock.calls[3]?.[1]?.headers).not.toHaveProperty(
      "Authorization",
    );
  });

  it("uses account tokens only for account control and exchanges a resource token", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(200, {
          memberships: [
            {
              id: "org-membership",
              kind: "org",
              role: "member",
              displayName: "Corp User",
              email: "user@example.com",
              orgId: "org-1",
              orgName: "Corp",
              orgSlug: "org-corp",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response(200, {
          status: "ok",
          accessToken: "org-access",
          refreshToken: "org-refresh",
          membership: {
            id: "org-membership",
            kind: "org",
            role: "member",
            displayName: "Corp User",
            email: "user@example.com",
            orgId: "org-1",
            orgName: "Corp",
          },
        }),
      );
    const auth = client(fetch);
    expect(auth).not.toHaveProperty("refreshAccount");
    expect(auth).not.toHaveProperty("logoutAccount");
    await expect(
      auth.getAccountMemberships("account-access"),
    ).resolves.toHaveLength(1);
    await expect(
      auth.exchangeAccountMembership("account-access", "org-membership"),
    ).resolves.toMatchObject({ accessToken: "org-access" });
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer account-access",
    });
    expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer account-access",
    });
  });

  it("maps server errors without leaking malformed responses", async () => {
    const fetch = vi.fn(async () =>
      response(401, { error: { code: "INVALID_CODE", message: "bad" } }),
    );
    await expect(
      client(fetch).verifyCode("email", "a@example.com", "000000"),
    ).rejects.toEqual(
      expect.objectContaining({ code: "INVALID_CODE", statusCode: 401 }),
    );
  });

  it("discovers enterprise SSO connections by org id and maps to login methods", async () => {
    const fetch = vi.fn(async () =>
      response(200, {
        orgName: "Disco Corp",
        connections: [
          { connectionId: "conn-1", protocol: "saml", connectionName: "Okta" },
        ],
      }),
    );
    const discovery = await client(fetch).discoverSsoOrg("disco-corp");
    expect(fetch).toHaveBeenCalledWith(
      "https://auth.example.com/api/auth/sso/discovery",
      expect.objectContaining({ body: JSON.stringify({ org: "disco-corp" }) }),
    );
    expect(ssoOrgDiscoveryToMethods(discovery)).toEqual([
      {
        type: "sso",
        connectionId: "conn-1",
        protocol: "saml",
        orgName: "Disco Corp",
        connectionName: "Okta",
        ssoRequired: false,
      },
    ]);
  });

  it("maps an empty SSO connection list to the precise ORG_SSO_NOT_FOUND error", async () => {
    const fetch = vi.fn(async () =>
      response(200, { orgName: "Empty Corp", connections: [] }),
    );
    await expect(
      client(fetch).discoverSsoOrg("empty-corp"),
    ).rejects.toMatchObject({ code: "ORG_SSO_NOT_FOUND" });
  });

  it('starts and polls a Linux device-code SSO login without a loopback callback', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(200, {
        device_code: 'd'.repeat(43),
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://auth.example.com/api/auth/device/verify',
        verification_uri_complete: 'https://auth.example.com/api/auth/device/verify?user_code=ABCD-EFGH&challenge=x',
        expires_in: 600,
        interval: 5,
      }))
      .mockResolvedValueOnce(response(200, {
        access_token: 'device-access', refresh_token: 'device-refresh', token_type: 'Bearer',
      }));
    const auth = client(fetch);
    const started = await auth.startSsoDeviceAuthorization('conn-1', 'TownsLinux');
    await expect(auth.pollSsoDeviceAuthorization(started.device_code)).resolves.toMatchObject({
      access_token: 'device-access', refresh_token: 'device-refresh',
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('https://auth.example.com/api/auth/device/authorize');
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      client_id: 'cindy-headless', device_id: 'device-1', device_name: 'TownsLinux', connection_id: 'conn-1',
    });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'd'.repeat(43),
    });
  });

  it("builds PKCE authorize URLs for social and SSO", () => {
    const auth = client();
    const url = new URL(
      auth.buildAuthorizeUrl({
        kind: "sso",
        providerOrConnectionId: "conn/a",
        redirectUri: "http://127.0.0.1:4567/auth",
        codeChallenge: "a".repeat(43),
        state: "state-1",
      }),
    );
    expect(url.pathname).toBe("/api/auth/sso/conn%2Fa/authorize");
    expect(url.searchParams.get("client_state")).toBe("state-1");
    expect(url.searchParams.get("device_id")).toBe("device-1");
  });
});

describe("reduceAuthFlow", () => {
  it("projects secret-bearing outcomes into public states", () => {
    const state = reduceAuthFlow(null, {
      type: "outcome",
      outcome: {
        status: "select_account",
        loginTicket: "secret-ticket",
        accounts: [
          {
            id: "m1",
            kind: "personal",
            role: "owner",
            displayName: "Cindy",
            email: null,
            orgId: null,
            orgName: null,
          },
        ],
      },
    });
    expect(state).toEqual(
      expect.objectContaining({ step: "account-selection" }),
    );
    expect(JSON.stringify(state)).not.toContain("secret-ticket");
  });

  it("projects SSO verification tickets without exposing the ticket", () => {
    const state = reduceAuthFlow(null, {
      type: "outcome",
      outcome: {
        status: "sso_verification_required",
        verificationTicket: "secret-sso-ticket",
        channel: "sms",
        targetMasked: "+8613****11",
      },
    });
    expect(state).toEqual({
      step: "sso-verification",
      channel: "sms",
      targetMasked: "+8613****11",
      codeRequested: false,
    });
    expect(JSON.stringify(state)).not.toContain("secret-sso-ticket");
  });
});
