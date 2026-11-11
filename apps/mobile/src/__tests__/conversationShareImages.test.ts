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
  // Unit #8085 review r4429685137: live video-site previews are web pages,
  // not native media bytes. Exercise the export queue and HTML fallback; the
  // existing media tests only cover direct files. One page plus one MP4 proves
  // that skipping web decoding preserves both the placeholder and file covers.
  it("keeps a YouTube placeholder without sending the page to the video decoder", async () => {
    const page = "https://youtu.be/glW1pXWebnY";
    const clip = "https://media.invalid/clip.mp4";
    const body = "```cindy-ui\n" + [
      { version: 1, seq: 1, op: "create", id: "site", kind: "video", props: { src: page, caption: "Site video" } },
      { seq: 2, op: "create", id: "clip", kind: "video", props: { src: clip } },
    ].map(value => JSON.stringify(value)).join("\n") + "\n```";
    const load = vi.fn(async () => image);
    const messages = await prepareConversationShareImages([{ clientId: "v", kind: "assistant", body }], load);
    expect(load).toHaveBeenCalledExactlyOnceWith(clip, "video");
    expect(messages[0]?.images?.has(page)).toBe(false);
    const colors = { ...lightColors, background: lightColors.surface, codeSurface: lightColors.chatCodeSurface,
      inlineCode: lightColors.chatInlineCodeText, syntax: {} };
    const html = buildConversationShareHtml({ selectedMessages: messages, allShareableIds: ["v"], colors, contentWidth: 390 });
    expect(html).toContain("Site video");
    expect(html.match(/<circle/g)).toHaveLength(2);
    expect(html).not.toContain(page);
    expect(html).toContain(image.uri);
  });
  // Unit regression #8085: image Markdown parsing drops the supported xdt-video
  // scheme. A visible legacy video must reach the video decoder directly.
  it("loads legacy video sources without the image protocol whitelist", async () => {
    const url = "xdt-video://open?path=%2Fwork%2Fclip.mp4";
    const body = "```cindy-ui\n" + JSON.stringify({ version: 1, seq: 1, op: "create", id: "v", kind: "video", props: { src: url } }) + "\n```";
    const load = vi.fn(async () => image);
    const [message] = await prepareConversationShareImages([{ clientId: "v", kind: "assistant", body }], load);
    expect(load).toHaveBeenCalledExactlyOnceWith(url, "video");
    expect(message?.images?.get(url)).toEqual(image);
  });
  // Unit: repeated video frames consume the same per-occurrence bitmap budget
  // as images, even though their decoder request is deduplicated by URL.
  it("charges every occurrence of a repeated video cover", async () => {
    const url = "xdt-video://open?path=%2Fwork%2Fclip.mp4";
    const body = "```cindy-ui\n" + [0, 1, 2].map(index => JSON.stringify({ version: 1, seq: index + 1, op: "create", id: `v${index}`, kind: "video", props: { src: url } })).join("\n") + "\n```";
    const load = vi.fn(async () => ({ ...image, width: 2000, height: 2000 }));
    const [message] = await prepareConversationShareImages([{ clientId: "v", kind: "assistant", body }], load);
    expect(load).toHaveBeenCalledExactlyOnceWith(url, "video");
    expect(message?.images?.size).toBe(0);
  });
  // Unit regression: sharing a visible cindy-ui video used to export only its alt
  // text. Exercise preparation and both real exporters, including hidden tabs.
  it.each([lightColors, darkColors])(
    "keeps visible video covers and play marks in both exporters",
    async (theme) => {
      const url = "cindy-media://blobs/clip.mp4";
      const body =
        "```cindy-ui\n" +
        [
          { version: 1, seq: 1, op: "create", id: "tabs", kind: "tabs" },
          { seq: 2, op: "create", id: "shown", parent: "tabs", kind: "stack" },
          { seq: 3, op: "create", id: "hidden", parent: "tabs", kind: "stack" },
          {
            seq: 4,
            op: "create",
            id: "clip",
            parent: "shown",
            kind: "video",
            props: { src: url, alt: "A video", caption: "Our clip" },
          },
          {
            seq: 5,
            op: "create",
            id: "secret",
            parent: "hidden",
            kind: "video",
            props: { src: "cindy-media://hidden.mp4" },
          },
        ]
          .map((operation) => JSON.stringify(operation))
          .join("\n") +
        "\n```";
      const load = vi.fn(async () => image);
      const messages = await prepareConversationShareImages(
        [{ clientId: "v", kind: "assistant", body }],
        load,
      );
      expect(load).toHaveBeenCalledExactlyOnceWith(url, "video");
      const colors = {
        ...theme,
        background: theme.surface,
        codeSurface: theme.chatCodeSurface,
        inlineCode: theme.chatInlineCodeText,
        syntax: {},
      };
      const html = buildConversationShareHtml({
        selectedMessages: messages,
        allShareableIds: ["v"],
        colors,
        contentWidth: 390,
      });
      expect(html).toContain(image.uri);
      expect(html).toContain("<circle");
      expect(html).not.toContain(url);
      expect(html).not.toContain("hidden.mp4");
      const svg = buildConversationShareSvgLayout({
        messages,
        allShareableIds: ["v"],
        colors,
        width: 390,
      });
      expect(svg.images).toHaveLength(1);
      expect(svg.images[0]?.uri).toBe(image.uri);
      expect(
        svg.bubbles
          .flatMap((bubble) => bubble.vectors ?? [])
          .flatMap((vector) => vector.vector.shapes)
          .some((shape) => shape.type === "circle"),
      ).toBe(true);
      const fallback = buildConversationShareHtml({
        selectedMessages: messages.map((message) => ({
          ...message,
          images: new Map(),
        })),
        allShareableIds: ["v"],
        colors,
        contentWidth: 390,
      });
      expect(fallback).toContain("<circle");
      expect(fallback).toContain("Our clip");
      expect(fallback).not.toContain(url);
    },
  );

  it("lets free workers advance across messages while the first source is stalled", async () => {
    const finishes = new Map<string, (value: typeof image | null) => void>();
    let active = 0;
    let peak = 0;
    const load = vi.fn((url: string) => {
      peak = Math.max(peak, ++active);
      return new Promise<typeof image | null>((resolve) =>
        finishes.set(url, resolve),
      ).finally(() => {
        active--;
      });
    });
    const messages = Array.from({ length: 6 }, (_, i) => ({
      clientId: String(i),
      kind: "user" as const,
      body: "",
      attachments: [
        { kind: "image" as const, name: String(i), uri: `cindy-media://${i}` },
      ],
    }));
    const pending = prepareConversationShareImages(messages, load);
    expect(load).toHaveBeenCalledTimes(3);
    for (let i = 1; i < 6; i++) {
      await vi.waitFor(() =>
        expect(finishes.has(`cindy-media://${i}`)).toBe(true),
      );
      finishes.get(`cindy-media://${i}`)!(image);
    }
    finishes.get("cindy-media://0")!(null);
    const result = await pending;
    expect(peak).toBe(3);
    expect(load).toHaveBeenCalledTimes(6);
    expect(result.map((m) => m.clientId)).toEqual(
      messages.map((m) => m.clientId),
    );
    expect(result.map((m) => m.images!.size)).toEqual([0, 1, 1, 1, 1, 1]);
  });

  it("admits ready sources within both occurrence budgets and discards cancelled late loads", async () => {
    for (const cancel of [false, true]) {
      let active = true;
      const finishes = new Map<string, (value: typeof image) => void>();
      const load = vi.fn(
        (url: string) =>
          new Promise<typeof image>((done) => finishes.set(url, done)),
      );
      const urls = ["first", "second", "third", "queued"];
      const pending = prepareConversationShareImages(
        [
          {
            clientId: "m",
            kind: "user",
            body: "",
            attachments: urls.flatMap((url) =>
              Array.from({ length: 2 }, () => ({
                kind: "image" as const,
                name: url,
                uri: url,
              })),
            ),
          },
        ],
        load,
        {},
        () => active,
      );
      expect(load).toHaveBeenCalledTimes(3);
      if (cancel) active = false;
      const large = {
        ...image,
        width: 2000,
        height: 2000,
        uri: "data:image/png;base64," + "A".repeat(10 * 1024 * 1024),
      };
      finishes.get("second")!(large);
      finishes.get("third")!(large);
      finishes.get("first")!(large);
      const result = await pending;
      expect(load).toHaveBeenCalledTimes(3);
      if (cancel) expect(result).toEqual([]);
      else expect([...result[0]!.images!.keys()]).toEqual(["second"]);
    }
  });

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
    expect(load).toHaveBeenCalledTimes(1);
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
    const load = vi.fn((url: string) => {
      if (url.includes("missing")) throw new Error("offline");
      return Promise.resolve(image);
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

// Regression: assistant components were exported as JSON and their images were never loaded.
// Production entry: prepareConversationShareImages → HTML/native SVG builders (unit tier).
// Existing cases only exercised Markdown image syntax, not component media or local view state.
it("exports composed images, values, charts and vectors on both capture paths without operation text", async () => {
  const ops = [
    {
      kind: "image",
      id: "photo",
      props: {
        src: "cindy-media://blobs/sample.png",
        alt: "页面对比",
        caption: "同一份内容",
      },
    },
    { kind: "grid", id: "stats", props: { columns: 4, mobileColumns: 2 } },
    ...[48, 12, 36, 7].map((value, index) => ({
      kind: "stat",
      id: `s${index}`,
      parent: "stats",
      props: { label: ["全部", "进行中", "已完成", "待处理"][index], value },
    })),
    {
      kind: "range",
      id: "months",
      props: { label: "月数", default: 1, min: 1, max: 12 },
    },
    {
      kind: "stat",
      id: "total",
      props: {
        label: "费用",
        value: { op: "mul", args: [{ ref: "months" }, 20] },
      },
    },
    {
      kind: "chart",
      id: "trend",
      props: {
        label: "趋势",
        variant: "line",
        data: [
          { label: "一月", value: 12 },
          { label: "二月", value: 36 },
        ],
      },
    },
    {
      kind: "svg",
      id: "vector",
      props: {
        viewBox: [0, 0, 300, 80],
        shapes: [
          { type: "circle", cx: 40, cy: 40, r: 20, fill: "primary" },
          { type: "text", x: 75, y: 45, text: "示意图" },
        ],
      },
    },
    { kind: "details", id: "hidden", props: { label: "附录", default: false } },
    {
      kind: "image",
      id: "hiddenPhoto",
      parent: "hidden",
      props: { src: "cindy-media://blobs/hidden.png", alt: "隐藏图片" },
    },
  ].map((node, index) =>
    JSON.stringify({ version: 1, seq: index + 1, op: "create", ...node }),
  );
  const body = "```cindy-ui\n" + ops.join("\n") + "\n```";
  const load = vi.fn(async () => image);
  const messages = await prepareConversationShareImages(
    [
      {
        clientId: "rich",
        kind: "assistant",
        body,
        richValues: { 0: { months: 6 } },
      },
    ],
    load,
  );
  expect(load.mock.calls).toEqual([["cindy-media://blobs/sample.png"]]);
  for (const theme of [lightColors, darkColors]) {
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
      allShareableIds: ["rich"],
      colors,
      contentWidth: 390,
      selectedMessages: messages,
    });
    const layout = buildConversationShareSvgLayout({
      allShareableIds: ["rich"],
      colors,
      width: 390,
      messages,
    });
    const text = layout.bubbles
      .flatMap((bubble) => bubble.textBlocks.flatMap((block) => block.lines))
      .join("");
    expect(text).toContain("120");
    expect(html).toContain("120");
    expect(html).toContain(image.uri);
    expect(layout.images).toHaveLength(1);
    expect(layout.bubbles.flatMap((b) => b.vectors ?? [])).toHaveLength(2);
    expect(html).toContain("<circle");
    expect(html).not.toContain("cindy-media://");
    expect(html).not.toContain("&quot;op&quot;");
    expect(text).not.toContain('"op"');
    expect(text).not.toContain("隐藏图片");
    const labels = layout.bubbles
      .flatMap((b) => b.textBlocks)
      .filter((b) =>
        ["全部", "进行中", "已完成", "待处理"].includes(b.lines.join("")),
      );
    expect(labels).toHaveLength(4);
    expect(labels[0]!.y).toBe(labels[1]!.y);
    expect(labels[2]!.y).toBeGreaterThan(labels[0]!.y);
  }
  const user = await prepareConversationShareImages(
    [{ clientId: "example", kind: "user", body }],
    load,
  );
  expect(user[0]!.images!.size).toBe(0); // User-authored examples remain code.
});

// Regression: trimming before splitting shifted local-state keys in the iOS exporter.
// The real media preparation and both output builders must agree on visible content (unit).
it("keeps leading-whitespace component keys aligned with edited values and image visibility", async () => {
  const nodes = [
    {
      id: "months",
      kind: "range",
      props: { label: "Months", min: 1, max: 12, default: 1 },
    },
    {
      id: "plan",
      kind: "select",
      props: {
        label: "Plan",
        default: "basic",
        options: [
          { label: "Basic", value: "basic" },
          { label: "Selected plan", value: "chosen" },
        ],
      },
    },
    { id: "details", kind: "details", props: { label: "More", default: false } },
    {
      id: "photo",
      kind: "image",
      parent: "details",
      props: { src: "cindy-media://blobs/edited.png", alt: "Visible photo" },
    },
  ];
  const body =
    "\n```cindy-ui\n" +
    nodes.map((node, index) =>
      JSON.stringify({ version: 1, seq: index + 1, op: "create", ...node }),
    ).join("\n") +
    "\n```\n";
  const load = vi.fn(async () => image);
  const messages = await prepareConversationShareImages(
    [{ clientId: "edited", kind: "assistant", body,
      richValues: { 1: { months: 6, plan: "chosen", details: true } } }],
    load,
  );
  expect(load.mock.calls).toEqual([["cindy-media://blobs/edited.png"]]);
  const colors = {
    ...lightColors, background: lightColors.surface,
    codeSurface: lightColors.chatCodeSurface,
    inlineCode: lightColors.chatInlineCodeText, syntax: {},
  };
  const html = buildConversationShareHtml({
    selectedMessages: messages, allShareableIds: ["edited"], contentWidth: 390, colors,
  });
  const layout = buildConversationShareSvgLayout({
    messages, allShareableIds: ["edited"], width: 390, colors,
  });
  const text = layout.bubbles
    .flatMap((b) => b.textBlocks.flatMap((b) => b.lines)).join("\n");
  for (const output of [html, text]) {
    expect(output).toContain("Months  6");
    expect(output).toContain("Selected plan");
    expect(output).not.toContain("Basic");
  }
  expect(html).toContain(image.uri);
  expect(layout.images).toHaveLength(1);
});

// Regression: a legal name-only icon disappeared from both export paths (unit).
it("exports icon names as fallback titles and preserves explicit labels and text", async () => {
  const nodes = [
    { id: "named", kind: "icon", props: { name: "Info" } },
    {
      id: "labelled", kind: "icon",
      props: { name: "Star", label: "Custom title", text: "Supporting text" },
    },
  ];
  const body =
    "```cindy-ui\n" +
    nodes.map((node, index) =>
      JSON.stringify({ version: 1, seq: index + 1, op: "create", ...node }),
    ).join("\n") +
    "\n```";
  const messages = await prepareConversationShareImages(
    [{ clientId: "icons", kind: "assistant", body }], vi.fn(async () => image),
  );
  const colors = {
    ...lightColors, background: lightColors.surface,
    codeSurface: lightColors.chatCodeSurface,
    inlineCode: lightColors.chatInlineCodeText, syntax: {},
  };
  const html = buildConversationShareHtml({
    selectedMessages: messages, allShareableIds: ["icons"], contentWidth: 390, colors,
  });
  const layout = buildConversationShareSvgLayout({
    messages, allShareableIds: ["icons"], width: 390, colors,
  });
  const text = layout.bubbles
    .flatMap((b) => b.textBlocks.flatMap((b) => b.lines)).join("\n");
  for (const output of [html, text]) {
    expect(output).toContain("Info");
    expect(output).toContain("Custom title");
    expect(output).toContain("Supporting text");
    expect(output).not.toContain("Star");
  }
});

// A selected option label is visible output, even though its stored value is harmless.
// Regression guard for the new component projection crossing the existing redaction boundary.
it("redacts resolved component content before either capture path renders it", () => {
  const body =
    "```cindy-ui\n" +
    JSON.stringify({
      version: 1,
      seq: 1,
      op: "create",
      id: "choice",
      kind: "select",
      props: {
        label: "配置",
        default: "one",
        options: [{ value: "one", label: "password: private-selected-secret" }],
      },
    }) +
    "\n```";
  const messages = [{ clientId: "rich", kind: "assistant" as const, body }];
  const colors = {
    background: lightColors.surface,
    border: lightColors.border,
    codeSurface: lightColors.chatCodeSurface,
    inlineCode: lightColors.chatInlineCodeText,
    surfaceChip: lightColors.surfaceChip,
    surfaceElevated: lightColors.surfaceElevated,
    textPrimary: lightColors.textPrimary,
    textSecondary: lightColors.textSecondary,
    textTertiary: lightColors.textTertiary,
    syntax: {},
  };
  const html = buildConversationShareHtml({
    allShareableIds: ["rich"],
    colors,
    contentWidth: 390,
    selectedMessages: messages,
  });
  const layout = buildConversationShareSvgLayout({
    allShareableIds: ["rich"],
    colors,
    width: 390,
    messages,
  });
  const text = layout.bubbles
    .flatMap((bubble) => bubble.textBlocks.flatMap((block) => block.lines))
    .join("");
  expect(html).not.toContain("private-selected-secret");
  expect(text).not.toContain("private-selected-secret");
  expect(html).toContain("配置");
  expect(text).toContain("配置");
});
