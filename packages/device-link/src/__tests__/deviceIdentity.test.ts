import { generateKeyPairSync, createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseDeviceIdentityChallenge,
  parseDeviceIdentityPublicKey,
  parseRegisteredDeviceIdentity,
} from "../deviceIdentity";

function identity() {
  const publicKey = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  }).publicKey.export({ format: "jwk" });
  const thumbprint = createHash("sha256")
    .update(
      JSON.stringify({
        crv: publicKey.crv,
        kty: publicKey.kty,
        x: publicKey.x,
        y: publicKey.y,
      }),
    )
    .digest("base64url");
  return {
    id: randomUUID(),
    userId: "account",
    publicKey,
    thumbprint,
    createdAt: "2026-09-09T00:00:00.000Z",
    revokedAt: null,
  };
}
describe("HTTPS device identity contract", () => {
  it("accepts a scoped canonical record and preserves terminal revocation", () => {
    const record = identity();
    expect(parseRegisteredDeviceIdentity(record, "account", record.id)).toEqual(
      record,
    );
    const revoked = { ...record, revokedAt: "2026-09-09T01:00:00.000Z" };
    expect(
      parseRegisteredDeviceIdentity(revoked, "account", record.id).revokedAt,
    ).toBe(revoked.revokedAt);
  });
  it("rejects another target, account, or a missing revocation field", () => {
    const record = identity();
    expect(() =>
      parseRegisteredDeviceIdentity(record, "other", record.id),
    ).toThrow();
    expect(() =>
      parseRegisteredDeviceIdentity(record, "account", randomUUID()),
    ).toThrow();
    expect(() =>
      parseRegisteredDeviceIdentity(
        { ...record, revokedAt: undefined },
        "account",
        record.id,
      ),
    ).toThrow();
  });
  it("does not accept private or noncanonical key representations", () => {
    const { publicKey } = identity();
    expect(() =>
      parseDeviceIdentityPublicKey({ ...publicKey, d: "private" }),
    ).toThrow();
    expect(() =>
      parseDeviceIdentityPublicKey({ ...publicKey, x: publicKey.x + "=" }),
    ).toThrow();
    expect(() =>
      parseDeviceIdentityPublicKey({ ...publicKey, crv: "P-384" }),
    ).toThrow();
  });
  it("bounds an enrollment challenge and rejects stale or mismatched scope", () => {
    const { thumbprint } = identity();
    const challenge = {
      version: 1,
      challengeId: randomUUID(),
      membershipId: "account",
      thumbprint,
      expiresAt: 61_000,
      message: "bm9uY2U",
    };
    expect(
      parseDeviceIdentityChallenge(challenge, "account", thumbprint, 1000),
    ).toEqual(challenge);
    for (const patch of [
      { membershipId: "other" },
      { expiresAt: 1000 },
      { expiresAt: 999_999 },
      { message: "a".repeat(4097) },
      { version: 2 },
    ])
      expect(() =>
        parseDeviceIdentityChallenge(
          { ...challenge, ...patch },
          "account",
          thumbprint,
          1000,
        ),
      ).toThrow();
  });
});
