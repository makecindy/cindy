import { redactSensitiveText } from "@cindy/maker-shared/error-redaction";

import { i18n } from "@/i18n";
import {
  parseMobileMarkdown,
  type MobileMarkdownBlock,
  type MobileMarkdownInline,
} from "@/session/messageMarkdown";
import type {
  ConversationShareMessage,
  ConversationShareImage,
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
  images: Array<{
    uri: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
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
  const images: ConversationShareSvgLayout["images"] = [];
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
    const appendImage = (image: ConversationShareImage) => {
      const scale = Math.min(1, bubbleWidth / image.width, 320 / image.height);
      const imageWidth = image.width * scale;
      const imageHeight = image.height * scale;
      images.push({
        uri: image.uri,
        width: imageWidth,
        height: imageHeight,
        x: user ? canvasWidth - PADDING - imageWidth : PADDING,
        y: cursorY,
      });
      cursorY += imageHeight + MESSAGE_GAP;
    };
    for (const attachment of message.attachments ?? []) {
      const image =
        attachment.kind === "image" && attachment.uri
          ? message.images?.get(attachment.uri)
          : undefined;
      if (image && attachment.uri) {
        appendImage(image);
      }
    }
    const blocks: Array<
      | { image: ConversationShareImage }
      | {
          color: string;
          fontSize: number;
          lineHeight: number;
          text: string;
        }
    > = [];

    if (message.automationOriginLabel) {
      blocks.push({
        color: colors.textTertiary,
        fontSize: META_FONT_SIZE,
        lineHeight: META_LINE_HEIGHT,
        text: redactSensitiveText(message.automationOriginLabel).trim(),
      });
    }
    for (const attachment of message.attachments ?? []) {
      if (
        attachment.kind === "image" &&
        attachment.uri &&
        message.images?.has(attachment.uri)
      )
        continue;
      blocks.push({
        color: colors.textSecondary,
        fontSize: META_FONT_SIZE,
        lineHeight: META_LINE_HEIGHT,
        text: `${attachment.kind === "image" ? "▧" : "▤"} ${redactSensitiveText(attachment.name).trim()}`,
      });
    }
    for (const part of conversationShareBodyParts(message)) {
      if ("image" in part) blocks.push(part);
      else
        blocks.push({
          color: colors.textPrimary,
          fontSize: TEXT_FONT_SIZE,
          lineHeight: TEXT_LINE_HEIGHT,
          text: part.text,
        });
    }

    const textBlocks: ConversationShareSvgTextBlock[] = [];
    let innerY = user ? 12 : 4;
    for (const block of blocks) {
      if ("image" in block) {
        const scale = Math.min(
          1,
          textWidth / block.image.width,
          320 / block.image.height,
        );
        const height = block.image.height * scale;
        images.push({
          uri: block.image.uri,
          width: block.image.width * scale,
          height,
          x: bubbleX + horizontalPadding,
          y: cursorY + innerY,
        });
        innerY += height + 5;
        continue;
      }
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
    if (blocks.length > 0)
      bubbles.push({
        fill: user ? colors.surfaceElevated : undefined,
        height: bubbleHeight,
        stroke: user ? colors.textSecondary : undefined,
        textBlocks,
        width: bubbleWidth,
        x: bubbleX,
        y: cursorY,
      });
    if (blocks.length > 0) cursorY += bubbleHeight + MESSAGE_GAP;
    previousIndex = currentIndex;
  }

  const footerY = cursorY + 36;
  return {
    bubbles,
    images,
    footerY,
    gaps,
    height: footerY + 22 + PADDING,
    width: canvasWidth,
  };
}

type ShareBodyPart = { text: string } | { image: ConversationShareImage };

/** Traverse occurrences, using the source map only to look up decoded bytes. */
function conversationShareBodyParts(
  message: ConversationShareMessage,
): ShareBodyPart[] {
  const parts: ShareBodyPart[] = [];
  const append = (part: ShareBodyPart) => {
    const last = parts[parts.length - 1];
    if ("text" in part && last && "text" in last) last.text += part.text;
    else parts.push(part);
  };
  const markdown = (text: string) => {
    for (const block of parseMobileMarkdown(text)) {
      for (const part of markdownBlockParts(block, message.images))
        append(part);
      append({ text: "\n" });
    }
  };
  if (message.bodyParts) {
    for (const part of message.bodyParts) {
      if (part.kind === "text") markdown(part.text);
      else append({ text: `${part.label}\n` });
    }
  } else markdown(message.body);
  if (message.secondaryBody) markdown(message.secondaryBody);
  const fullText = parts
    .map((part) => ("text" in part ? part.text : ""))
    .join("");
  const redacted = redactSensitiveText(fullText);
  let safeParts = parts;
  if (redacted !== fullText) {
    safeParts = [];
    let sourceOffset = 0;
    let safeOffset = 0;
    for (const part of parts) {
      if ("text" in part) {
        sourceOffset += part.text.length;
        continue;
      }
      // A secret can span an image. Position images against redacted prefixes,
      // but take ALL output text from the fully redacted message, never a prefix.
      const prefix = redactSensitiveText(fullText.slice(0, sourceOffset));
      let boundary = 0;
      while (
        boundary < prefix.length &&
        prefix[boundary] === redacted[boundary]
      )
        boundary++;
      boundary = Math.max(safeOffset, boundary);
      safeParts.push({ text: redacted.slice(safeOffset, boundary) }, part);
      safeOffset = boundary;
    }
    safeParts.push({ text: redacted.slice(safeOffset) });
  }
  return safeParts.flatMap<ShareBodyPart>((part) => {
    if ("image" in part) return [part];
    const text = part.text.replace(/\n{3,}/g, "\n\n").trim();
    return text ? [{ text }] : [];
  });
}

function markdownBlockParts(
  block: MobileMarkdownBlock,
  images: ConversationShareMessage["images"],
): ShareBodyPart[] {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return markdownInlineParts(block.inlines, images);
    case "blockquote":
      return markdownInlineParts(block.inlines, images).map((part) =>
        "text" in part
          ? {
              text: part.text
                .split("\n")
                .map((line) => `> ${line}`)
                .join("\n"),
            }
          : part,
      );
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
      return [
        { text: `${marker} ` },
        ...markdownInlineParts(block.inlines, images),
      ];
    }
    case "table": {
      const rows = [block.header, ...block.rows.map((row) => row.cells)];
      return rows.flatMap((cells, rowIndex) => [
        ...(rowIndex ? [{ text: "\n" }] : []),
        ...cells.flatMap((inlines, cellIndex) => [
          ...(cellIndex ? [{ text: " | " }] : []),
          ...markdownInlineParts(inlines, images),
        ]),
      ]);
    }
    case "code":
    case "math":
    case "mermaid":
      return [{ text: block.text }];
  }
}

function markdownInlineParts(
  inlines: readonly MobileMarkdownInline[],
  images: ConversationShareMessage["images"],
): ShareBodyPart[] {
  const parts: ShareBodyPart[] = [];
  for (const inline of inlines) {
    const image = inline.type === "image" ? images?.get(inline.url) : undefined;
    if (image) {
      parts.push({ image });
      continue;
    }
    const text = (() => {
      if (inline.type === "image") {
        return (
          inline.alt.trim() || i18n.t("message.renderer.imageFallbackTitle")
        );
      }
      if (inline.type === "strikethrough") {
        return `~~${inline.text}~~`;
      }
      return inline.text;
    })();
    const last = parts[parts.length - 1];
    if (last && "text" in last) last.text += text;
    else parts.push({ text });
  }
  return parts;
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
