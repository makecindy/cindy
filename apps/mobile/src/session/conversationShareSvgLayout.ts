import { hasRichAnswer } from "@cindy/maker-shared/rich-answer";
import {
  conversationShareReadableBody,
  type ShareVector,
} from "./conversationShareRichAnswer";
import { redactSensitiveText } from "@cindy/maker-shared/error-redaction";
import { summarizeMessageBubblePresentation } from "@cindy/maker-shared/message-presentation";

import { i18n } from "@/i18n";
import {
  conservativeArialGlyphWidthEm,
  layoutConversationShareRichBody,
  type ShareSvgRect,
} from "@/session/conversationShareRichSvg";
import {
  mobileMarkdownInlineHasMark,
  parseMobileMarkdown,
  type MobileMarkdownBlock,
  type MobileMarkdownInline,
} from "@/session/messageMarkdown";
import {
  CONVERSATION_SHARE_PADDING_X,
  CONVERSATION_SHARE_PADDING_Y,
  type ConversationShareMessage,
  type ConversationShareImage,
  type ConversationShareWebViewColors,
} from "@/session/conversationShareWebViewHtml";
import { buildMessageContentLayout } from "@/session/messageContentLayout";
import { spacing, typeScale, lineHeight } from "@/theme/tokens";

const PADDING_X = CONVERSATION_SHARE_PADDING_X;
const PADDING_Y = CONVERSATION_SHARE_PADDING_Y;
const MESSAGE_GAP = spacing.lg;
const TEXT_FONT_SIZE = typeScale.bodyLarge;
const TEXT_LINE_HEIGHT = lineHeight.bodyLarge;
const META_FONT_SIZE = 12;
const META_LINE_HEIGHT = 18;
const MAX_OUTPUT_PIXELS = 12_000_000;
const DEFAULT_EXPORT_SCALE = 2;

export interface ConversationShareSvgTextBlock {
  bold?: boolean;
  italic?: boolean;
  monospace?: boolean;
  decoration?: "underline" | "line-through";
  color: string;
  fontSize: number;
  lineHeight: number;
  lines: string[];
  x: number;
  y: number;
}

export interface ConversationShareSvgBubble {
  rectangles?: ShareSvgRect[];
  vectors?: ShareVector[];
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
  pixelRatio = 1,
): { height: number; scale: number; sourceTooLarge: boolean; width: number } {
  const sourceTooLarge = layout.width * layout.height > MAX_OUTPUT_PIXELS;
  if (sourceTooLarge) {
    return { height: 1, scale: 1, sourceTooLarge, width: 1 };
  }
  const scale = Math.min(
    DEFAULT_EXPORT_SCALE,
    // SvgView allocates its bitmap in physical pixels, not React Native points.
    Math.sqrt(
      MAX_OUTPUT_PIXELS /
        Math.max(
          1,
          layout.width * layout.height * Math.max(1, pixelRatio) ** 2,
        ),
    ),
  );
  return {
    height: Math.max(1, Math.floor(layout.height * scale)),
    scale,
    sourceTooLarge,
    width: Math.max(1, Math.floor(layout.width * scale)),
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
  const contentWidth = canvasWidth - PADDING_X * 2;
  const contentLayout = buildMessageContentLayout({ screenWidth: canvasWidth });
  const bubbles: ConversationShareSvgBubble[] = [];
  const images: ConversationShareSvgLayout["images"] = [];
  const gaps: Array<{ color: string; y: number }> = [];
  const messageIndex = new Map(allShareableIds.map((id, index) => [id, index]));
  let previousIndex: number | null = null;
  let cursorY = PADDING_Y;

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
    const bubbleX = user ? canvasWidth - PADDING_X - bubbleWidth : PADDING_X;
    const horizontalPadding = user ? spacing.md : 0;
    // 与聊天气泡一致:短消息上下 8,其余 12;助手回复无框,上下 4。
    const compact =
      summarizeMessageBubblePresentation({
        attachmentCount: message.attachments?.length ?? 0,
        body: message.body,
        kind: message.kind,
        secondaryBody: message.secondaryBody,
      }).density === "compact";
    const paddingY = user ? (compact ? spacing.sm : spacing.md) : spacing.xs;
    const minBubbleHeight = user ? 20 + paddingY * 2 : 30;
    const ownBubble =
      user && message.ownUserBubble ? colors.ownUserBubble : null;
    const bubbleFill = user
      ? (ownBubble?.background ?? colors.surfaceElevated)
      : undefined;
    const bubbleStroke = user
      ? (ownBubble?.border ?? colors.border)
      : undefined;
    const textWidth = bubbleWidth - horizontalPadding * 2;
    const appendMetadata = (text: string, color: string, gap: number) => {
      const lines = wrapSvgText(
        redactSensitiveText(text).trim(),
        bubbleWidth,
        META_FONT_SIZE,
      );
      const height = lines.length * META_LINE_HEIGHT;
      bubbles.push({
        height,
        width: bubbleWidth,
        x: bubbleX,
        y: cursorY,
        textBlocks: [
          {
            color,
            fontSize: META_FONT_SIZE,
            lineHeight: META_LINE_HEIGHT,
            lines,
            x: bubbleX,
            y: cursorY + META_FONT_SIZE,
          },
        ],
      });
      cursorY += height + gap;
    };
    // One ordered traversal owns attachments, then body. Failed images replace
    // their own occurrence rather than moving into the bubble. Share images
    // carry no message-source labels (automation / device / plugin / author).
    const appendImage = (image: ConversationShareImage) => {
      const scale = Math.min(
        1,
        contentLayout.attachmentImageMaxWidth / image.width,
        contentLayout.attachmentImageMaxHeight / image.height,
      );
      const imageWidth = image.width * scale;
      const imageHeight = image.height * scale;
      images.push({
        uri: image.uri,
        width: imageWidth,
        height: imageHeight,
        x: user ? canvasWidth - PADDING_X - imageWidth : PADDING_X,
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
      } else {
        appendMetadata(
          `${attachment.kind === "image" ? "▧" : "▤"} ${attachment.name}`,
          colors.textSecondary,
          MESSAGE_GAP,
        );
      }
    }
    let needsRedaction = false;
    const bodyParts = conversationShareBodyParts(message, () => {
      needsRedaction = true;
    });
    // Preserve the existing whole-message redaction path for secrets spanning
    // formatting, paragraphs or images. Never redact isolated styled runs.
    if (
      !needsRedaction &&
      (bodyParts.length > 0 ||
        (message.kind === "assistant" && hasRichAnswer(message.body)))
    ) {
      const body = layoutConversationShareRichBody(
        message,
        colors,
        bubbleX + horizontalPadding,
        cursorY + paddingY,
        textWidth,
      );
      const height = Math.max(minBubbleHeight, body.height + paddingY * 2);
      bubbles.push({
        x: bubbleX,
        y: cursorY,
        width: bubbleWidth,
        height,
        fill: bubbleFill,
        stroke: bubbleStroke,
        textBlocks: body.textBlocks,
        rectangles: body.rectangles,
        vectors: body.vectors,
      });
      images.push(...body.images);
      cursorY += height + MESSAGE_GAP;
      previousIndex = currentIndex;
      continue;
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

    for (const part of bodyParts) {
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
    let innerY = paddingY;
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
    const bubbleHeight = Math.max(minBubbleHeight, innerY + paddingY);
    if (blocks.length > 0)
      bubbles.push({
        fill: bubbleFill,
        height: bubbleHeight,
        stroke: bubbleStroke,
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
    height: footerY + 22 + PADDING_Y,
    width: canvasWidth,
  };
}

type ShareBodyPart = { text: string } | { image: ConversationShareImage };

/** Traverse occurrences, using the source map only to look up decoded bytes. */
function conversationShareBodyParts(
  message: ConversationShareMessage,
  onRedaction?: () => void,
): ShareBodyPart[] {
  const parts: ShareBodyPart[] = [];
  const append = (part: ShareBodyPart) => {
    const last = parts[parts.length - 1];
    if ("text" in part && last && "text" in last) last.text += part.text;
    else parts.push(part);
  };
  const markdown = (text: string) => {
    for (const block of parseMobileMarkdown(
      conversationShareReadableBody(message, text),
    )) {
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
    onRedaction?.();
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
  const appendText = (text: string) => {
    const last = parts[parts.length - 1];
    if (last && "text" in last) last.text += text;
    else parts.push({ text });
  };
  // 删除线里的链接等会把一段删除线拆成多个 inline:`~~` 只加在连续删除线范围的两端,
  // 不给每个片段各包一层(否则边界处出现 `~~~~`)。
  let struck = false;
  for (const inline of inlines) {
    const image = inline.type === "image" ? images?.get(inline.url) : undefined;
    const nextStruck =
      !image && mobileMarkdownInlineHasMark(inline, "strikethrough");
    if (struck !== nextStruck) {
      appendText("~~");
      struck = nextStruck;
    }
    if (image) {
      parts.push({ image });
      continue;
    }
    appendText(
      inline.type === "image"
        ? inline.alt.trim() || i18n.t("message.renderer.imageFallbackTitle")
        : inline.text,
    );
  }
  if (struck) appendText("~~");
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
