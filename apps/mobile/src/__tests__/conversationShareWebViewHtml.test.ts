import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";

import {
  buildConversationShareHtml,
  buildConversationShareContentWidth,
  type ConversationShareWebViewColors,
} from "@/session/conversationShareWebViewHtml";
import { i18n } from "@/i18n";
import { buildConversationShareSvgLayout } from "@/session/conversationShareSvgLayout";

const colors: ConversationShareWebViewColors = {
  background: "#ffffff",
  border: "#dddddd",
  codeSurface: "#f5f5f5",
  dark: true,
  inlineCode: "#333333",
  surfaceChip: "#f2f2f2",
  surfaceElevated: "#fafafa",
  syntax: {
    comment: "#777777",
    function: "#0055aa",
    keyword: "#aa0055",
    number: "#995500",
    property: "#006655",
    string: "#885500",
  },
  textPrimary: "#111111",
  textSecondary: "#555555",
  textTertiary: "#888888",
};

function buildRichConversationHtml(): string {
  return buildConversationShareHtml({
    allShareableIds: ["math", "diagram"],
    colors,
    contentWidth: 390,
    selectedMessages: [
      {
        body: ["$$", "x^2 + y^2", "$$"].join("\n"),
        clientId: "math",
        kind: "assistant",
      },
      {
        body: ["```mermaid", "graph TD", "A --> B", "```"].join("\n"),
        clientId: "diagram",
        kind: "assistant",
      },
    ],
  });
}

it('bounds cleanup to old share PNGs while retaining recent successful files', async () => {
  const source = ts.createSourceFile('share.tsx', readFileSync(resolve(process.cwd(), 'src/session/ConversationShareWebView.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = source.statements.filter((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => ['EXPORT_DIR_NAME', 'SHARE_PNG_RETAIN_COUNT', 'SHARE_PNG_CLEANUP_BATCH'].includes(item.name.getText(source))));
  const cleanup = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'cleanupConversationSharePngTemps');
  if (!cleanup) throw new Error('Missing production share cleanup');
  class File {
    extension = '.png'; exists = true; uri: string;
    constructor(public name: string, public modificationTime: number) { this.uri = 'file:///cache/conversation-share/' + name; }
  }
  const files = Array.from({ length: 16 }, (_, i) => new File('conversation-' + i + '.png', i));
  files.push(new File('unrelated.png', 30));
  const remove = vi.fn(async (_uri: string) => undefined);
  const Directory = class { exists = true; list() { return files; } };
  const code = ts.transpileModule(declarations.map((node) => node.getText(source)).join('\n') + '\n' + cleanup.getText(source).replace(/^export\s+/, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const run = new Function('File', 'Directory', 'Paths', 'deleteConversationSharePngTemp', code + '\nreturn cleanupConversationSharePngTemps;')(File, Directory, { cache: 'cache' }, remove);
  await run();
  expect(remove.mock.calls.map((call) => call[0])).toEqual(files.slice(5, 13).reverse().map((file) => file.uri));
  expect(remove).toHaveBeenCalledTimes(8);
});

it('keeps approved footer output and a visible gap between non-adjacent selected messages', () => {
  const footer = buildRichConversationHtml();
  expect(footer).toContain('width: 22px;');
  expect(footer).toContain('height: 18px;');
  expect(footer).toContain('gap: 6px;');
  const html = buildConversationShareHtml({ allShareableIds: ['first', 'middle', 'third'], colors, contentWidth: 390,
    selectedMessages: [{ body: 'first', clientId: 'first', kind: 'user' }, { body: 'third', clientId: 'third', kind: 'assistant' }] });
  expect(html).toContain('<div class="share-gap" aria-hidden="true">⋯</div>');
});

describe("buildConversationShareHtml 富内容导出", () => {
  it.each([
    { width: 390, height: 844, expectedWidth: 390 },
    { width: 660, height: 390, expectedWidth: 564 },
    { width: 1024, height: 1366, expectedWidth: 760 },
    // 双栏右侧面板的宽度；不可用整个窗口宽度代替。
    { width: 704, height: 768, expectedWidth: 608 },
  ])("两条出图路径使用聊天可读宽度（$width × $height）", ({ width, height, expectedWidth }) => {
    const contentWidth = buildConversationShareContentWidth({ width, height });
    expect(contentWidth).toBe(expectedWidth);
    const messages = [{ clientId: "user", kind: "user" as const, body: "正文 ".repeat(200) }];
    const html = buildConversationShareHtml({
      allShareableIds: ["user"], colors, contentWidth, selectedMessages: messages,
    });
    const svg = buildConversationShareSvgLayout({
      allShareableIds: ["user"], colors, width: contentWidth, messages,
    });
    expect(html).toMatch(new RegExp(`#xdt-content\\.share-stage \\{[^}]*width: ${expectedWidth}px`));
    expect(svg.width).toBe(expectedWidth);
    expect(svg.bubbles[0]!.width).toBe(Math.round((expectedWidth - 32) * 0.86));
    expect(svg.bubbles[0]!.x + svg.bubbles[0]!.width).toBe(expectedWidth - 16);
  });

  it.each([
    { contentWidth: 360, dark: false },
    { contentWidth: 360, dark: true },
    { contentWidth: 390, dark: false },
    { contentWidth: 390, dark: true },
  ])(
    "分享图片的表格换行适配画布（$contentWidth / dark=$dark）",
    ({ contentWidth, dark }) => {
      const html = buildConversationShareHtml({
        allShareableIds: ["table"],
        colors: { ...colors, dark },
        contentWidth,
        selectedMessages: [
          {
            clientId: "table",
            kind: "assistant",
            body: "| A | B | C | D |\n| --- | --- | --- | --- |\n| Alpha | Beta | Gamma | Delta |",
          },
        ],
      });
      expect(html).toContain("<table>");
      expect(html).toMatch(/th, td \{[^}]*min-width:\s*0px/s);
      expect(html).toMatch(
        /#xdt-content table \{[^}]*table-layout:\s*fixed[^}]*width:\s*100%/s,
      );
      expect(html).not.toContain("width: max-content");
    },
  );

  it("继续脱敏跨行内格式和段落拆开的凭证", () => {
    const html = buildConversationShareHtml({
      allShareableIds: ["secret"],
      colors,
      contentWidth: 390,
      selectedMessages: [
        {
          clientId: "secret",
          kind: "assistant",
          body: "password: `private-code-secret`\n\nAuthorization: Basic **private-strong-secret**\n\npassword:\n\nprivate-paragraph-secret",
        },
      ],
    });
    expect(html).not.toContain("private-");
    expect(html).toContain("[REDACTED]");
  });

  it.each(["token", "access_token", "api_key"])(
    "带 %s 的已准备图片使用 SVG 备用成图，保留图片和脱敏文字",
    (parameter) => {
      const url = `https://example.com/pic.png?${parameter}=private-image-secret`;
      const uri = "data:image/png;base64,aGVsbG8=";
      const picture = `![picture](${url})`;
      const options = {
        allShareableIds: ["plain", "parts"],
        colors,
        contentWidth: 390,
        selectedMessages: [
          {
            clientId: "plain",
            kind: "assistant" as const,
            body: picture,
            images: new Map([[url, { uri, width: 40, height: 20 }]]),
          },
          {
            clientId: "parts",
            kind: "user" as const,
            body: "",
            bodyParts: [
              {
                kind: "text" as const,
                text: `| image |\n| --- |\n| ${picture} |`,
              },
            ],
            secondaryBody: `${picture}\n\npassword=private-text-secret\n\n[link](https://example.com/?token=private-link-secret)\n\n\`\`\`text\npassword=private-code-secret\n\`\`\``,
            images: new Map([[url, { uri, width: 40, height: 20 }]]),
          },
        ],
      };
      expect(() => buildConversationShareHtml(options)).toThrow(
        "conversation-share-image-requires-svg",
      );
      const svg = buildConversationShareSvgLayout({
        ...options,
        width: 390,
        messages: options.selectedMessages,
      });
      expect(svg.images).toHaveLength(3);
      expect(svg.images.every((image) => image.uri === uri)).toBe(true);
      expect(JSON.stringify(svg)).not.toContain("private-");
      expect(JSON.stringify(svg)).not.toContain(url);
      expect(JSON.stringify(svg)).toContain("[REDACTED]");
    },
  );

  it.each(["body", "bodyParts", "secondaryBody"] as const)(
    "%s 中图片语法受到脱敏影响时由 SVG 保留图片或替代文字",
    (field) => {
      const url = "https://example.com/p.png";
      const body = `password: private![preview](${url})`;
      for (const prepared of [false, true]) {
        const message = {
          clientId: "m",
          kind: "assistant" as const,
          body: "",
          ...(field === "bodyParts"
            ? { bodyParts: [{ kind: "text" as const, text: body }] }
            : { [field]: body }),
          images: new Map(
            prepared
              ? [
                  [
                    url,
                    {
                      uri: "data:image/png;base64,aGVsbG8=",
                      width: 40,
                      height: 20,
                    },
                  ],
                ]
              : [],
          ),
        };
        const options = {
          allShareableIds: ["m"],
          colors,
          contentWidth: 390,
          selectedMessages: [message],
        };
        expect(() => buildConversationShareHtml(options)).toThrow(
          "conversation-share-image-requires-svg",
        );
        const svg = buildConversationShareSvgLayout({
          ...options,
          width: 390,
          messages: [message],
        });
        expect(svg.images).toHaveLength(prepared ? 1 : 0);
        expect(JSON.stringify(svg)).not.toContain("private");
        expect(JSON.stringify(svg)).not.toContain(url);
      }
    },
  );

  it("只按选中内容嵌入对应的富内容运行时", () => {
    const plainHtml = buildConversationShareHtml({
      allShareableIds: ["plain"],
      colors,
      contentWidth: 390,
      selectedMessages: [
        { body: "plain text", clientId: "plain", kind: "assistant" },
      ],
    });
    const mathHtml = buildConversationShareHtml({
      allShareableIds: ["math"],
      colors,
      contentWidth: 390,
      selectedMessages: [
        {
          body: ["$$", "x^2 + y^2", "$$"].join("\n"),
          clientId: "math",
          kind: "assistant",
        },
      ],
    });
    const mermaidHtml = buildConversationShareHtml({
      allShareableIds: ["diagram"],
      colors,
      contentWidth: 390,
      selectedMessages: [
        {
          body: ["```mermaid", "graph TD", "A --> B", "```"].join("\n"),
          clientId: "diagram",
          kind: "assistant",
        },
      ],
    });

    expect(plainHtml).not.toContain("window.katex.render");
    expect(plainHtml).not.toContain("window.mermaid.render");
    expect(mathHtml).toContain("window.katex.render");
    expect(mathHtml).not.toContain("window.mermaid.render");
    expect(mermaidHtml).not.toContain("window.katex.render");
    expect(mermaidHtml).toContain("window.mermaid.render");
  });

  it("保留公式与 Mermaid 语义，并注入对应运行时升级脚本", () => {
    const html = buildRichConversationHtml();

    expect(html).toContain('data-latex="x^2 + y^2"');
    expect(html).toContain('data-mermaid-source="graph TD\nA --&gt; B"');
    expect(html).toContain("window.katex.render");
    expect(html).toContain("window.mermaid.render");
    expect(html).toContain("theme: 'dark'");
    expect(html).toContain(
      "window.__cindyConversationShareRichContentReady = true",
    );
  });

  it("只使用离线资源，并在导出前等待富内容和图片解码", () => {
    const html = buildRichConversationHtml();

    expect(html).toContain("default-src 'none';");
    expect(html).toContain("img-src data:;");
    expect(html).not.toContain("img-src data: https:");
    expect(html).toContain("script-src 'unsafe-inline';");
    expect(html).toContain(
      "waitForRichContent().then(waitForImages).then(waitForFonts)",
    );
    expect(html).toContain("image.decode().catch(function () {})");
    expect(html).toContain("document.fonts.ready");
    expect(html).toContain("document.querySelectorAll('style')");
    expect(html).toContain(
      "throw new Error('conversation-share-content-too-large')",
    );
  });

  it("外链图片无法离线带入时保留可见占位", () => {
    const html = buildConversationShareHtml({
      allShareableIds: ["image"],
      colors,
      contentWidth: 390,
      selectedMessages: [
        {
          body: "![](https://example.com/image.png)",
          clientId: "image",
          kind: "assistant",
        },
      ],
    });

    expect(html).toContain(
      `<span class="xdt-image-chip">${i18n.t("message.renderer.imageFallbackTitle")}</span>`,
    );
    expect(html).not.toContain("https://example.com/image.png");
  });

  it("导出结构化正文和附件时保留可见投影，不泄露隐藏引用或外链", () => {
    const html = buildConversationShareHtml({
      allShareableIds: ["message"],
      colors,
      contentWidth: 390,
      selectedMessages: [
        {
          attachments: [
            { kind: "image", name: "preview.png" },
            { kind: "image", name: "remote.png" },
            { kind: "file", name: "notes.md" },
          ],
          body: "visible fallback",
          bodyParts: [
            { kind: "quote", label: "quoted context" },
            { kind: "pasted", label: "Pasted text · 120 chars" },
            { kind: "slash", label: "/review" },
            { kind: "text", text: "reply" },
          ],
          clientId: "message",
          kind: "user",
        },
      ],
    });

    expect(html).toContain("quoted context");
    expect(html).toContain("Pasted text · 120 chars");
    expect(html).toContain("/review");
    expect(html).not.toContain(
      'share-inline-chip-icon" aria-hidden="true">/</span>',
    );
    expect(html).toContain("preview.png");
    expect(html).not.toContain('<img class="share-attachment-image"');
    expect(html).toContain("remote.png");
    expect(html).toContain("notes.md");
    expect(html).not.toContain("visible fallback");
    expect(html).not.toContain("https://example.com/private.png");
  });

  it("附件-only 消息不生成空白文字气泡", () => {
    const html = buildConversationShareHtml({
      allShareableIds: ["attachment"],
      colors,
      contentWidth: 390,
      selectedMessages: [
        {
          attachments: [{ kind: "file", name: "report.pdf" }],
          body: "",
          clientId: "attachment",
          kind: "user",
        },
      ],
    });

    expect(html).toContain("share-attachment-chip-file");
    expect(html).not.toContain('share-bubble-user">');
  });
});

describe("buildConversationShareHtml 与聊天气泡同款渲染", () => {
  const ownUserBubble = { background: "#e8f0ff", border: "#b5c8ef" };
  const html = buildConversationShareHtml({
    allShareableIds: ["short", "own", "multi"],
    colors: { ...colors, ownUserBubble },
    contentWidth: 390,
    selectedMessages: [
      { body: "短消息", clientId: "short", kind: "user" },
      { body: "自己发的", clientId: "own", kind: "user", ownUserBubble: true },
      { body: "第一行\n第二行", clientId: "multi", kind: "user" },
    ],
  });
  const css = (selector: string) =>
    html.match(new RegExp(`\\n\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";

  it("用户气泡用细描边与普通边框色,不用次要文字色的粗框", () => {
    expect(css(".share-bubble-user")).toContain("border: 0.5px solid #dddddd");
    expect(css(".share-bubble-user")).not.toContain("#555555");
  });

  it("左右边距与消息流一致,短消息气泡上下更紧凑", () => {
    expect(css("#xdt-content.share-stage")).toContain("padding: 24px 16px");
    expect(css(".share-bubble-user.share-bubble-compact")).toContain("padding: 8px 12px");
    expect(html).toContain("share-bubble-user share-bubble-compact");
    expect(html).toContain("share-bubble-user share-bubble-standard");
  });

  it("自己发的消息沿用「我的消息气泡颜色」", () => {
    expect(css(".share-bubble-own")).toContain("background: #e8f0ff");
    expect(css(".share-bubble-own")).toContain("border-color: #b5c8ef");
    expect(html.match(/share-bubble-own"/g)).toHaveLength(1);
  });

  it("默认气泡外观不输出自定义颜色规则", () => {
    const plain = buildConversationShareHtml({
      allShareableIds: ["own"],
      colors,
      contentWidth: 390,
      selectedMessages: [{ body: "x", clientId: "own", kind: "user", ownUserBubble: true }],
    });
    expect(plain).not.toContain(".share-bubble-own {");
  });

  it("段内换行像聊天里一样保留", () => {
    expect(html).toMatch(/#xdt-content p,[^{]*\{\s*white-space: pre-wrap;/);
  });
});
