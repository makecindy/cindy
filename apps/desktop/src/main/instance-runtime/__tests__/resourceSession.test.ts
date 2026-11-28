import { describe, expect, it, vi } from "vitest";
import { AuthApiError, type AuthTokenPair } from "@cindy/auth-client";
import {
  InstanceSession,
  validateResourcePair,
  type InstanceRecord,
} from "../session.js";
import { instanceRefreshDelay } from "../config.js";

const config = {
  deviceId: "cloud-device-0123456789abcdef01234567",
  membershipId: "test-membership",
  authProtocol: "resource-v1" as const,
};
const authBaseUrl = "https://auth.test.invalid";
const now = 1_800_000_000_000;
const refreshToken = (sequence: number): string =>
  `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;

function pair(
  sequence = 1,
  claimsOverride: Record<string, unknown> = {},
): AuthTokenPair {
  const claims = {
    typ: "access",
    iss: authBaseUrl,
    aud: "cindy",
    sub: config.membershipId,
    device: config.deviceId,
    accountControl: false,
    iat: now / 1000,
    exp: now / 1000 + 3600,
    nonce: sequence,
    ...claimsOverride,
  };
  return {
    accessToken: `test.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.not-a-signature`,
    refreshToken: refreshToken(sequence),
    membership: {
      id: config.membershipId,
      kind: "personal",
      role: "member",
      displayName: "Test",
      email: null,
      orgId: null,
      orgName: null,
    },
  };
}

function fixture() {
  let record: InstanceRecord | null = null;
  let bootstrap: string | null = refreshToken(0);
  let sequence = 0;
  const store = {
    read: vi.fn(() => record),
    write: vi.fn((value: InstanceRecord) => {
      record = structuredClone(value);
    }),
    preflight: vi.fn(),
  };
  const dependencies = {
    config,
    authBaseUrl,
    store,
    readBootstrap: vi.fn(() => bootstrap),
    exchange: vi.fn(async () => pair(++sequence)),
    now: () => now,
  };
  return {
    dependencies,
    session: new InstanceSession(dependencies),
    restart: () => new InstanceSession(dependencies),
    setBootstrap: (value: string | null) => {
      bootstrap = value;
    },
  };
}

describe("explicit deployed resource-only contract", () => {
  // Regression: a denied canonical refresh must not permanently block the instance.
  // Tier unit: exercise the real session writer/publication boundary, including
  // a lost write and replay, with a fresh owner grant.
  it("recovers a rejected canonical session, retains a failed write, and resumes from the rotated credential", async () => {
    const h = fixture();
    h.session.acknowledge(await h.session.rotate());
    h.dependencies.exchange.mockRejectedValueOnce(new AuthApiError('ACCOUNT_UNAVAILABLE', 401, 'Rejected'));
    await expect(h.session.rotate()).rejects.toThrow();
    expect(h.session.needsLogin()).toBe(true);
    const request = 'recovery_request_0001';
    h.dependencies.store.write.mockImplementationOnce(() => { throw new Error('disk unavailable'); });
    await expect(h.session.recover(request, refreshToken(90))).rejects.toThrow('disk unavailable');
    expect(h.session.recovered(request)).toBe(false);
    const beforeRetry = h.dependencies.exchange.mock.calls.length;
    const restored = await h.session.recover(request, refreshToken(90));
    expect(h.dependencies.exchange).toHaveBeenCalledTimes(beforeRetry);
    expect(h.session.recovered(request)).toBe(false);
    h.session.acknowledge(restored);
    expect(h.session.recovered(request)).toBe(true);
    expect(h.session.needsLogin()).toBe(false);
    const restart = h.restart();
    const resumed = await restart.recover(request, refreshToken(90));
    expect(h.dependencies.exchange).toHaveBeenLastCalledWith(restored.refreshToken);
    restart.acknowledge(resumed);
    expect(restart.recovered(request)).toBe(true);
    await expect(restart.recover(request, refreshToken(91))).rejects.toThrow('INSTANCE_RECOVERY_REJECTED');
  });

  it("preserves the original identity and credential when the recovery grant belongs to another device", async () => {
    const h = fixture();
    h.session.acknowledge(await h.session.rotate());
    h.dependencies.exchange.mockRejectedValueOnce(new AuthApiError('REJECTED', 401, 'Rejected'));
    await expect(h.session.rotate()).rejects.toThrow();
    const original = structuredClone(h.dependencies.store.read());
    h.dependencies.exchange.mockResolvedValueOnce(pair(9, { device: 'other-device' }));
    await expect(h.session.recover('recovery_request_0002', refreshToken(90))).rejects.toThrow('INSTANCE_TOKEN_BINDING_REJECTED');
    expect(h.dependencies.store.read()).toEqual(original);
    expect(h.session.needsLogin()).toBe(true);
  });
  it("accepts only the configured issuer and follows the actual token lifetime", () => {
    expect(() =>
      validateResourcePair(pair(), config, authBaseUrl, now),
    ).not.toThrow();
    expect(() =>
      validateResourcePair(pair(), config, `${authBaseUrl}/`, now),
    ).not.toThrow();
    expect(instanceRefreshDelay(pair().accessToken, now)).toBe(3_300_000);
  });

  it.each([
    { typ: "instance_access" },
    { typ: "account" },
    { typ: undefined },
    { aud: "cindy:instance" },
    { aud: ["cindy", "cindy:account"] },
    { iss: "https://different.invalid" },
    { iss: undefined },
    { accountControl: true },
    { accountControl: undefined },
    { accountControl: "false" },
    { sub: "another-membership" },
    { device: "another-device" },
    { instance: { id: "cloud-instance-0123456789abcdef", generation: 1 } },
    { exp: now / 1000 },
    { exp: "1800003600" },
    { iat: now / 1000 + 31 },
    { iat: now / 1000 + 3600, exp: now / 1000 + 3600 },
  ])("rejects mixed, unbound or privileged claims: %j", async (claims) => {
    const test = fixture();
    test.dependencies.exchange.mockResolvedValueOnce(pair(1, claims));
    await expect(test.session.rotate()).rejects.toThrow(
      "Instance authorization rejected",
    );
    await expect(test.session.rotate()).rejects.toThrow(
      "Instance authorization rejected",
    );
    expect(test.dependencies.store.write).not.toHaveBeenCalled();
    expect(test.dependencies.exchange).toHaveBeenCalledTimes(1);
    expect(test.session.isReady(pair().accessToken)).toBe(false);
  });

  it.each(["", "test-only-opaque-token", "x".repeat(43)])(
    "rejects a non-resource refresh token: %s",
    (token) => {
      expect(() =>
        validateResourcePair(
          { ...pair(), refreshToken: token },
          config,
          authBaseUrl,
          now,
        ),
      ).toThrow("INSTANCE_TOKEN_BINDING_REJECTED");
    },
  );

  it("binds the membership response as well as the access token", () => {
    const response = pair();
    response.membership.id = "another-membership";
    expect(() =>
      validateResourcePair(response, config, authBaseUrl, now),
    ).toThrow("INSTANCE_TOKEN_BINDING_REJECTED");
  });

  it("does not accept the resource contract without explicit opt-in", async () => {
    const test = fixture();
    const session = new InstanceSession({
      ...test.dependencies,
      config: { deviceId: config.deviceId, membershipId: config.membershipId },
    });
    await expect(session.rotate()).rejects.toThrow(
      "Instance authorization rejected",
    );
    expect(test.dependencies.store.write).not.toHaveBeenCalled();
  });

  it("persists the selected protocol before publication without inventing grant identity", async () => {
    const test = fixture();
    const [first, concurrent] = await Promise.all([
      test.session.rotate(),
      test.session.rotate(),
    ]);
    expect(concurrent).toBe(first);
    expect(test.dependencies.exchange).toHaveBeenCalledExactlyOnceWith(
      refreshToken(0),
    );
    const record = test.dependencies.store.write.mock.calls[0][0];
    expect(record).toMatchObject({
      version: 2,
      protocol: "resource-v1",
      refreshToken: first.refreshToken,
    });
    expect(record).not.toHaveProperty("accessToken");
    expect(record).not.toHaveProperty("generation");
    expect(record).not.toHaveProperty("instanceId");
    expect(test.session.isReady(first.accessToken)).toBe(false);
    test.session.acknowledge(first);
    expect(test.session.isReady(first.accessToken)).toBe(true);
  });

  it("renews twice and restarts from the newest durable token, not the stale mount", async () => {
    const test = fixture();
    const first = await test.session.rotate();
    test.session.acknowledge(first);
    const second = await test.session.rotate();
    test.session.acknowledge(second);
    await test.restart().rotate();
    expect(test.dependencies.exchange.mock.calls).toEqual([
      [refreshToken(0)],
      [refreshToken(1)],
      [refreshToken(2)],
    ]);
  });

  it("never reads bootstrap in explicit migrated mode, including after rotations and restart", async () => {
    const test = fixture();
    await test.session.rotate();
    test.setBootstrap(refreshToken(999));
    test.dependencies.readBootstrap.mockClear();
    const dependencies = {
      ...test.dependencies,
      config: { ...config, credentialSource: "canonical" as const },
    };
    const migrated = new InstanceSession(dependencies);
    const first = await migrated.rotate();
    migrated.acknowledge(first);
    await migrated.rotate();
    await new InstanceSession(dependencies).rotate();
    expect(test.dependencies.readBootstrap).not.toHaveBeenCalled();
    expect(test.dependencies.exchange.mock.calls).toEqual([
      [refreshToken(0)],
      [refreshToken(1)],
      [refreshToken(2)],
      [refreshToken(3)],
    ]);
  });

  it("fails closed without migrated canonical even if bootstrap is available", async () => {
    const test = fixture();
    const migrated = new InstanceSession({
      ...test.dependencies,
      config: { ...config, credentialSource: "canonical" },
    });
    await expect(migrated.rotate()).rejects.toThrow(
      "INSTANCE_CANONICAL_REQUIRED",
    );
    expect(test.dependencies.exchange).not.toHaveBeenCalled();
    expect(test.dependencies.readBootstrap).not.toHaveBeenCalled();
  });

  it("rejects incompatible credential-source configuration", () => {
    const test = fixture();
    expect(
      () =>
        new InstanceSession({
          ...test.dependencies,
          config: {
            ...config,
            authProtocol: "instance-v1",
            credentialSource: "canonical",
          },
        }),
    ).toThrow("INSTANCE_CREDENTIAL_SOURCE_INVALID");
  });

  it("rejects protocol or endpoint drift before using a durable token", async () => {
    const test = fixture();
    await test.session.rotate();
    const differentProtocol = new InstanceSession({
      ...test.dependencies,
      config: { ...config, authProtocol: "instance-v1" },
    });
    const differentEndpoint = new InstanceSession({
      ...test.dependencies,
      authBaseUrl: "https://different.invalid",
    });
    await expect(differentProtocol.rotate()).rejects.toThrow(
      "INSTANCE_RECORD_REJECTED",
    );
    await expect(differentEndpoint.rotate()).rejects.toThrow(
      "INSTANCE_RECORD_REJECTED",
    );
    expect(test.dependencies.exchange).toHaveBeenCalledTimes(1);
  });

  it("does not reinterpret an instance record as resource-only", async () => {
    const test = fixture();
    test.dependencies.store.write({
      version: 1,
      instanceId: "cloud-instance-0123456789abcdef",
      generation: 1,
      deviceId: config.deviceId,
      membershipId: config.membershipId,
      authBaseUrl,
      bootstrapDigest: "f".repeat(64),
      refreshToken: refreshToken(1),
    });
    await expect(test.session.rotate()).rejects.toThrow(
      "INSTANCE_RECORD_REJECTED",
    );
    expect(test.dependencies.exchange).not.toHaveBeenCalled();
  });

  it("retries durable writes and publication without consuming the token twice", async () => {
    const test = fixture();
    test.dependencies.store.write.mockImplementationOnce(() => {
      throw new Error("EIO");
    });
    await expect(test.session.rotate()).rejects.toThrow("EIO");
    expect(test.session.isReady(pair().accessToken)).toBe(false);
    const recovered = await test.session.rotate();
    expect(await test.session.rotate()).toBe(recovered);
    expect(test.dependencies.exchange).toHaveBeenCalledTimes(1);
    expect(test.dependencies.store.write).toHaveBeenCalledTimes(2);
  });

  it.each(["preflight", "read"] as const)(
    "does not consume bootstrap if %s fails",
    async (operation) => {
      const test = fixture();
      test.dependencies.store[operation].mockImplementation(() => {
        throw new Error("unreadable");
      });
      await expect(test.session.rotate()).rejects.toThrow("unreadable");
      expect(test.dependencies.readBootstrap).not.toHaveBeenCalled();
      expect(test.dependencies.exchange).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403])(
    "stops after authoritative %s without fallback",
    async (status) => {
      const test = fixture();
      const first = await test.session.rotate();
      test.session.acknowledge(first);
      test.dependencies.exchange.mockRejectedValueOnce(
        new AuthApiError("REVOKED", status, "Rejected"),
      );
      await expect(test.session.rotate()).rejects.toThrow("Rejected");
      await expect(test.session.rotate()).rejects.toThrow(
        "Instance authorization rejected",
      );
      expect(test.session.isReady(first.accessToken)).toBe(false);
      expect(test.dependencies.exchange).toHaveBeenCalledTimes(2);
      expect(test.dependencies.store.write).toHaveBeenCalledTimes(1);
    },
  );

  it("retries only the latest token after a transient transport failure", async () => {
    const test = fixture();
    const first = await test.session.rotate();
    test.session.acknowledge(first);
    test.dependencies.exchange.mockRejectedValueOnce(
      new AuthApiError("NETWORK_ERROR", 0, "Unavailable"),
    );
    await expect(test.session.rotate()).rejects.toThrow("Unavailable");
    await test.session.rotate();
    expect(test.dependencies.exchange.mock.calls.slice(1)).toEqual([
      [refreshToken(1)],
      [refreshToken(1)],
    ]);
  });

  it("requires either canonical credentials or an explicit resource bootstrap", async () => {
    const test = fixture();
    test.setBootstrap(null);
    await expect(test.session.rotate()).rejects.toThrow(
      "INSTANCE_BOOTSTRAP_REQUIRED",
    );
    test.setBootstrap(refreshToken(0));
    await test.session.rotate();
    test.setBootstrap(null);
    await test.restart().rotate();
    expect(test.dependencies.exchange).toHaveBeenLastCalledWith(
      refreshToken(1),
    );
  });
});


describe("recovering a device that device-link removed", () => {
  it("refuses a ready session unless the device registration was lost", async () => {
    const h = fixture();
    h.session.acknowledge(await h.session.rotate());
    await expect(h.session.recover("recovery_request_0003", refreshToken(90))).rejects.toThrow("INSTANCE_RECOVERY_NOT_REQUIRED");
    const restored = await h.session.recover("recovery_request_0003", refreshToken(90), { registrationLost: true });
    h.session.acknowledge(restored);
    expect(h.session.recovered("recovery_request_0003")).toBe(true);
  });

  it("publishes the owner's explicit login access token when it is bound to this device", async () => {
    const h = fixture();
    h.session.acknowledge(await h.session.rotate());
    const explicit = pair(50, { amr: ["otp"], auth_time: now / 1000 - 5 }).accessToken;
    const restored = await h.session.recover("recovery_request_0004", refreshToken(91), { registrationLost: true, accessToken: explicit });
    expect(restored.accessToken).toBe(explicit);
    expect(h.dependencies.exchange).toHaveBeenLastCalledWith(refreshToken(91));
    expect(restored.refreshToken).not.toBe(refreshToken(91));
    h.session.acknowledge(restored);
    expect(h.session.isReady(explicit)).toBe(true);
  });

  it("keeps the exchanged token when the supplied one is unbound or not from an explicit login", async () => {
    for (const claims of [
      { amr: ["otp"], auth_time: now / 1000, device: "other-device" },
      { amr: [], auth_time: now / 1000 },
      {},
    ]) {
      const h = fixture();
      h.session.acknowledge(await h.session.rotate());
      const supplied = pair(60, claims).accessToken;
      const restored = await h.session.recover("recovery_request_0005", refreshToken(92), { registrationLost: true, accessToken: supplied });
      expect(restored.accessToken).not.toBe(supplied);
    }
  });
});
