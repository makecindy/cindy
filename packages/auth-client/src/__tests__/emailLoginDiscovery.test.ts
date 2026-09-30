import { describe, expect, it, vi } from "vitest";
import {
  AuthApiError,
  CindyAuthClient,
  discoverEmailLogin,
  discoverPersonalLoginOrganization,
  type AuthMembership,
  discoverSsoOrgRealm,
  reduceAuthFlow,
  type AuthRegion,
  type LoginMethod,
  type SsoOrgDiscovery,
} from "../index.js";

const organization = (region: AuthRegion): SsoOrgDiscovery => ({
  region,
  orgName: "Example Enterprise",
  connections: [
    {
      connectionId: `${region}-sso`,
      protocol: "oidc",
      connectionName: "Work SSO",
    },
  ],
});

describe("email enterprise discovery", () => {
  it.each(["cn", "global"] as const)(
    "discovers a %s enterprise without sharing the mailbox",
    async (region) => {
      const requests: { region: AuthRegion; body: unknown }[] = [];
      const makeClient = (target: AuthRegion) =>
        new CindyAuthClient({
          baseUrl: `https://${target}.example.invalid`,
          region: target,
          clientType: "desktop",
          deviceId: "test-device",
          fetch: async (_url, init) => {
            requests.push({
              region: target,
              body: JSON.parse(init?.body as string),
            });
            return new Response(
              JSON.stringify(
                target === region
                  ? organization(region)
                  : {
                      error: {
                        code: "ORG_SSO_NOT_FOUND",
                        message: "not found",
                      },
                    },
              ),
              { status: target === region ? 200 : 404 },
            );
          },
        });
      const discoverPersonal = vi.fn();
      const result = await discoverEmailLogin("  Person+tag@EXAMPLE.COM  ", {
        buildRegion: region === "cn" ? "global" : "cn",
        discoverPersonal,
        discoverOrganization: async (domain) =>
          (
            await discoverSsoOrgRealm(domain, {
              cn: makeClient("cn"),
              global: makeClient("global"),
            })
          ).discovery,
      });
      expect(requests).toEqual([
        { region: "cn", body: { org: "example.com" } },
        { region: "global", body: { org: "example.com" } },
      ]);
      expect(result).toMatchObject({ email: "person+tag@example.com", region });
      expect(result.methods).toEqual([
        {
          type: "sso",
          connectionId: `${region}-sso`,
          protocol: "oidc",
          orgName: "Example Enterprise",
          connectionName: "Work SSO",
          ssoRequired: false,
        },
        { type: "email_code" },
      ]);
      expect(discoverPersonal).not.toHaveBeenCalled();
    },
  );

  it("preserves local email discovery and SSO preferences for a same-region enterprise", async () => {
    const methods: LoginMethod[] = [
      { type: "email_code" },
      {
        type: "sso",
        connectionId: "global-sso",
        protocol: "oidc",
        orgName: "Example Enterprise",
        connectionName: "Work SSO",
        ssoRequired: true,
      },
    ];
    const discoverPersonal = vi.fn(async () => methods);
    const result = await discoverEmailLogin("User@example.com", {
      buildRegion: "global",
      discoverPersonal,
      discoverOrganization: async () => organization("global"),
    });
    expect(result).toEqual({
      email: "user@example.com",
      region: "global",
      methods,
    });
    expect(discoverPersonal).toHaveBeenCalledWith("user@example.com");
  });

  it("continues ordinary email login when neither region has enabled enterprise SSO", async () => {
    const result = await discoverEmailLogin("user@example.com", {
      buildRegion: "global",
      discoverOrganization: async () => {
        throw new AuthApiError("ORG_SSO_NOT_FOUND", 404, "not found");
      },
      discoverPersonal: async () => [{ type: "email_code" }],
    });
    expect(result).toEqual({
      email: "user@example.com",
      region: "global",
      methods: [{ type: "email_code" }],
    });
  });

  it.each([
    "ORG_REALM_AMBIGUOUS",
    "ORG_REALM_UNAVAILABLE",
    "REGION_MISMATCH",
    "INVALID_RESPONSE",
    "RATE_LIMITED",
  ])("does not mistake %s for an absent enterprise", async (code) => {
    const discoverPersonal = vi.fn();
    await expect(
      discoverEmailLogin("user@example.com", {
        buildRegion: "global",
        discoverPersonal,
        discoverOrganization: async () => {
          throw new AuthApiError(code, 503, "failure");
        },
      }),
    ).rejects.toMatchObject({ code });
    expect(discoverPersonal).not.toHaveBeenCalled();
  });

  it.each([
    "",
    "user@",
    "user@@example.com",
    "example.com",
    `${"a".repeat(255)}@example.com`,
  ])("rejects invalid email before discovery", async (email) => {
    const discoverOrganization = vi.fn();
    const discoverPersonal = vi.fn();
    await expect(
      discoverEmailLogin(email, {
        buildRegion: "global",
        discoverOrganization,
        discoverPersonal,
      }),
    ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    expect(discoverOrganization).not.toHaveBeenCalled();
    expect(discoverPersonal).not.toHaveBeenCalled();
  });

  it("retains the mailbox through region confirmation for the personal email option", async () => {
    const result = await discoverEmailLogin("user@example.com", {
      buildRegion: "global",
      discoverPersonal: vi.fn(),
      discoverOrganization: async () => organization("cn"),
    });
    const state = reduceAuthFlow(null, {
      type: "realm-switch-required",
      targetRegion: result.region,
      email: result.email,
      methods: result.methods,
      providers: {
        region: "global",
        attribution: "email",
        email: true,
        phone: false,
        social: [],
      },
    });
    expect(state).toMatchObject({
      step: "realm-confirmation",
      email: "user@example.com",
      targetRegion: "cn",
    });
    if (state.step !== "realm-confirmation")
      throw new Error("Expected confirmation");
    expect(
      reduceAuthFlow(state, {
        type: "discovery-loaded",
        email: state.email ?? "",
        methods: state.methods,
      }),
    ).toMatchObject({
      step: "method-choice",
      email: "user@example.com",
      methods: result.methods,
    });
  });
});


describe("successful personal login enterprise discovery", () => {
  const membership = (email: string | null = " Person+tag@XD.COM "): AuthMembership => ({
    id: "personal-account", kind: "personal", role: "owner", displayName: "Person",
    email, orgId: null, orgName: null,
  });

  it.each(["cn", "global"] as const)("offers the %s enterprise using only the normalized email domain", async (region) => {
    const discoverOrganization = vi.fn(async () => organization(region));
    expect(await discoverPersonalLoginOrganization(membership(), {
      handledEmail: null, discoverOrganization,
    })).toEqual(organization(region));
    expect(discoverOrganization).toHaveBeenCalledExactlyOnceWith("xd.com");
  });

  it.each([null, "", "xd.com", "invalid@@xd.com", `${"x".repeat(250)}@xd.com`])(
    "leaves login unchanged when no usable email is available: %s", async (email) => {
      const discoverOrganization = vi.fn();
      expect(await discoverPersonalLoginOrganization(membership(email), {
        handledEmail: null, discoverOrganization,
      })).toBeNull();
      expect(discoverOrganization).not.toHaveBeenCalled();
    },
  );

  it("does not rediscover an organization identity or a mailbox already handled by email login", async () => {
    const discoverOrganization = vi.fn();
    expect(await discoverPersonalLoginOrganization({ ...membership(), kind: "org" }, {
      handledEmail: null, discoverOrganization,
    })).toBeNull();
    expect(await discoverPersonalLoginOrganization(membership(), {
      handledEmail: "person+tag@xd.com", discoverOrganization,
    })).toBeNull();
    expect(discoverOrganization).not.toHaveBeenCalled();
  });

  it.each(["ORG_SSO_NOT_FOUND", "ORG_REALM_AMBIGUOUS", "ORG_REALM_UNAVAILABLE", "RATE_LIMITED"])(
    "keeps successful login available on %s without suggesting a guessed region", async (code) => {
      expect(await discoverPersonalLoginOrganization(membership(), {
        handledEmail: null,
        discoverOrganization: async () => { throw new AuthApiError(code, 503, "discovery failed"); },
      })).toBeNull();
    },
  );

  it("carries only display metadata into confirmation, never the successful login tokens", () => {
    const state = reduceAuthFlow(null, {
      type: "realm-switch-required", targetRegion: "cn", personalLoginAvailable: true,
      providers: { region: "global", attribution: "email", email: true, phone: false, social: ["google"] },
      methods: [{ type: "sso", connectionId: "cn-sso", protocol: "oidc", orgName: "Enterprise", connectionName: "Work SSO", ssoRequired: false }],
    });
    expect(state).toMatchObject({ step: "realm-confirmation", personalLoginAvailable: true, targetRegion: "cn" });
    expect(Object.keys(state).sort()).toEqual(["methods", "personalLoginAvailable", "providers", "step", "targetRegion"]);
  });
});
