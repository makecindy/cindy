// Cross-platform tests use the Node host environment; importing Desktop main
// from Mobile tests pulls Node-only APIs into the React Native type environment.
import { describe, expect, it } from "vitest";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  MobileOauthBox,
  type PluginOauthCrypto,
} from "../../../../../mobile/src/plugins/pluginOauthCrypto";
import { authenticateMobilePluginOauth } from "../../../../../mobile/src/plugins/pluginOauthClient";
import { OauthBox } from "../box";
import {
  AuthenticatedOauthHost,
  OauthHostIdentity,
} from "../authentication";
import type { PluginOauthPeerIdentity } from "@cindy/device-link";
const crypto: PluginOauthCrypto = {
  random: (n) => new Uint8Array(randomBytes(n)),
  encrypt: async (key, iv, body, aad) => {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);
    return new Uint8Array(
      Buffer.concat([
        Buffer.from(iv),
        cipher.update(body),
        cipher.final(),
        cipher.getAuthTag(),
      ]),
    );
  },
  decrypt: async (key, data, aad) => {
    const cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
    cipher.setAAD(aad);
    cipher.setAuthTag(data.subarray(-16));
    return new Uint8Array(
      Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]),
    );
  },
};
describe("mobile native plugin authorization cryptography", () => {
  it("interoperates with the actual execution Host in both directions and rejects tampering, domain substitution and disposed keys", async () => {
    const mobile = new MobileOauthBox(crypto),
      desktop = new OauthBox();
    const box = await mobile.seal(
      desktop.publicKey,
      "transaction",
      "callback",
      { value: "私有测试值 🎵" },
    );
    expect(
      desktop.open(mobile.publicKey, "transaction", "callback", box),
    ).toEqual({ value: "私有测试值 🎵" });
    const offer = desktop.seal(mobile.publicKey, "transaction", "offer", {
      state: "trusted",
    });
    expect(
      await mobile.open(desktop.publicKey, "transaction", "offer", offer),
    ).toEqual({ state: "trusted" });
    const bytes = Buffer.from(offer, "base64url");
    bytes[15] ^= 1;
    await expect(
      mobile.open(
        desktop.publicKey,
        "transaction",
        "offer",
        bytes.toString("base64url"),
      ),
    ).rejects.toThrow("OAUTH_BRIDGE_INVALID");
    await expect(
      mobile.open(desktop.publicKey, "another-transaction", "offer", offer),
    ).rejects.toThrow("OAUTH_BRIDGE_INVALID");
    mobile.dispose();
    await expect(
      mobile.seal(desktop.publicKey, "transaction", "callback", {}),
    ).rejects.toThrow("OAUTH_BRIDGE_INVALID");
  });
  it("verifies the actual signed Host handshake before transmitting authenticated requests", async () => {
    const identity = new OauthHostIdentity(),
      now = Date.now(),
      raw: unknown[] = [];
    const scope = {
      realm: "global" as const,
      membershipId: "membership",
      deviceId: "computer",
      key: identity,
    };
    const host = new AuthenticatedOauthHost({
      owner: () => "membership",
      available: () => true,
      identity: () => scope,
      bind: async () => ({ ghostId: "practice", current: () => true }),
      request: async (_peer, request) => ({ received: request }),
      now: () => now,
    });
    const target: PluginOauthPeerIdentity = {
      ...identity.descriptor,
      ...scope,
      observedAtMs: now,
      expiresAtMs: now + 60000,
    };
    let trusted = false;
    const client = await authenticateMobilePluginOauth({
      crypto,
      target,
      peer: "phone",
      ghostId: "practice",
      action: { requestId: "card", actionId: "connect", expectedRevision: 3 },
      now: () => now,
      assertCurrent: () => {},
      trustIdentity: async () => {
        trusted = true;
      },
      invoke: async (value) => {
        raw.push(value);
        return host.request("phone", value);
      },
    });
    expect(trusted).toBe(true);
    expect(await client.request({ op: "capabilities" })).toEqual({
      received: { op: "capabilities" },
    });
    expect(raw[1]).toMatchObject({ op: "exchange" });
    expect(JSON.stringify(raw[1])).not.toContain("capabilities");
    client.dispose();
    await expect(
      authenticateMobilePluginOauth({
        crypto,
        target,
        peer: "different-phone",
        ghostId: "practice",
        action: { requestId: "card", actionId: "connect", expectedRevision: 3 },
        now: () => now,
        assertCurrent: () => {},
        trustIdentity: async () => {
          throw new Error("must not reach trust");
        },
        invoke: (value) => host.request("phone", value),
      }),
    ).rejects.toThrow("OAUTH_BRIDGE_UNAVAILABLE");
  });
});
