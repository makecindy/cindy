import { describe, expect, it } from "vitest";

import { i18n } from "@/i18n";
import { createConversationShareFooterAssetGate } from "@/session/conversationShareAssetGate";
import {
  buildConversationShareSvgLayout,
  conversationShareSvgRenderSize,
  wrapSvgText,
} from "@/session/conversationShareSvgLayout";

const colors = {
  background: "#ffffff",
  border: "#cccccc",
  codeSurface: "#eeeeee",
  inlineCode: "#111111",
  surfaceChip: "#eeeeee",
  surfaceElevated: "#f5f5f5",
  syntax: {
    comment: "#777777",
    function: "#111111",
    keyword: "#111111",
    number: "#111111",
    property: "#111111",
    string: "#111111",
  },
  textPrimary: "#111111",
  textSecondary: "#666666",
  textTertiary: "#999999",
};

describe("ConversationShareSvg", () => {
  it("wraps Chinese and Latin text within the available width", () => {
    expect(
      wrapSvgText("这是很长的一段中文消息", 60, 15).length,
    ).toBeGreaterThan(1);
    expect(wrapSvgText("long latin message", 60, 15).length).toBeGreaterThan(1);
  });

  it("wraps long runs of wide Arial glyphs before they can be clipped", () => {
    const maxWidth = 263;
    const fontSize = 15;
    const cases: Array<[glyph: string, maxGlyphsPerLine: number]> = [
      ["W", 17],
      ["@", 16],
      ["%", 17],
      ["M", 19],
      ["m", 19],
    ];

    for (const [glyph, maxGlyphsPerLine] of cases) {
      const text = glyph.repeat(30);
      const lines = wrapSvgText(text, maxWidth, fontSize);
      expect(lines.join("")).toBe(text);
      expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(
        maxGlyphsPerLine,
      );
    }
  });

  it("lays out user and assistant messages with a footer", () => {
    const layout = buildConversationShareSvgLayout({
      allShareableIds: ["u", "skipped", "a"],
      colors,
      messages: [
        { body: "hello", clientId: "u", kind: "user" },
        { body: "world", clientId: "a", kind: "assistant" },
      ],
      width: 390,
    });

    expect(layout.width).toBe(390);
    expect(layout.bubbles).toHaveLength(2);
    expect(layout.gaps).toHaveLength(1);
    expect(layout.bubbles[0]?.x).toBeGreaterThan(layout.bubbles[1]?.x ?? 0);
    expect(layout.height).toBeGreaterThan(layout.footerY);
    expect(conversationShareSvgRenderSize(layout)).toMatchObject({
      scale: 2,
      sourceTooLarge: false,
      width: 780,
    });
  });

  it("redacts metadata before drawing it", () => {
    const layout = buildConversationShareSvgLayout({
      allShareableIds: ["a"],
      colors,
      messages: [
        {
          attachments: [{ kind: "file", name: "token: sk-12345678" }],
          automationOriginLabel: "token: sk-12345678",
          body: "hello",
          clientId: "a",
          kind: "assistant",
        },
      ],
      width: 390,
    });
    const renderedText =
      layout.bubbles[0]?.textBlocks.flatMap((block) => block.lines).join(" ") ??
      "";
    expect(renderedText).not.toContain("sk-12345678");
    expect(renderedText).toContain("[REDACTED]");
  });

  it("keeps image-only Markdown visible without exposing its source URL", () => {
    const secretUrl = "https://example.com/image.png?token=private-value";
    const layout = buildConversationShareSvgLayout({
      allShareableIds: ["empty-alt", "html", "named-alt"],
      colors,
      messages: [
        {
          body: `![](${secretUrl})`,
          clientId: "empty-alt",
          kind: "assistant",
        },
        {
          body: `<img src="${secretUrl}" alt="">`,
          clientId: "html",
          kind: "assistant",
        },
        {
          body: `![Screenshot](${secretUrl})`,
          clientId: "named-alt",
          kind: "assistant",
        },
      ],
      width: 390,
    });
    const renderedText = layout.bubbles.map((bubble) =>
      bubble.textBlocks.flatMap((block) => block.lines).join(" "),
    );

    expect(renderedText).toEqual([
      i18n.t("message.renderer.imageFallbackTitle"),
      i18n.t("message.renderer.imageFallbackTitle"),
      "Screenshot",
    ]);
    expect(renderedText.join(" ")).not.toContain(secretUrl);
  });

  it("preserves list markers and task state in the exported text", () => {
    const layout = buildConversationShareSvgLayout({
      allShareableIds: ["list"],
      colors,
      messages: [
        {
          body: "- [x] shipped\n- [ ] pending\n1. first\n* bullet\n2. [x] ordered done\n3. [ ] ordered pending",
          clientId: "list",
          kind: "assistant",
        },
      ],
      width: 390,
    });

    expect(layout.bubbles[0]?.textBlocks[0]?.lines).toEqual([
      "[x] shipped",
      "[ ] pending",
      "1. first",
      "* bullet",
      "2. [x] ordered done",
      "3. [ ] ordered pending",
    ]);
  });

  it("preserves semantic plaintext markers without altering chip labels", () => {
    const layout = buildConversationShareSvgLayout({
      allShareableIds: ["chips", "markdown"],
      colors,
      messages: [
        {
          body: "ignored when structured parts are present",
          bodyParts: [
            { kind: "quote", label: "quoted context" },
            { kind: "pasted", label: "pasted text" },
            { kind: "slash", label: "/review" },
          ],
          clientId: "chips",
          kind: "user",
        },
        {
          body: "> do not deploy\n> until reviewed\n\nUse v2, ~~not v1~~",
          clientId: "markdown",
          kind: "assistant",
        },
      ],
      width: 390,
    });

    expect(layout.bubbles[0]?.textBlocks[0]?.lines).toEqual([
      "quoted context",
      "pasted text",
      "/review",
    ]);
    expect(layout.bubbles[1]?.textBlocks[0]?.lines).toEqual([
      "> do not deploy",
      "> until reviewed",
      "Use v2, ~~not v1~~",
    ]);
  });

  it("waits for both footer assets before allowing export", async () => {
    const gate = createConversationShareFooterAssetGate();
    let ready = false;
    const wait = gate.waitUntilReady().then(() => {
      ready = true;
    });

    gate.markReady("character");
    gate.markReady("character");
    await Promise.resolve();
    expect(ready).toBe(false);

    gate.markReady("logo");
    await wait;
    expect(ready).toBe(true);
  });

  it("refuses oversized source layouts before mounting a large SVG", () => {
    expect(
      conversationShareSvgRenderSize({ height: 40_000, width: 390 }),
    ).toEqual({ height: 1, scale: 1, sourceTooLarge: true, width: 1 });
  });
});
