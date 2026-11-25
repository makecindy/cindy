import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AuthApiError, type AuthTokenPair } from "@cindy/auth-client";
import {
  InstanceSession,
  validateInstancePair,
  type InstanceRecord,
} from "../session.js";
import { instanceRefreshDelay, resolveInstanceConfig } from "../config.js";
import { buildInstanceStatus } from "../status.js";

const instanceId = "cloud-instance-0123456789abcdef";
const deviceId = `cloud-device-${createHash("sha256").update(instanceId).digest("hex").slice(0, 24)}`;
const config = { deviceId, membershipId: "test-membership" };
const now = 1_800_000_000_000;

function pair(
  sequence = 1,
  claimsOverride: Record<string, unknown> = {},
): AuthTokenPair {
  const claims = {
    typ: "instance_access",
    aud: "cindy:instance",
    sub: config.membershipId,
    accountControl: false,
    device: deviceId,
    instance: { id: instanceId, generation: 1 },
    iat: now / 1000,
    exp: now / 1000 + 300,
    nonce: sequence,
    ...claimsOverride,
  };
  return {
    accessToken: `test.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.not-a-signature`,
    refreshToken: `test-only-refresh-${sequence}`,
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
  let bootstrap: string | null = "test-only-bootstrap";
  const store = {
    read: vi.fn(() => record),
    write: vi.fn((value: InstanceRecord) => {
      record = structuredClone(value);
    }),
    preflight: vi.fn(),
  };
  let sequence = 0;
  const exchange = vi.fn(async () => pair(++sequence));
  const readBootstrap = vi.fn(() => bootstrap);
  const dependencies = {
    config,
    authBaseUrl: "https://auth.test.invalid",
    store,
    exchange,
    readBootstrap,
    now: () => now,
  };
  return {
    dependencies,
    store,
    exchange,
    readBootstrap,
    session: new InstanceSession(dependencies),
    restart: () => new InstanceSession(dependencies),
    setRecord: (value: InstanceRecord) => {
      record = value;
    },
    setBootstrap: (value: string | null) => {
      bootstrap = value;
    },
  };
}

describe("independent CIS session", () => {
  it("persists before publication and coalesces concurrent bootstrap requests", async () => {
    const test = fixture();
    const [first, concurrent] = await Promise.all([
      test.session.rotate(),
      test.session.rotate(),
    ]);
    expect(concurrent).toBe(first);
    expect(test.exchange).toHaveBeenCalledExactlyOnceWith(
      "test-only-bootstrap",
    );
    expect(test.store.write).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: first.refreshToken }),
    );
    expect(test.store.write.mock.calls[0][0]).not.toHaveProperty("accessToken");
    expect(test.session.isReady(first.accessToken)).toBe(false);
    test.session.acknowledge(first);
    expect(test.session.isReady(first.accessToken)).toBe(true);
  });

  it("renews twice and resumes from the latest durable refresh token", async () => {
    const test = fixture();
    const first = await test.session.rotate();
    test.session.acknowledge(first);
    const second = await test.session.rotate();
    test.session.acknowledge(second);
    await test.restart().rotate();
    expect(test.exchange.mock.calls).toEqual([
      ["test-only-bootstrap"],
      ["test-only-refresh-1"],
      ["test-only-refresh-2"],
    ]);
  });

  it("retries publication without rotating again", async () => {
    const test = fixture();
    const first = await test.session.rotate();
    expect(await test.session.rotate()).toBe(first);
    expect(test.exchange).toHaveBeenCalledTimes(1);
  });

  it("retains a rotated response in memory on disk failure and retries only persistence", async () => {
    const test = fixture();
    test.store.write.mockImplementationOnce(() => {
      throw new Error("EIO");
    });
    await expect(test.session.rotate()).rejects.toThrow("EIO");
    expect(test.session.isReady(pair().accessToken)).toBe(false);
    const recovered = await test.session.rotate();
    expect(recovered.refreshToken).toBe("test-only-refresh-1");
    expect(test.exchange).toHaveBeenCalledTimes(1);
    expect(test.store.write).toHaveBeenCalledTimes(2);
  });

  it.each(["preflight", "read"] as const)(
    "does not consume bootstrap when store %s fails",
    async (operation) => {
      const test = fixture();
      test.store[operation].mockImplementation(() => {
        throw new Error("unreadable");
      });
      await expect(test.session.rotate()).rejects.toThrow("unreadable");
      expect(test.readBootstrap).not.toHaveBeenCalled();
      expect(test.exchange).not.toHaveBeenCalled();
    },
  );

  it("rejects endpoint drift before sending a stored refresh token", async () => {
    const test = fixture();
    await test.session.rotate();
    const restarted = new InstanceSession({
      ...test.dependencies,
      authBaseUrl: "https://different.invalid",
    });
    await expect(restarted.rotate()).rejects.toThrow(
      "INSTANCE_RECORD_REJECTED",
    );
    expect(test.exchange).toHaveBeenCalledTimes(1);
  });

  it("requires new CIS bootstrap for a generation change", async () => {
    const test = fixture();
    const first = await test.session.rotate();
    test.session.acknowledge(first);
    test.exchange.mockResolvedValueOnce(
      pair(2, { instance: { id: instanceId, generation: 2 } }),
    );
    await expect(test.session.rotate()).rejects.toThrow(
      "Instance authorization rejected",
    );
    expect(test.store.write).toHaveBeenCalledTimes(1);
  });

  it("accepts a new CIS generation on wake, but never a downgrade", async () => {
    const test = fixture();
    await test.session.rotate();
    test.setBootstrap("test-only-bootstrap-next");
    test.exchange.mockResolvedValueOnce(
      pair(2, { instance: { id: instanceId, generation: 2 } }),
    );
    const next = test.restart();
    const renewed = await next.rotate();
    next.acknowledge(renewed);
    expect(test.exchange).toHaveBeenLastCalledWith("test-only-bootstrap-next");
    test.setBootstrap("test-only-bootstrap-stale");
    test.exchange.mockResolvedValueOnce(pair(3));
    await expect(test.restart().rotate()).rejects.toThrow(
      "Instance authorization rejected",
    );
    expect(test.store.write).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403])(
    "never replays bootstrap after authoritative %s rejection",
    async (status) => {
      const test = fixture();
      const first = await test.session.rotate();
      test.session.acknowledge(first);
      test.exchange.mockRejectedValueOnce(
        new AuthApiError("REVOKED", status, "Rejected"),
      );
      await expect(test.session.rotate()).rejects.toThrow("Rejected");
      await expect(test.session.rotate()).rejects.toThrow(
        "Instance authorization rejected",
      );
      expect(test.session.isReady(first.accessToken)).toBe(false);
      expect(test.exchange).toHaveBeenCalledTimes(2);
      expect(test.store.write).toHaveBeenCalledTimes(1);
    },
  );

  it("retains the latest RT on transient network failure", async () => {
    const test = fixture();
    const first = await test.session.rotate();
    test.session.acknowledge(first);
    test.exchange.mockRejectedValueOnce(
      new AuthApiError("NETWORK_ERROR", 0, "Unavailable"),
    );
    await expect(test.session.rotate()).rejects.toThrow("Unavailable");
    await test.session.rotate();
    expect(test.exchange.mock.calls.slice(1)).toEqual([
      ["test-only-refresh-1"],
      ["test-only-refresh-1"],
    ]);
  });

  it("supports an absent bootstrap mount only when an encrypted record exists", async () => {
    const test = fixture();
    await test.session.rotate();
    test.setBootstrap(null);
    await test.restart().rotate();
    expect(test.exchange).toHaveBeenLastCalledWith("test-only-refresh-1");
    const empty = fixture();
    empty.setBootstrap(null);
    await expect(empty.session.rotate()).rejects.toThrow(
      "INSTANCE_BOOTSTRAP_REQUIRED",
    );
  });

  it.each([
    { typ: "access" },
    { aud: "cindy" },
    { accountControl: true },
    { sub: "someone-else" },
    { device: "controller" },
    { exp: now / 1000 },
    { iat: now / 1000 + 60 },
    { instance: { id: instanceId, generation: 0 } },
    { instance: { id: "cloud-instance-ffffffffffffffff", generation: 1 } },
  ])(
    "rejects a mismatched instance token without publishing: %j",
    async (claims) => {
      const test = fixture();
      test.exchange.mockResolvedValueOnce(pair(1, claims));
      await expect(test.session.rotate()).rejects.toThrow(
        "Instance authorization rejected",
      );
      expect(test.store.write).not.toHaveBeenCalled();
    },
  );

  it("does not trust membership data independently of the token binding", () => {
    const response = pair();
    response.membership.id = "someone-else";
    expect(() => validateInstancePair(response, config, now)).toThrow(
      "INSTANCE_TOKEN_BINDING_REJECTED",
    );
  });

  it("schedules a 5-minute token after 4 minutes, never in a tight loop", () => {
    expect(instanceRefreshDelay(pair().accessToken, now)).toBe(240_000);
    expect(instanceRefreshDelay(pair().accessToken, now + 300_000)).toBe(1_000);
  });

  it.each([
    "http://public.invalid",
    "https://name:password@auth.invalid",
    "https://auth.invalid/?token=test",
  ])("rejects unsafe endpoint %s", (authBaseUrl) => {
    expect(
      () => new InstanceSession({ ...fixture().dependencies, authBaseUrl }),
    ).toThrow("INSTANCE_AUTH_ENDPOINT_REJECTED");
  });
});

describe("CIS startup and health contract", () => {
  const env = {
    CINDY_POD_DEVICE_ID: deviceId,
    CINDY_POD_MEMBERSHIP_ID: config.membershipId,
    CINDY_POD_DEVICE_NAME: "__cindy_cloud_device_name__:1",
    XDT_USER_DATA_DIR: "/var/lib/cindy/user-data",
    CINDY_POD_RESOURCE_REFRESH_TOKEN_FILE:
      "/run/secrets/resource-refresh-token",
    CINDY_POD_KEYRING_PASSWORD_FILE: "/run/secrets/credential-store-key",
    XDT_ENDPOINT_MANIFEST_FILE: "/run/config/endpoint.json",
    CINDY_CLOUD_STATUS_FILE: "/var/lib/cindy/status/status.json",
  };
  it("keeps an ordinary desktop unchanged without an explicit entry flag", () => {
    expect(resolveInstanceConfig([], env, "linux")).toBeNull();
    expect(
      resolveInstanceConfig(["--cloud-instance"], env, "linux"),
    ).toMatchObject(config);
  });
  it.each(Object.keys(env))(
    "fails closed if required CIS field %s is missing",
    (field) => {
      expect(() =>
        resolveInstanceConfig(
          ["--cloud-instance"],
          { ...env, [field]: undefined },
          "linux",
        ),
      ).toThrow();
    },
  );
  it("defaults to instance-v1 and requires explicit resource-v1 selection", () => {
    expect(
      resolveInstanceConfig(["--cloud-instance"], env, "linux")?.authProtocol,
    ).toBe("instance-v1");
    expect(
      resolveInstanceConfig(
        ["--cloud-instance"],
        { ...env, CINDY_POD_AUTH_PROTOCOL: "resource-v1" },
        "linux",
      )?.authProtocol,
    ).toBe("resource-v1");
    for (const value of ["", "resource", " resource-v1", "account-v1"]) {
      expect(() =>
        resolveInstanceConfig(
          ["--cloud-instance"],
          { ...env, CINDY_POD_AUTH_PROTOCOL: value },
          "linux",
        ),
      ).toThrow("INSTANCE_AUTH_PROTOCOL_INVALID");
    }
  });
  it("rejects wrong platform, profile, and sandbox bypass", () => {
    expect(() =>
      resolveInstanceConfig(["--cloud-instance"], env, "darwin"),
    ).toThrow();
    expect(() =>
      resolveInstanceConfig(
        ["--cloud-instance"],
        { ...env, XDT_USER_DATA_DIR: "/tmp/profile" },
        "linux",
      ),
    ).toThrow();
    expect(() =>
      resolveInstanceConfig(["--cloud-instance", "--no-sandbox"], env, "linux"),
    ).toThrow();
  });
  it("allows explicitly migrated resource profiles without a bootstrap mount", () => {
    const migrated = {
      ...env,
      CINDY_POD_AUTH_PROTOCOL: "resource-v1",
      CINDY_POD_CREDENTIAL_SOURCE: "canonical",
      CINDY_POD_RESOURCE_REFRESH_TOKEN_FILE: undefined,
    };
    expect(
      resolveInstanceConfig(["--cloud-instance"], migrated, "linux"),
    ).toMatchObject({ credentialSource: "canonical", bootstrapFile: null });
    for (const override of [
      { CINDY_POD_CREDENTIAL_SOURCE: "" },
      { CINDY_POD_CREDENTIAL_SOURCE: "auto" },
      { CINDY_POD_AUTH_PROTOCOL: "instance-v1" },
      { CINDY_POD_RESOURCE_REFRESH_TOKEN_FILE: "" },
      {
        CINDY_POD_RESOURCE_REFRESH_TOKEN_FILE:
          "/run/secrets/resource-refresh-token",
      },
    ]) {
      expect(() =>
        resolveInstanceConfig(
          ["--cloud-instance"],
          { ...migrated, ...override },
          "linux",
        ),
      ).toThrow("INSTANCE_CREDENTIAL_SOURCE_INVALID");
    }
  });
  it("uses the device identity in status and requires all five real readiness probes", () => {
    const readiness = {
      auth: true,
      database: true,
      binaries: true,
      maker: true,
      deviceLink: true,
    };
    expect(buildInstanceStatus(config, readiness, now)).toMatchObject({
      instanceId: deviceId,
      phase: "ready",
      idle: { maySuspend: false },
    });
    for (const component of Object.keys(readiness)) {
      expect(
        buildInstanceStatus(config, { ...readiness, [component]: false }, now)
          .phase,
      ).not.toBe("ready");
    }
    expect(buildInstanceStatus(config, readiness, now, true).phase).toBe(
      "stopping",
    );
  });
});
