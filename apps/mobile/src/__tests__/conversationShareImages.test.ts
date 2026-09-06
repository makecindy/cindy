import { describe, expect, it, vi } from "vitest";
import { prepareConversationShareImages } from "@/session/conversationShareImages";
import { projectConversationShareMessage } from "@/session/conversationShareProjection";
import { buildConversationShareHtml } from "@/session/conversationShareWebViewHtml";
import { buildConversationShareSvgLayout } from "@/session/conversationShareSvgLayout";
import { lightColors, darkColors } from "@/theme/tokens";

const image = {
  uri: "data:image/png;base64,aGVsbG8=",
  width: 640,
  height: 480,
};

describe("conversation share images", () => {
  it("rejects compressed images above the single-image pixel limit without spending the batch budget", async () => {
    const load = vi.fn(async (url: string) => ({
      ...image,
      width: url.endsWith("huge") ? 100_000 : 2_000,
      height: url.endsWith("huge") ? 100_000 : 2_000,
    }));
    const messages = await prepareConversationShareImages(
      [
        {
          clientId: "m",
          kind: "user",
          body: "keep text",
          attachments: [
            { kind: "image", name: "huge", uri: "cindy-media://huge" },
            { kind: "image", name: "one", uri: "cindy-media://one" },
            { kind: "image", name: "two", uri: "cindy-media://two" },
            { kind: "image", name: "over batch", uri: "cindy-media://three" },
          ],
        },
      ],
      load,
    );
    expect([...messages[0]!.images!.keys()]).toEqual([
      "cindy-media://one",
      "cindy-media://two",
    ]);
    expect(messages[0]!.body).toBe("keep text");
    expect(messages[0]!.attachments).toHaveLength(4);
    expect(load.mock.calls.map(([url]) => url)).not.toContain(
      "cindy-media://three",
    );
  });

  it("charges decoded pixels for repeated sources across attachments, structured/secondary text and messages", async () => {
    const url = "cindy-media://same";
    const load = vi.fn(async () => ({ ...image, width: 2_000, height: 1_000 }));
    const message = {
      clientId: "first",
      kind: "user" as const,
      body: "ignored",
      attachments: [{ kind: "image" as const, name: "paste", uri: url }],
      bodyParts: [{ kind: "text" as const, text: `![body](${url})` }],
      secondaryBody: `![secondary](${url})`,
    };
    const result = await prepareConversationShareImages(
      [
        message,
        { ...message, clientId: "over" },
        { clientId: "last", kind: "assistant", body: `![last](${url})` },
      ],
      load,
    );
    expect(result.map((m) => m.images!.size)).toEqual([1, 0, 1]);
    expect(load).toHaveBeenCalledTimes(1);
    // A rejected oversized occurrence group must not poison a later smaller group.
    const retry = await prepareConversationShareImages(
      [
        { ...message, secondaryBody: `![a](${url})![b](${url})![c](${url})` },
        { ...message, clientId: "later" },
      ],
      load,
    );
    expect(retry.map((m) => m.images!.size)).toEqual([0, 1]);
  });

  it("charges every attachment and Markdown occurrence even when bytes are reused across messages", async () => {
    const largeImage = {
      ...image,
      uri: "data:image/png;base64," + "A".repeat(6 * 1024 * 1024),
    };
    const source = "cindy-media://repeated";
    const load = vi.fn(async () => largeImage);
    const repeated = {
      clientId: "one",
      kind: "user" as const,
      body: `![body](${source})`,
      secondaryBody: `![secondary](${source})`,
      attachments: [{ kind: "image" as const, name: "paste", uri: source }],
    };
    const messages = await prepareConversationShareImages(
      [repeated, { ...repeated, clientId: "two" }],
      load,
    );
    expect(messages[0]?.images?.get(source)).toBe(largeImage);
    expect(messages[1]?.images?.size).toBe(0);
    expect(load).toHaveBeenCalledTimes(1);
    load.mockClear();
    const tooMany = await prepareConversationShareImages(
      [
        {
          ...repeated,
          attachments: Array.from(
            { length: 4 },
            () => repeated.attachments[0]!,
          ),
        },
        { ...repeated, clientId: "later" },
      ],
      load,
    );
    expect(tooMany[0]?.images?.size).toBe(0);
    expect(tooMany[1]?.images?.get(source)).toBe(largeImage);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it.each([lightColors, darkColors])(
    "embeds pasted and inline images in both exporters without source URLs",
    async (theme) => {
      const source = "cindy-media://asset/pasted";
      const inline = "https://example.com/image.png?signature=private";
      const projected = projectConversationShareMessage("user", {
        kind: "user",
        body: `Picture: ![inline](${inline})`,
        attachments: [
          { kind: "image", name: "pasted.png", uri: source, previewable: true },
        ],
      })!;
      const load = vi.fn(async () => image);
      const messages = await prepareConversationShareImages([projected], load);
      const colors = {
        background: theme.surface,
        border: theme.border,
        codeSurface: theme.chatCodeSurface,
        inlineCode: theme.chatInlineCodeText,
        surfaceChip: theme.surfaceChip,
        surfaceElevated: theme.surfaceElevated,
        textPrimary: theme.textPrimary,
        textSecondary: theme.textSecondary,
        textTertiary: theme.textTertiary,
        syntax: {},
      };
      const html = buildConversationShareHtml({
        selectedMessages: messages,
        allShareableIds: ["user"],
        colors,
        contentWidth: 390,
      });
      expect(html.split(`src="${image.uri}"`)).toHaveLength(3);
      expect(html).not.toContain(source);
      expect(html).not.toContain(inline);
      expect(html).toContain("img-src data:");
      const svg = buildConversationShareSvgLayout({
        messages,
        allShareableIds: ["user"],
        colors,
        width: 390,
      });
      expect(svg.images).toHaveLength(2);
      for (const rendered of svg.images) {
        expect(rendered.uri).toBe(image.uri);
        expect(rendered.width / rendered.height).toBeCloseTo(4 / 3);
        expect(rendered.x + rendered.width).toBeLessThanOrEqual(390);
        expect(rendered.y + rendered.height).toBeLessThan(svg.footerY);
      }
    },
  );

  it("reuses attachment bytes, skips code and hidden chip contents, and preserves failures", async () => {
    const load = vi.fn(async (url: string) => {
      if (url.includes("missing")) throw new Error("offline");
      return image;
    });
    const messages = await prepareConversationShareImages(
      [
        {
          clientId: "u",
          kind: "user",
          body: "![hidden](https://hidden.test/image.png)",
          bodyParts: [
            { kind: "quote", label: "![quote](https://quote.test/a.png)" },
            {
              kind: "text",
              text: "```md\n![code](https://code.test/a.png)\n```",
            },
          ],
          attachments: [
            { kind: "image", name: "one", uri: "cindy-media://same" },
            { kind: "image", name: "two", uri: "cindy-media://same" },
            { kind: "image", name: "missing", uri: "cindy-media://missing" },
            { kind: "file", name: "file", uri: "file:///private/file" },
          ],
        },
      ],
      load,
    );
    expect(load.mock.calls.map(([url]) => url)).toEqual([
      "cindy-media://same",
      "cindy-media://missing",
    ]);
    expect(messages[0]?.images?.size).toBe(1);
    expect(messages[0]?.attachments?.[2]?.name).toBe("missing");
  });

  it("routes relative and forged SSH image URLs using the current trusted session", async () => {
    const load = vi.fn(async () => image);
    await prepareConversationShareImages(
      [
        {
          clientId: "m",
          kind: "assistant",
          body: "![relative](./pic.png)\n![forged](xdt-file://open?path=%2Fwork%2Fpic.png&sessionId=other&remoteHostId=evil)",
        },
      ],
      load,
      { workdir: "/work", remoteHostId: "host", sessionId: "session" },
    );
    for (const [url] of load.mock.calls as unknown as [string][]) {
      const parsed = new URL(url);
      expect(parsed.protocol).toBe("xdt-file:");
      expect(parsed.searchParams.get("sessionId")).toBe("session");
      expect(parsed.searchParams.get("remoteHostId")).toBe("host");
      expect(parsed.searchParams.get("v")).toBe("m");
    }
    expect(load).toHaveBeenCalled();
  });

  it("stops reading remaining images when selection is cancelled", async () => {
    let active = true;
    const load = vi.fn(async () => {
      active = false;
      return image;
    });
    const result = await prepareConversationShareImages(
      [
        {
          clientId: "u",
          kind: "user",
          body: "",
          attachments: [
            { kind: "image", name: "one", uri: "cindy-media://one" },
            { kind: "image", name: "two", uri: "cindy-media://two" },
          ],
        },
      ],
      load,
      {},
      () => active,
    );
    expect(load).toHaveBeenCalledTimes(1);
    expect(result).toEqual([]);
  });
});
