import { describe, expect, it } from "vitest";

import {
  chunkWecomMarkdown,
  decodeWecomLane,
  encodeWecomGroupLane,
  escapeWecomMarkdown,
} from "../codec.js";

describe("WeCom lane codec", () => {
  it("round-trips group chat ids without exposing path separators", () => {
    const lane = encodeWecomGroupLane("chat/with spaces/中文");
    expect(lane).toMatch(/^group\/[A-Za-z0-9_-]+$/);
    expect(decodeWecomLane(lane)).toEqual({
      kind: "group",
      targetId: "chat/with spaces/中文",
    });
  });

  it("treats ordinary ids as single-chat targets", () => {
    expect(decodeWecomLane("zhangsan")).toEqual({
      kind: "single",
      targetId: "zhangsan",
    });
  });

  it.each(["group/", "group/abc=", "group/abc+", "group/abc/", "group/_w"])(
    "rejects malformed group lane %s",
    (lane) => {
      expect(() => decodeWecomLane(lane)).toThrow("WECOM_GROUP_LANE_INVALID");
    },
  );
});

describe("WeCom markdown chunking", () => {
  it("keeps every chunk under the transport byte limit", () => {
    const chunks = chunkWecomMarkdown("中".repeat(20_000));
    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 18 * 1024),
    ).toBe(true);
    expect(chunks.join("")).toBe("中".repeat(20_000));
  });

  it("normalizes an empty final response", () => {
    expect(chunkWecomMarkdown(" \r\n ")).toEqual(["✅ (本轮无文本输出)"]);
  });

  it("escapes plain text before sending it through markdown", () => {
    expect(escapeWecomMarkdown("**not bold** [link](x)")).toBe(
      "\\*\\*not bold\\*\\* \\[link\\]\\(x\\)",
    );
  });
});
