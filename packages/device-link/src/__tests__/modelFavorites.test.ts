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
