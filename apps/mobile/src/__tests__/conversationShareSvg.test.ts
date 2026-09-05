import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "@cindy/maker-shared/error-redaction";

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
  it.each([
    ["password: ", "private-secret"],
    ["pass", "word: private-secret"],
    ["password: private-", "secret"],
    ["Authorization: Basic ", "private-secret"],
    ["sk-abcd", "12345678"],
    ["password: ", "`private-secret`"],
    ["password: ", "**private-secret**"],
    ["password:\n\n", "private-secret"],
    ["token: [REDACTED]\npassword: ", "private-secret"],
  ])("redacts across an image between %s and %s", (before, after) => {
    const url = "cindy-media://same";
    const image = {
      uri: "data:image/png;base64,aGVsbG8=",
      width: 40,
      height: 20,
    };
    const layout = buildConversationShareSvgLayout({
      allShareableIds: ["m"],
      colors,
      width: 390,
      messages: [
        {
          clientId: "m",
          kind: "assistant",
          body: `${before}![one](${url})![two](${url})${after}`,
          images: new Map([[url, image]]),
        },
      ],
    });
    const text = layout.bubbles
      .flatMap((bubble) => bubble.textBlocks.flatMap((block) => block.lines))
      .join("");
    const visible = (before + after).replace(/[`*]/g, "");
    expect(text.replace(/\s/g, "")).toBe(
      redactSensitiveText(visible).replace(/\s/g, ""),
    );
    expect(layout.images).toHaveLength(2);
    expect(layout.images[0]!.y).toBeLessThan(layout.images[1]!.y);
    expect(text).not.toContain("private-secret");
  });

  it.each(["user", "assistant"] as const)(
    "preserves repeated image positions inside a %s bubble, including an attachment with the same source",
    (kind) => {
      const url = "cindy-media://same";
      const image = {
        uri: "data:image/png;base64,aGVsbG8=",
        width: 40,
        height: 20,
      };
      const layout = buildConversationShareSvgLayout({
        allShareableIds: ["m"],
        colors,
        width: 390,
        messages: [
          {
            clientId: "m",
            kind,
            attachments: [{ kind: "image", name: "attachment", uri: url }],
            body: `before ![first](${url}) middle ![second](${url}) after`,
            images: new Map([[url, image]]),
          },
        ],
      });
      expect(layout.images).toHaveLength(3);
      const bubble = layout.bubbles[0]!;
      const text = bubble.textBlocks;
      expect(text.map((block) => block.lines.join(""))).toEqual([
        "before",
        "middle",
        "after",
      ]);
      expect(layout.images[0]!.y + layout.images[0]!.height).toBeLessThan(
        bubble.y,
      );
      expect(text[0]!.y).toBeLessThan(layout.images[1]!.y);
      expect(layout.images[1]!.y + layout.images[1]!.height).toBeLessThan(
        text[1]!.y,
      );
      expect(text[1]!.y).toBeLessThan(layout.images[2]!.y);
      expect(layout.images[2]!.y + layout.images[2]!.height).toBeLessThan(
        text[2]!.y,
      );
      expect(layout.images[2]!.y + layout.images[2]!.height).toBeLessThan(
        bubble.y + bubble.height,
      );
    },
  );

  it("traverses structured text, table cells, and secondary body without parsing code or chip labels as images", () => {
    const url = "cindy-media://same";
    const image = {
      uri: "data:image/png;base64,aGVsbG8=",
      width: 40,
      height: 20,
    };
    const layout = buildConversationShareSvgLayout({
      allShareableIds: ["m"],
      colors,
      width: 390,
      messages: [
        {
          clientId: "m",
          kind: "assistant",
          body: "ignored",
          images: new Map([[url, image]]),
          bodyParts: [
            { kind: "quote", label: `![chip](${url})` },
            {
              kind: "text",
              text: `> quote ![quote image](${url})\n\n- item ![list image](${url})\n\n| header ![head](${url}) | next |\n| --- | --- |\n| ![cell](${url}) | last |\n\n\`\`\`md\n![code](${url})\n\`\`\``,
            },
          ],
          secondaryBody: `secondary ![last](${url}) end`,
        },
      ],
    });
    expect(layout.images).toHaveLength(5);
    expect(layout.images.map((image) => image.y)).toEqual(
      layout.images.map((image) => image.y).sort((a, b) => a - b),
    );
    const text = layout.bubbles
      .flatMap((bubble) => bubble.textBlocks.flatMap((block) => block.lines))
      .join("\n");
    expect(text).toContain("![chip]");
    expect(text).toContain("![code]");
    expect(text).not.toContain("quote image");
    expect(text).toContain("secondary");
  });

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
