import { expect, it } from "vitest";
import {
  parseModelFavoriteMutation,
  parseModelFavorites,
  MODEL_FAVORITES_GET,
  MODEL_FAVORITES_APPLY,
  MODEL_FAVORITES_CHANGED,
  MODEL_FAVORITE_TEXT_MAX_LENGTH,
  agentDeviceFavoriteSource,
  parseAgentDeviceFavoriteSource,
  providerShareFavoriteSource,
  parseProviderShareFavoriteSource,
  providerShareFavoriteWireKey,
} from "../index";
import { REMOTE_INVOKE_ALLOWLIST, PUSH_FORWARD_ALLOWLIST } from "../allowlist";
import { topicForPush } from "../topics";
const item = {
  uid: "fav-1",
  providerId: "account",
  modelId: "model",
  agent: "pi",
  effort: "high",
};
it("exposes only public get/apply and invalidation to authenticated remote peers", () => {
  expect(REMOTE_INVOKE_ALLOWLIST.has(MODEL_FAVORITES_GET)).toBe(true);
  expect(REMOTE_INVOKE_ALLOWLIST.has(MODEL_FAVORITES_APPLY)).toBe(true);
  expect(REMOTE_INVOKE_ALLOWLIST.has("model-favorites:host-reply")).toBe(false);
  expect(PUSH_FORWARD_ALLOWLIST.has(MODEL_FAVORITES_CHANGED)).toBe(true);
  expect(topicForPush(MODEL_FAVORITES_CHANGED, {})).toBe("sessions");
});
it("strips unknown fields and rejects invalid identities, duplicates, and effort labels", () => {
  expect(parseModelFavorites([{ ...item, secret: "not transmitted" }])).toEqual(
    [item],
  );
  expect(() => parseModelFavorites([item, item])).toThrow("Duplicate");
  expect(() => parseModelFavorites([{ ...item, effort: "最高" }])).toThrow();
  expect(() =>
    parseModelFavoriteMutation({
      kind: "add",
      item: { ...item, providerId: "*" },
    }),
  ).toThrow();
  expect(() =>
    parseModelFavoriteMutation({
      kind: "update",
      expected: item,
      item: { ...item, providerId: "another" },
    }),
  ).toThrow("identity");
});

it("allows a larger local source bound without changing wire or other field limits", () => {
  const longItem = { ...item, providerId: 'p'.repeat(2048) };
  const add = { kind: 'add', item: longItem };
  expect(parseModelFavoriteMutation(add, 2048)).toMatchObject({ kind: 'add', item: { providerId: longItem.providerId } });
  expect(() => parseModelFavoriteMutation(add)).toThrow();
  expect(() => parseModelFavorites([longItem])).toThrow();
  expect(() => parseModelFavoriteMutation({ kind: 'add', item: { ...item, providerId: 'p'.repeat(2049) } }, 2048)).toThrow();
  expect(() => parseModelFavoriteMutation({ kind: 'add', item: { ...item, modelId: 'm'.repeat(513) } }, 2048)).toThrow();
  expect(() => parseModelFavoriteMutation({ kind: 'remove', expected: { ...longItem, uid: 'u'.repeat(513) } }, 2048)).toThrow();
  expect(parseModelFavorites([{ ...item, providerId: 'p'.repeat(512) }])).toHaveLength(1);
});
it("encodes another computer's source into the favorite provider id and round-trips it", () => {
  const deviceId = "a".repeat(64);
  const key = agentDeviceFavoriteSource({ deviceId, providerId: "anthropic" });
  expect(key.length).toBeLessThanOrEqual(MODEL_FAVORITE_TEXT_MAX_LENGTH);
  expect(parseAgentDeviceFavoriteSource(key)).toEqual({ deviceId, providerId: "anthropic" });
  // The encoded source travels through the existing wire validation unchanged.
  expect(parseModelFavorites([{ ...item, providerId: key }])[0]!.providerId).toBe(key);
  expect(parseAgentDeviceFavoriteSource("anthropic")).toBeNull();
  expect(parseAgentDeviceFavoriteSource("agent-device-favorite:[\"only-one\"]")).toBeNull();
  expect(parseAgentDeviceFavoriteSource("agent-device-favorite:not-json")).toBeNull();
  expect(() => agentDeviceFavoriteSource({ deviceId: "", providerId: "anthropic" })).toThrow();
  expect(() => agentDeviceFavoriteSource({ deviceId, providerId: "p".repeat(500) })).toThrow();
});

it("encodes a shared provider favorite with the same share and member identity Desktop stores", () => {
  const source = { shareId: "s1", memberId: "m1", providerId: "anthropic", owner: { region: "global" as const } };
  const key = providerShareFavoriteSource(source);
  expect(key).toBe('provider-share-favorite:["s1","m1","anthropic","global"]');
  expect(providerShareFavoriteWireKey(source)).toBe(key);
  expect(parseProviderShareFavoriteSource(key)).toEqual({
    shareId: "s1", memberId: "m1", providerId: "anthropic", region: "global",
  });
  expect(parseModelFavorites([{ ...item, providerId: key }])[0]!.providerId).toBe(key);
  const tooLong = {
    shareId: "s".repeat(128), memberId: "m".repeat(128), providerId: "p".repeat(256),
    owner: { region: "cn" as const },
  };
  const longKey = providerShareFavoriteSource(tooLong);
  expect(longKey.length).toBeGreaterThan(MODEL_FAVORITE_TEXT_MAX_LENGTH);
  expect(providerShareFavoriteWireKey(tooLong)).toBeNull();
  expect(() => parseModelFavorites([{ ...item, providerId: longKey }])).toThrow();
  expect(parseProviderShareFavoriteSource("provider-share-favorite:[\"only\"]")).toBeNull();
  expect(() => providerShareFavoriteSource({ ...source, shareId: "" })).toThrow("Invalid shared favorite source");
});
