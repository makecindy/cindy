import { latexToUnicodeApproximation } from "@cindy/maker-shared/math-markdown";
import { i18n } from "@/i18n";
import { tokenizeCode } from "@/session/codeHighlight";
import {
  parseMobileMarkdown,
  type MobileMarkdownBlock,
  type MobileMarkdownInline,
} from "@/session/messageMarkdown";
import type {
  ConversationShareMessage,
  ConversationShareWebViewColors,
} from "@/session/conversationShareWebViewHtml";
import type {
  ConversationShareSvgLayout,
  ConversationShareSvgTextBlock,
} from "@/session/conversationShareSvgLayout";
import { typeScale, lineHeight, spacing, radius } from "@/theme/tokens";

export interface ShareSvgRect {
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  stroke?: string;
  rx?: number;
}

type Run = Pick<
  ConversationShareSvgTextBlock,
  "color" | "bold" | "italic" | "decoration" | "monospace"
> & { text: string };

export function conservativeArialGlyphWidthEm(character: string): number {
  // Native SVG has no synchronous glyph measurement. Round wide glyphs up so
  // both the rich and redacted fallback layouts wrap before clipping.
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

/** Pure native fallback layout. Keep Markdown structure instead of flattening it.
 * The caller retains whole-message redaction before choosing this path.
 */
export function layoutConversationShareRichBody(
  message: ConversationShareMessage,
  colors: ConversationShareWebViewColors,
  x: number,
  y: number,
  width: number,
) {
  const textBlocks: ConversationShareSvgTextBlock[] = [];
  const rectangles: ShareSvgRect[] = [];
  const images: ConversationShareSvgLayout["images"] = [];
  let cursor = y;
  const gap = spacing.md;

  function text(
    runs: Run[],
    left: number,
    top: number,
    available: number,
    size: number = typeScale.body,
    leading: number = lineHeight.body,
  ): number {
    if (available <= 0) return 0;
    // Even a single wide, bold glyph must fit in a narrow table cell.
    // Keep the normal line spacing while shrinking only constrained text.
    size = Math.min(size, available / (1.05 * 1.08));
    let dx = 0;
    let dy = 0;
    let hasText = false;
    for (const run of runs) {
      let fragment = "";
      let fragmentX = dx;
      const flush = () => {
        if (!fragment) return;
        const { text: _text, ...style } = run;
        textBlocks.push({
          ...style,
          fontSize: size,
          lineHeight: leading,
          lines: [fragment],
          x: left + fragmentX,
          y: top + dy + size,
        });
        fragment = "";
      };
      for (const char of Array.from(
        run.text.replace(/\r\n?/g, "\n").replace(/\t/g, "    "),
      )) {
        const units = run.monospace
          ? char.codePointAt(0)! > 0x7f
            ? 1
            : 0.62
          : conservativeArialGlyphWidthEm(char);
        const advance = units * size * (run.bold ? 1.08 : 1);
        if (char === "\n" || (dx > 0 && dx + advance > available)) {
          flush();
          dx = 0;
          dy += leading;
          fragmentX = 0;
          if (char === "\n") {
            hasText = true;
            continue;
          }
        }
        if (!fragment) fragmentX = dx;
        fragment += char;
        dx += advance;
        hasText = true;
      }
      flush();
    }
    return hasText ? dy + leading : 0;
  }

  function inlines(
    items: readonly MobileMarkdownInline[],
    left: number,
    top: number,
    available: number,
    size: number = typeScale.body,
    leading: number = lineHeight.body,
    bold = false,
  ): number {
    let height = 0;
    let runs: Run[] = [];
    const flush = () => {
      height += text(runs, left, top + height, available, size, leading);
      runs = [];
    };
    for (const inline of items) {
      const image =
        inline.type === "image" ? message.images?.get(inline.url) : undefined;
      if (image) {
        flush();
        const scale = Math.min(1, available / image.width, 320 / image.height);
        images.push({
          uri: image.uri,
          x: left,
          y: top + height,
          width: image.width * scale,
          height: image.height * scale,
        });
        height += image.height * scale + 5;
        continue;
      }
      runs.push({
        text:
          inline.type === "image"
            ? inline.alt.trim() || i18n.t("message.renderer.imageFallbackTitle")
            : inline.type === "math"
              ? latexToUnicodeApproximation(inline.text)
              : inline.text,
        color: inline.type === "code" ? colors.inlineCode : colors.textPrimary,
        bold: bold || inline.type === "strong",
        italic: inline.type === "emphasis",
        monospace: inline.type === "code",
        decoration:
          inline.type === "link"
            ? "underline"
            : inline.type === "strikethrough"
              ? "line-through"
              : undefined,
      });
    }
    flush();
    return height;
  }

  function block(value: MobileMarkdownBlock) {
    if (value.type === "table") {
      const rows = [value.header, ...value.rows.map((row) => row.cells)];
      const columns = Math.max(...rows.map((row) => row.length), 1);
      const cellWidth = width / columns;
      const padding = Math.min(8, cellWidth / 8);
      rows.forEach((row, rowIndex) => {
        const top = cursor;
        let height = lineHeight.body + padding * 2;
        for (let column = 0; column < columns; column++) {
          height = Math.max(
            height,
            padding * 2 +
              inlines(
                row[column] ?? [],
                x + column * cellWidth + padding,
                top + padding,
                cellWidth - padding * 2,
                typeScale.footnote,
                lineHeight.code,
                rowIndex === 0,
              ),
          );
        }
        for (let column = 0; column < columns; column++) {
          rectangles.push({
            x: x + column * cellWidth,
            y: top,
            width: cellWidth,
            height,
            fill: rowIndex === 0 ? colors.surfaceChip : "none",
            stroke: colors.border,
          });
        }
        cursor += height;
      });
    } else if (
      value.type === "code" ||
      value.type === "mermaid" ||
      value.type === "math"
    ) {
      const top = cursor;
      const runs =
        value.type === "code"
          ? tokenizeCode(value.text, value.language).map((token) => ({
              text: token.text,
              color:
                token.kind === "plain"
                  ? colors.textPrimary
                  : (colors.syntax[token.kind] ?? colors.textPrimary),
              monospace: true,
            }))
          : [
              {
                text:
                  value.type === "math"
                    ? latexToUnicodeApproximation(value.text)
                    : value.text,
                color: colors.textPrimary,
                monospace: true,
              },
            ];
      cursor +=
        12 +
        text(
          runs,
          x + 12,
          cursor + 12,
          width - 24,
          typeScale.footnote,
          lineHeight.code,
        ) +
        12;
      rectangles.push({
        x,
        y: top,
        width,
        height: cursor - top,
        fill: colors.codeSurface,
        stroke: colors.border,
        rx: radius.container,
      });
    } else if (value.type === "blockquote") {
      const height = inlines(value.inlines, x + 12, cursor, width - 12);
      rectangles.push({ x, y: cursor, width: 2, height, fill: colors.border });
      cursor += height;
    } else if (value.type === "list_item") {
      const marker =
        typeof value.checked === "boolean"
          ? `${value.ordered ? `${value.marker} ` : ""}${value.checked ? "☑" : "☐"}`
          : value.marker;
      const markerUnits = Array.from(marker).reduce(
        (sum, character) => sum + conservativeArialGlyphWidthEm(character),
        0,
      );
      const markerWidth = Math.max(
        spacing.xl,
        markerUnits * typeScale.body + spacing.sm,
      );
      text(
        [{ text: marker, color: colors.textPrimary }],
        x,
        cursor,
        markerWidth,
      );
      cursor += Math.max(
        lineHeight.body,
        inlines(value.inlines, x + markerWidth, cursor, width - markerWidth),
      );
    } else {
      const heading = value.type === "heading";
      const size = heading
        ? value.level === 1
          ? typeScale.title
          : value.level === 2
            ? typeScale.subtitle
            : typeScale.body
        : typeScale.body;
      cursor += inlines(
        value.inlines,
        x,
        cursor,
        width,
        size,
        heading ? lineHeight.listTitle : lineHeight.body,
        heading,
      );
    }
    cursor += gap;
  }

  const markdown = (source: string) =>
    parseMobileMarkdown(source).forEach(block);
  if (message.bodyParts) {
    for (const part of message.bodyParts) {
      if (part.kind === "text") markdown(part.text);
      else {
        cursor +=
          text(
            [{ text: part.label, color: colors.textSecondary }],
            x,
            cursor,
            width,
          ) + gap;
      }
    }
  } else markdown(message.body);
  if (message.secondaryBody) markdown(message.secondaryBody);
  return {
    textBlocks,
    rectangles,
    images,
    height: Math.max(0, cursor - y - gap),
  };
}
