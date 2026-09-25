import { describe, expect, it } from "vitest";
import { buildConversationShareSvgLayout } from "@/session/conversationShareSvgLayout";
import { lightColors, darkColors } from "@/theme/tokens";

describe("structured share fallback", () => {
  it.each([lightColors, darkColors])(
    "retains Markdown styles and table cells within the canvas",
    (c) => {
      const colors = {
        background: c.surface,
        surfaceElevated: c.surfaceElevated,
        border: c.border,
        codeSurface: c.chatCodeSurface,
        inlineCode: c.chatInlineCodeText,
        surfaceChip: c.surfaceChip,
        textPrimary: c.textPrimary,
        textSecondary: c.textSecondary,
        textTertiary: c.textTertiary,
        syntax: { keyword: c.syntaxKeyword, string: c.syntaxString },
      };
      const layout = buildConversationShareSvgLayout({
        allShareableIds: ["m"],
        colors,
        width: 320,
        messages: [
          {
            clientId: "m",
            kind: "assistant",
            body: '# Heading\n\n**bold** *italic* ~~deleted~~ [link](https://example.com) `code`\n\n| A | B | C | D |\n|---|---|---|---|\n| 中文很长需要换行 | **value** | 12345678901234567890 | last |\n\n```js\nconst value = "hello";\n    return value;\n```',
          },
        ],
      });
      const body = layout.bubbles[0]!;
      const text = body.textBlocks;
      const find = (word: string) =>
        text.find((t) => t.lines.join("") === word);
      expect(find("Heading")?.fontSize).toBeGreaterThan(find("bold")!.fontSize);
      expect(find("bold")?.bold).toBe(true);
      expect(find("italic")?.italic).toBe(true);
      expect(find("deleted")?.decoration).toBe("line-through");
      expect(find("link")?.decoration).toBe("underline");
      expect(find("code")?.monospace).toBe(true);
      expect(find("const")?.color).toBe(c.syntaxKeyword);
      expect(
        text.some((t) => t.monospace && t.lines[0]?.startsWith("    ")),
      ).toBe(true);
      const cells = body.rectangles!.filter((r) => r.rx === undefined);
      expect(cells).toHaveLength(8);
      expect(cells[4]!.height).toBeGreaterThan(cells[0]!.height);
      for (const r of body.rectangles!) {
        expect(r.x).toBeGreaterThanOrEqual(body.x);
        expect(r.x + r.width).toBeLessThanOrEqual(body.x + body.width + 0.01);
        expect(r.y + r.height).toBeLessThanOrEqual(body.y + body.height);
      }
      expect(text.map((t) => t.lines.join("")).join("")).not.toContain(" | ");
    },
  );

  it("keeps repeated images inside their own table cells and grows the row", () => {
    const image = {
      uri: "data:image/png;base64,YQ==",
      width: 100,
      height: 150,
    };
    const layout = buildConversationShareSvgLayout({
      allShareableIds: ["m"],
      width: 390,
      colors: {
        background: "white",
        surfaceElevated: "white",
        border: "gray",
        codeSurface: "gray",
        inlineCode: "black",
        surfaceChip: "gray",
        textPrimary: "black",
        textSecondary: "gray",
        textTertiary: "gray",
        syntax: {},
      },
      messages: [
        {
          clientId: "m",
          kind: "user",
          body: "| A | B |\n|---|---|\n| ![a](cindy-media://same) | ![b](cindy-media://same) |",
          images: new Map([["cindy-media://same", image]]),
        },
      ],
    });
    expect(layout.images).toHaveLength(2);
    const [left, right] = layout.images;
    expect(left!.y).toBe(right!.y);
    expect(left!.x + left!.width).toBeLessThan(right!.x);
    const row = layout.bubbles[0]!.rectangles![2]!;
    expect(left!.y + left!.height).toBeLessThan(row.y + row.height);
  });
});
