import { describe, expect, it } from "vitest";

import { decodeLaneUserId, encodeLaneUserId } from "../codec.js";

describe("dingtalk lane codec", () => {
  it("round-trips group conversation ids without leaking separators", () => {
    const encoded = encodeLaneUserId("cid/a b");
    expect(encoded).toBe("g/cid%2Fa%20b");
    expect(decodeLaneUserId(encoded)).toEqual({ conversationId: "cid/a b" });
  });

  it("does not treat direct user ids as group lanes", () => {
    expect(decodeLaneUserId("user-1")).toBeNull();
    expect(decodeLaneUserId("g/")).toBeNull();
  });
});
