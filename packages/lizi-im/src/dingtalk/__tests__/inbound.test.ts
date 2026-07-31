import { describe, expect, it } from "vitest";

import { parseInboundContent, parseInboundEnvelope } from "../inbound.js";

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: "chat-1",
    conversationType: "1",
    msgId: "message-1",
    msgtype: "text",
    robotCode: "app-key",
    senderId: "sender-id",
    senderStaffId: "staff-id",
    senderNick: "Alice",
    sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession",
    sessionWebhookExpiredTime: 2_000_000_000,
    text: { content: " hello " },
    ...overrides,
  };
}

describe("dingtalk inbound normalization", () => {
  it("normalizes identifiers and second-based webhook expiry", () => {
    const parsed = parseInboundEnvelope(envelope());
    expect(parsed).toMatchObject({
      senderId: "staff-id",
      senderName: "Alice",
      sessionWebhookExpiresAt: 2_000_000_000_000,
    });
    expect(parsed && parseInboundContent(parsed)).toMatchObject({
      text: "hello",
      unsupported: [],
    });
  });

  it("detects a group mention from the bot code", () => {
    const parsed = parseInboundEnvelope(
      envelope({
        conversationType: "2",
        atUsers: [{ dingtalkId: "app-key" }],
      }),
    );
    expect(parsed?.mentioned).toBe(true);
  });

  it("uses audio recognition and fails closed for raw media", () => {
    const audio = parseInboundEnvelope(
      envelope({ msgtype: "audio", recognition: "明天提醒我" }),
    );
    expect(audio && parseInboundContent(audio).text).toBe("明天提醒我");

    const video = parseInboundEnvelope(envelope({ msgtype: "video" }));
    expect(video && parseInboundContent(video).unsupported).toEqual([
      { type: "video", label: "视频" },
    ]);
  });

  it("collects text and image download codes from rich text content", () => {
    const parsed = parseInboundEnvelope(
      envelope({
        msgtype: "richText",
        content: {
          richText: [
            { type: "text", text: "first" },
            { type: "picture", downloadCode: "image-1" },
            { type: "text", text: "second" },
          ],
        },
      }),
    );
    expect(parsed && parseInboundContent(parsed)).toMatchObject({
      text: "first\n\nsecond",
      downloadCodes: ["image-1"],
    });
  });
});
