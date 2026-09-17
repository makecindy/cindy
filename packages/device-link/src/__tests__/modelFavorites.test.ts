import { expect, it } from "vitest";
import {
  parseModelFavoriteMutation,
  parseModelFavorites,
  MODEL_FAVORITES_GET,
  MODEL_FAVORITES_APPLY,
  MODEL_FAVORITES_CHANGED,
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
