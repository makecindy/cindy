import { redactSensitiveText } from "@cindy/maker-shared/error-redaction";

import { i18n } from "@/i18n";
import {
  parseMobileMarkdown,
  type MobileMarkdownBlock,
  type MobileMarkdownInline,
} from "@/session/messageMarkdown";
import type {
  ConversationShareMessage,
  ConversationShareWebViewColors,
} from "@/session/conversationShareWebViewHtml";

const PADDING = 28;
const MESSAGE_GAP = 16;
const TEXT_FONT_SIZE = 15;
const TEXT_LINE_HEIGHT = 22;
const META_FONT_SIZE = 12;
const META_LINE_HEIGHT = 18;
const MAX_OUTPUT_PIXELS = 12_000_000;
const DEFAULT_EXPORT_SCALE = 2;

export interface ConversationShareSvgTextBlock {
  color: string;
  fontSize: number;
  lineHeight: number;
  lines: string[];
  x: number;
  y: number;
}

export interface ConversationShareSvgBubble {
  fill?: string;
  height: number;
  stroke?: string;
  textBlocks: ConversationShareSvgTextBlock[];
  width: number;
  x: number;
  y: number;
}

export interface ConversationShareSvgLayout {
  bubbles: ConversationShareSvgBubble[];
  footerY: number;
  gaps: Array<{ color: string; y: number }>;
  height: number;
  width: number;
}

export function conversationShareSvgRenderSize(
  layout: Pick<ConversationShareSvgLayout, "height" | "width">,
): { height: number; scale: number; sourceTooLarge: boolean; width: number } {
  const sourceTooLarge = layout.width * layout.height > MAX_OUTPUT_PIXELS;
  if (sourceTooLarge) {
    return { height: 1, scale: 1, sourceTooLarge, width: 1 };
  }
  const scale = Math.min(
    DEFAULT_EXPORT_SCALE,
    Math.sqrt(MAX_OUTPUT_PIXELS / Math.max(1, layout.width * layout.height)),
  );
  return {
    height: Math.max(1, Math.ceil(layout.height * scale)),
    scale,
    sourceTooLarge,
    width: Math.max(1, Math.ceil(layout.width * scale)),
  };
}

export function buildConversationShareSvgLayout({
  allShareableIds,
  colors,
  messages,
  width,
}: {
  allShareableIds: readonly string[];
  colors: ConversationShareWebViewColors;
  messages: readonly ConversationShareMessage[];
  width: number;
}): ConversationShareSvgLayout {
  const canvasWidth = Math.max(280, Math.round(width));
  const contentWidth = canvasWidth - PADDING * 2;
  const bubbles: ConversationShareSvgBubble[] = [];
  const gaps: Array<{ color: string; y: number }> = [];
  const messageIndex = new Map(allShareableIds.map((id, index) => [id, index]));
  let previousIndex: number | null = null;
  let cursorY = PADDING;

  for (const message of messages) {
    const currentIndex = messageIndex.get(message.clientId) ?? null;
    if (
      previousIndex !== null &&
      currentIndex !== null &&
      currentIndex - previousIndex > 1
    ) {
      gaps.push({ color: colors.textTertiary, y: cursorY + 12 });
      cursorY += 28;
    }
    const user = message.kind === "user";
    const bubbleWidth = user ? Math.round(contentWidth * 0.86) : contentWidth;
    const bubbleX = user ? canvasWidth - PADDING - bubbleWidth : PADDING;
    const horizontalPadding = user ? 12 : 0;
    const textWidth = bubbleWidth - horizontalPadding * 2;
    const blocks: Array<{
      color: string;
      fontSize: number;
      lineHeight: number;
      text: string;
    }> = [];

    if (message.automationOriginLabel) {
      blocks.push({
        color: colors.textTertiary,
        fontSize: META_FONT_SIZE,
        lineHeight: META_LINE_HEIGHT,
        text: redactSensitiveText(message.automationOriginLabel).trim(),
      });
    }
    for (const attachment of message.attachments ?? []) {
      blocks.push({
        color: colors.textSecondary,
        fontSize: META_FONT_SIZE,
        lineHeight: META_LINE_HEIGHT,
        text: `${attachment.kind === "image" ? "▧" : "▤"} ${redactSensitiveText(attachment.name).trim()}`,
      });
    }
    const body = plainConversationShareText(message);
    if (body) {
      blocks.push({
        color: colors.textPrimary,
        fontSize: TEXT_FONT_SIZE,
        lineHeight: TEXT_LINE_HEIGHT,
        text: body,
      });
    }

    const textBlocks: ConversationShareSvgTextBlock[] = [];
    let innerY = user ? 12 : 4;
    for (const block of blocks) {
      const lines = wrapSvgText(block.text, textWidth, block.fontSize);
      textBlocks.push({
        color: block.color,
        fontSize: block.fontSize,
        lineHeight: block.lineHeight,
        lines,
        x: bubbleX + horizontalPadding,
        y: cursorY + innerY + block.fontSize,
      });
      innerY += lines.length * block.lineHeight + 5;
    }
    if (blocks.length > 0) innerY -= 5;
    const bubbleHeight = Math.max(user ? 44 : 30, innerY + (user ? 12 : 4));
    bubbles.push({
      fill: user ? colors.surfaceElevated : undefined,
      height: bubbleHeight,
      stroke: user ? colors.textSecondary : undefined,
      textBlocks,
      width: bubbleWidth,
      x: bubbleX,
      y: cursorY,
    });
    cursorY += bubbleHeight + MESSAGE_GAP;
    previousIndex = currentIndex;
  }

  const footerY = cursorY + 36;
  return {
    bubbles,
    footerY,
    gaps,
    height: footerY + 22 + PADDING,
    width: canvasWidth,
  };
}

function plainConversationShareText(message: ConversationShareMessage): string {
  const parts = message.bodyParts
    ? message.bodyParts
        .map((part) => (part.kind === "text" ? part.text : part.label))
        .join("\n")
    : message.body;
  const combined = [parts, message.secondaryBody].filter(Boolean).join("\n");
  return redactSensitiveText(plainMarkdownText(combined));
}

function plainMarkdownText(markdown: string): string {
  const blocks = parseMobileMarkdown(markdown);
  return blocks
    .map(plainMarkdownBlockText)
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function plainMarkdownBlockText(block: MobileMarkdownBlock): string {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return plainMarkdownInlineText(block.inlines);
    case "blockquote":
      return plainMarkdownInlineText(block.inlines)
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "list_item": {
      const taskMarker =
        typeof block.checked === "boolean"
          ? block.checked
            ? "[x]"
            : "[ ]"
          : null;
      const marker = taskMarker
        ? block.ordered
          ? `${block.marker} ${taskMarker}`
          : taskMarker
        : block.marker;
      return `${marker} ${plainMarkdownInlineText(block.inlines)}`;
    }
    case "table": {
      const rows = [block.header, ...block.rows.map((row) => row.cells)];
      return rows
        .map((cells) => cells.map(plainMarkdownInlineText).join(" | "))
        .join("\n");
    }
    case "code":
    case "math":
    case "mermaid":
      return block.text;
  }
}

function plainMarkdownInlineText(
  inlines: readonly MobileMarkdownInline[],
): string {
  return inlines
    .map((inline) => {
      if (inline.type === "image") {
        return (
          inline.alt.trim() || i18n.t("message.renderer.imageFallbackTitle")
        );
      }
      if (inline.type === "strikethrough") {
        return `~~${inline.text}~~`;
      }
      return inline.text;
    })
    .join("");
}

export function wrapSvgText(
  text: string,
  maxWidth: number,
  fontSize: number,
): string[] {
  const maxUnits = Math.max(1, maxWidth / fontSize);
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    let line = "";
    let units = 0;
    for (const character of Array.from(paragraph)) {
      const characterUnits = conservativeArialGlyphWidthEm(character);
      if (line && units + characterUnits > maxUnits) {
        lines.push(line.trimEnd());
        line = "";
        units = 0;
      }
      line += character;
      units += characterUnits;
    }
    lines.push(line.trimEnd());
  }
  return lines.length > 0 ? lines : [""];
}

function conservativeArialGlyphWidthEm(character: string): number {
  // react-native-svg does not expose synchronous glyph measurement while this
  // pure layout is built. These Arial-like buckets intentionally round wide
  // glyphs up so an exported line wraps early instead of being clipped.
  if (character === " ") return 0.33;
  if (character.codePointAt(0)! > 0x7f) return 1;
  if (character === "@") return 1.05;
  if ("W%".includes(character)) return 1;
  if ("Mm".includes(character)) return 0.9;
  if ("CGOQw".includes(character)) return 0.82;
  if ("ABDGHKNRUVXY&".includes(character)) return 0.75;
  if ("EFLPSTZ".includes(character)) return 0.68;
  if ("0123456789#?$+=<>^_~abdeghnopqu".includes(character)) return 0.62;
  if ("Jckrsvxyz".includes(character)) return 0.55;
  if ("(){}[]ft*".includes(character)) return 0.4;
  if (`!"',.:;\`il|/\\-`.includes(character)) return 0.36;
  return 0.68;
}
