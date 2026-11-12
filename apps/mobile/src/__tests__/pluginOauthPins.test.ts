import { describe, expect, it } from "vitest";
import { pinMobilePluginIdentity } from "../plugins/pluginOauthPins";
import type { PluginOauthPeerIdentity } from "@cindy/device-link";

const peer: PluginOauthPeerIdentity = {
  version: 1,
  realm: "global",
  membershipId: "owner",
  deviceId: "computer",
  publicKey: "signed-key",
  bootId: "boot",
  observedAtMs: 0,
  expiresAtMs: 60000,
};
describe("native plugin authorization pins", () => {
  it("serializes first registration and rejects key changes without overwriting the secure pin", async () => {
    const saved = new Map<string, string>();
    const store = {
      get: async (key: string) => saved.get(key) ?? null,
      set: async (key: string, value: string) => {
        saved.set(key, value);
      },
    };
    const results = await Promise.allSettled([
      pinMobilePluginIdentity(store, peer, "phone", () => {}),
      pinMobilePluginIdentity(
        store,
        { ...peer, publicKey: "replacement" },
        "phone",
        () => {},
      ),
    ]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: new Error("PLUGIN_AUTHORIZATION_IDENTITY_CHANGED"),
    });
    expect([...saved.values()]).toEqual(["signed-key"]);
    await pinMobilePluginIdentity(
      store,
      { ...peer, bootId: "restarted" },
      "phone",
      () => {},
    );
    for (const target of [
      { ...peer, realm: "cn" as const },
      { ...peer, membershipId: "other" },
      { ...peer, deviceId: "other" },
    ])
      await pinMobilePluginIdentity(store, target, "phone", () => {});
    await pinMobilePluginIdentity(store, peer, "other-phone", () => {});
    expect(saved.size).toBe(5);
  });
  it("propagates secure storage and stale-owner failures without registering another key", async () => {
    let writes = 0;
    await expect(
      pinMobilePluginIdentity(
        {
          get: async () => {
            throw new Error("locked");
          },
          set: async () => {
            writes++;
          },
        },
        peer,
        "phone",
        () => {},
      ),
    ).rejects.toThrow("locked");
    let current = true;
    await expect(
      pinMobilePluginIdentity(
        {
          get: async () => {
            current = false;
            return null;
          },
          set: async () => {
            writes++;
          },
        },
        peer,
        "phone",
        () => {
          if (!current) throw new Error("stale");
        },
      ),
    ).rejects.toThrow("stale");
    expect(writes).toBe(0);
  });
});
