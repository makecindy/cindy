import { describe, expect, it } from "vitest";
import {
  makeTaskDispatch,
  parseHookMessage,
  serializeHookMessage,
} from "../index";
const source = {
  im: "x",
  triggerMessageId: "3",
  userText: "查看最近的 PR",
  xContext: {
    requesterId: "u1",
    requesterName: "Request Author",
    truncated: false,
  },
  threadContext: [
    {
      messageId: "1",
      replyToMessageId: null,
      authorId: "u1",
      author: "@requester",
      text: "此前讨论",
    },
    {
      messageId: "2",
      replyToMessageId: "1",
      authorId: "u2",
      author: "@other",
      text: "我花了很多 token",
    },
    {
      messageId: "3",
      replyToMessageId: "2",
      authorId: "u1",
      author: "@requester",
      text: "@bot 查看最近的 PR",
    },
  ],
};
const frame = makeTaskDispatch({
  requestId: "r",
  externalKey: "x:1",
  workspace: "w",
  prompt: "compat",
  source,
});
describe("X structured context compatibility", () => {
  it("round trips structured facts and preserves legacy prompt", () => {
    const result = parseHookMessage(serializeHookMessage(frame));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message).toEqual(frame);
  });
  it("accepts old source without added fields", () => {
    expect(
      parseHookMessage({
        ...frame,
        payload: { ...frame.payload, source: { im: "x", userText: "q" } },
      }).ok,
    ).toBe(true);
  });
  it.each([
    { ...source, xContext: { requesterId: "", truncated: false } },
    { ...source, xContext: { requesterId: "u", truncated: "false" } },
    {
      ...source,
      xContext: { requesterId: "u", truncated: false, requesterName: 3 },
    },
    { ...source, threadContext: [{ author: "a", text: "q", messageId: 3 }] },
    { ...source, threadContext: [{ author: "a", text: "q", authorId: "" }] },
    {
      ...source,
      threadContext: [{ author: "a", text: "q", replyToMessageId: false }],
    },
  ])("rejects malformed added metadata %#", (invalidSource) => {
    expect(
      parseHookMessage({
        ...frame,
        payload: { ...frame.payload, source: invalidSource },
      }).ok,
    ).toBe(false);
  });
});
