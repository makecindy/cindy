import {
  RichAnswerStream,
  splitRichAnswer,
  richResolvedValues,
  richString,
  richNumber,
  richLabel,
  richMarkdown,
  richChart,
  richLinePlot,
  richVector,
  richVisualStyle,
  richColor,
  richOptions,
  richRange,
  richCalculationUnavailable,
  type RichNode,
  type RichValues,
  type RichPalette,
} from "@cindy/maker-shared/rich-answer";
import { redactSensitiveText } from "@cindy/maker-shared/error-redaction";
import type {
  ConversationShareImage,
  ConversationShareMessage,
  ConversationShareWebViewColors,
} from "./conversationShareWebViewHtml";
import type {
  ConversationShareSvgLayout,
  ConversationShareSvgTextBlock,
} from "./conversationShareSvgLayout";
import type { ShareSvgRect } from "./conversationShareRichSvg";
import { typeScale, spacing } from "@/theme/tokens";
import { i18n } from "@/i18n";

export interface ShareVector {
  overlay?: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  vector: ReturnType<typeof richVector>;
  color: string;
}
export interface ShareRichLayout {
  textBlocks: ConversationShareSvgTextBlock[];
  rectangles: ShareSvgRect[];
  images: ConversationShareSvgLayout["images"];
  vectors: ShareVector[];
  height: number;
}
export type ShareMarkdownLayout = (
  source: string,
  x: number,
  y: number,
  width: number,
) => ShareRichLayout;

// Match the live icon title, including legal nodes that only supply a name.
function shareRichTitle(node: RichNode): string {
  return (
    richString(node, "label") ||
    (node.kind === "icon" ? richString(node, "name") : "")
  );
}

/** Read the same document and local values as the conversation. Hidden tabs/details stay hidden. */
export function shareRichDocument(source: string, edited?: RichValues) {
  const doc = new RichAnswerStream().update(source, true);
  const values = richResolvedValues(doc, edited);
  const children = (node: RichNode) => {
    const current = values[richString(node, "bind", node.id)];
    if (node.kind === "details" && !current) return [];
    if (node.kind === "tabs")
      return [
        node.children.includes(String(current))
          ? String(current)
          : node.children[0],
      ].filter((id): id is string => !!id);
    return node.children;
  };
  return { doc, values, children };
}

/** Markdown projection used for image admission and whole-message redaction, never raw operations. */
export function conversationShareReadableBody(
  message: ConversationShareMessage,
  source: string,
): string {
  if (message.kind !== "assistant") return source;
  return splitRichAnswer(source)
    .map((part) => {
      if (part.kind === "markdown") return part.source;
      const { doc, values, children } = shareRichDocument(
        part.source,
        message.richValues?.[part.key],
      );
      const visit = (id: string): string => {
        const node = doc.nodes.get(id);
        if (!node) return "";
        const md = richMarkdown(node);
        let text =
          md ??
          (node.kind === "stat"
            ? `${richString(node, "label")}: ${richLabel(node, values)}`
            : ["text", "heading"].includes(node.kind)
              ? richLabel(node, values)
              : node.kind === "chart"
                ? [
                    richString(node, "label"),
                    ...richChart(node, values).map(
                      (item) => `${item.label}: ${item.value}`,
                    ),
                  ].join("\n")
                : [
                    shareRichTitle(node),
                    richString(node, "text"),
                    richString(node, "alt"),
                  ]
                    .filter(Boolean)
                    .join("\n"));
        if (node.kind === "svg")
          text +=
            "\n" +
            richVector(node, sharePalette())
              .shapes.map((shape) => shape.text ?? "")
              .join("\n");
        const current = values[richString(node, "bind", node.id)];
        if (node.kind === "select")
          text += `: ${richOptions(node).find((option) => option.value === current)?.label ?? current ?? ""}`;
        else if (["input", "range", "check"].includes(node.kind))
          text += `: ${current ?? ""}${richString(node, "suffix")}`;
        return [text, richString(node, "caption"), ...children(node).map(visit)]
          .filter(Boolean)
          .join("\n\n");
      };
      return doc.roots.map(visit).join("\n\n");
    })
    .join("\n\n");
}

/** Same visible tree as export, so collapsed details and inactive tabs do no IO. */
export function conversationShareVideoSources(
  message: ConversationShareMessage,
  source: string,
): string[] {
  const sources: string[] = [];
  if (message.kind !== "assistant") return sources;
  for (const part of splitRichAnswer(source)) {
    if (part.kind !== "rich") continue;
    const { doc, children } = shareRichDocument(
      part.source,
      message.richValues?.[part.key],
    );
    const visit = (id: string) => {
      const node = doc.nodes.get(id);
      if (!node) return;
      if (node.kind === "video") sources.push(richString(node, "src"));
      children(node).forEach(visit);
    };
    doc.roots.forEach(visit);
  }
  return sources;
}

function layoutShareVideo(
  image: ConversationShareImage | undefined,
  colors: ConversationShareWebViewColors,
  x: number,
  y: number,
  width: number,
): ShareRichLayout {
  const ratio = image ? image.width / image.height : 16 / 9;
  const height = Math.min(width / ratio, (width * 4) / 3);
  const frameWidth = Math.min(width, height * ratio);
  const size = Math.min(56, frameWidth, height);
  return {
    height,
    textBlocks: [],
    images: image ? [{ uri: image.uri, x, y, width: frameWidth, height }] : [],
    rectangles: image
      ? []
      : [{ x, y, width: frameWidth, height, fill: colors.surfaceChip, rx: 12 }],
    vectors: [
      {
        overlay: true,
        x: x + (frameWidth - size) / 2,
        y: y + (height - size) / 2,
        width: size,
        height: size,
        color: colors.textPrimary,
        vector: {
          viewBox: "0 0 56 56",
          shapes: [
            // Media-overlay contrast matches the live video cover in either theme.
            {
              type: "circle",
              props: {
                cx: 28,
                cy: 28,
                r: 28,
                fill: "#000000",
                fillOpacity: 0.55,
              },
            },
            {
              type: "path",
              props: { d: "M23 18 L38 28 L23 38 Z", fill: "#ffffff" },
            },
          ],
        },
      },
    ],
  };
}

function sharePalette(colors?: ConversationShareWebViewColors): RichPalette {
  return {
    primary: colors?.textPrimary ?? "currentColor",
    secondary: colors?.textSecondary ?? "currentColor",
    tertiary: colors?.textTertiary ?? "currentColor",
    border: colors?.border ?? "currentColor",
    success: colors?.success ?? colors?.textPrimary ?? "currentColor",
    warning: colors?.warning ?? colors?.textPrimary ?? "currentColor",
    danger: colors?.danger ?? colors?.textPrimary ?? "currentColor",
  };
}

/** Static layout for native SVG export; graphic geometry is also reused by WKWebView. */
export function layoutConversationShareRichAnswer(
  source: string,
  edited: RichValues | undefined,
  colors: ConversationShareWebViewColors,
  x: number,
  y: number,
  width: number,
  markdown: ShareMarkdownLayout,
  images?: ConversationShareMessage["images"],
): ShareRichLayout {
  const { doc, values, children } = shareRichDocument(source, edited);
  const palette = sharePalette(colors);
  const result: ShareRichLayout = {
    textBlocks: [],
    rectangles: [],
    images: [],
    vectors: [],
    height: 0,
  };
  const add = (layout: ShareRichLayout) => {
    result.textBlocks.push(...layout.textBlocks);
    result.rectangles.push(...layout.rectangles);
    result.images.push(...layout.images);
    result.vectors.push(...layout.vectors);
    return layout.height;
  };
  const text = (
    value: string,
    left: number,
    top: number,
    available: number,
    size: number = typeScale.bodyLarge,
    color = colors.textPrimary,
    bold = false,
  ) => {
    // Reuse the existing measured/conservative native Markdown layout, including CJK wrapping.
    const layout = markdown(
      value.replace(/([\\`*_{}[\]<>#])/g, "\\$1"),
      left,
      top,
      available,
    );
    const ratio = Math.max(1, size) / typeScale.bodyLarge;
    // Reflow at the requested size before scaling positions, not after wrapping.
    const scaled =
      ratio === 1
        ? layout
        : markdown(
            value.replace(/([\\`*_{}[\]<>#])/g, "\\$1"),
            0,
            0,
            available / ratio,
          );
    if (ratio !== 1)
      for (const block of scaled.textBlocks) {
        block.x = left + block.x * ratio;
        block.y = top + block.y * ratio;
        block.fontSize *= ratio;
        block.lineHeight *= ratio;
      }
    for (const block of scaled.textBlocks) {
      block.color = color;
      block.bold = bold;
    }
    add(scaled);
    return scaled.height * ratio;
  };
  const visit = (
    id: string,
    left: number,
    top: number,
    available: number,
  ): number => {
    const node = doc.nodes.get(id);
    if (!node) return 0;
    const visual = richVisualStyle(node, palette);
    const number = (key: string, fallback = 0) =>
      typeof visual[key] === "number"
        ? Math.max(0, visual[key] as number)
        : fallback;
    const length = (value: unknown, fallback: number) =>
      typeof value === "number"
        ? value
        : typeof value === "string" && value.endsWith("%")
          ? (available * parseFloat(value)) / 100
          : fallback;
    const outerWidth = Math.max(
      1,
      Math.min(
        available,
        length(visual.width, available),
        length(visual.maxWidth, available),
      ),
    );
    const pad = number("padding");
    const pl = number("paddingLeft", pad),
      pr = number("paddingRight", pad),
      pt = number("paddingTop", pad),
      pb = number("paddingBottom", pad);
    const margin = number("marginTop");
    const innerX = left + pl,
      innerY = top + margin + pt,
      innerWidth = Math.max(1, outerWidth - pl - pr);
    const gap = number("gap", spacing.sm);
    const label = shareRichTitle(node),
      current = values[richString(node, "bind", id)];
    const color =
      typeof visual.color === "string" ? visual.color : colors.textPrimary;
    let height = 0;
    const prose = (
      value: string,
      size: number = typeScale.bodyLarge,
      tone = color,
      bold = false,
    ) => {
      height += text(
        value,
        innerX,
        innerY + height,
        innerWidth,
        size,
        tone,
        bold,
      );
    };
    if (richCalculationUnavailable(node, values))
      prose(i18n.t("message.richAnswer.calculationUnavailable"));
    else if (["row", "grid"].includes(node.kind)) {
      const aside = richString(node, "layout") === "aside";
      const mobile = innerWidth <= 600 && !aside;
      const weights = Array.isArray(node.props.weights)
        ? node.props.weights.filter(
            (n): n is number =>
              typeof n === "number" && Number.isFinite(n) && n > 0,
          )
        : aside
          ? [0.7, 1.8]
          : [];
      const columns = Math.min(
        Math.max(1, node.children.length),
        Math.max(
          1,
          Math.round(
            visual.flexDirection === "column"
              ? 1
              : mobile
                ? richNumber(node, "mobileColumns", 1)
                : weights.length || richNumber(node, "columns", 2),
          ),
        ),
      );
      const usable = Math.max(1, innerWidth - gap * (columns - 1));
      for (let row = 0; row < node.children.length; row += columns) {
        let offset = 0,
          rowHeight = 0;
        for (
          let column = 0;
          column < columns && row + column < node.children.length;
          column++
        ) {
          const childWidth =
            !mobile && weights.length === columns
              ? (usable * weights[column]!) / weights.reduce((a, b) => a + b, 0)
              : usable / columns;
          rowHeight = Math.max(
            rowHeight,
            visit(
              node.children[row + column]!,
              innerX + offset,
              innerY + height,
              childWidth,
            ),
          );
          offset += childWidth + gap;
        }
        height += rowHeight + gap;
      }
      height = Math.max(0, height - gap);
    } else if (
      ["stack", "group", "form", "tabs", "details"].includes(node.kind)
    ) {
      if (node.kind === "details" || node.kind === "tabs") {
        const title =
          node.kind === "tabs"
            ? richString(doc.nodes.get(children(node)[0]!) ?? node, "label")
            : label;
        if (title) {
          prose(title, typeScale.bodyLarge, color, true);
          height += gap;
        }
      }
      for (const child of children(node))
        height += visit(child, innerX, innerY + height, innerWidth) + gap;
      height = Math.max(0, height - gap);
    } else if (node.kind === "stat") {
      prose(label, typeScale.footnote, colors.textSecondary);
      height += spacing.xs;
      prose(
        richLabel(node, values),
        number("fontSize", typeScale.headline),
        color,
        true,
      );
    } else if (node.kind === "svg") {
      const vector = richVector(node, palette),
        dims = vector.viewBox.split(" ").map(Number);
      height = Math.max(
        1,
        Math.min(
          number("maxHeight", Infinity),
          number("height", (innerWidth * dims[3]!) / dims[2]!),
        ),
      );
      result.vectors.push({
        vector,
        x: innerX,
        y: innerY,
        width: innerWidth,
        height,
        color,
      });
    } else if (node.kind === "chart") {
      if (label) {
        prose(label, typeScale.bodyLarge, color, true);
        height += spacing.sm;
      }
      const data = richChart(node, values);
      const chartColor = richColor(node.props.color, palette) ?? color;
      if (richString(node, "variant") === "line") {
        const plot = richLinePlot(data, innerWidth, node.props);
        const shapes: Array<Record<string, unknown>> = [];
        for (const tick of plot.ticks) {
          if (node.props.showGrid !== false)
            shapes.push({
              type: "line",
              x1: plot.left,
              x2: plot.width - plot.right,
              y1: tick.y,
              y2: tick.y,
              stroke: "tertiary",
              strokeWidth: 0.5,
            });
          shapes.push({
            type: "text",
            x: plot.left - 8,
            y: tick.y + 4,
            text: tick.label,
            textAnchor: "end",
            fontSize: typeScale.caption,
            fill: "secondary",
          });
        }
        shapes.push({
          type: "polyline",
          points: plot.points.map((p) => `${p.x},${p.y}`).join(" "),
          stroke: node.props.color ?? "primary",
          fill: "none",
          strokeWidth: richNumber(node, "strokeWidth", 2),
        });
        for (const point of plot.points) {
          if (node.props.showPoints !== false)
            shapes.push({
              type: "circle",
              cx: point.x,
              cy: point.y,
              r: richNumber(node, "pointRadius", 3),
              fill: node.props.color ?? "primary",
            });
          if (plot.showValues)
            shapes.push({
              type: "text",
              x: point.x,
              y: point.y - 10,
              text: String(point.value),
              textAnchor: "middle",
              fontSize: typeScale.caption,
            });
        }
        for (const item of plot.labels)
          shapes.push({
            type: "text",
            x: item.x,
            y: plot.labelY,
            text: item.label,
            textAnchor: "middle",
            fontSize: typeScale.caption,
          });
        const vector = richVector(
          {
            ...node,
            props: { viewBox: [0, 0, plot.width, plot.height], shapes },
          },
          palette,
        );
        const chartHeight = (plot.height * innerWidth) / plot.width;
        result.vectors.push({
          vector,
          x: innerX,
          y: innerY + height,
          width: innerWidth,
          height: chartHeight,
          color: chartColor,
        });
        height += chartHeight;
      } else {
        const min = Math.min(0, ...data.map((item) => item.value));
        const max = Math.max(0, ...data.map((item) => item.value));
        const span = max - min || 1;
        for (const [index, item] of data.entries()) {
          prose(`${item.label}   ${item.value}`, typeScale.bodyLarge);
          const fill = Array.isArray(node.props.colors)
            ? (richColor(node.props.colors[index], palette) ?? chartColor)
            : chartColor;
          result.rectangles.push({
            x: innerX + (innerWidth * (Math.min(0, item.value) - min)) / span,
            y: innerY + height + spacing.xs,
            width: (innerWidth * Math.abs(item.value)) / span,
            height: 6,
            rx: 3,
            fill,
          });
          height += spacing.lg;
        }
      }
    } else if (node.kind === "divider") {
      result.rectangles.push({
        x: innerX,
        y: innerY,
        width: innerWidth,
        height: 1,
        fill: colors.border,
      });
      height = 1;
    } else if (node.kind === "text" || node.kind === "heading") {
      prose(
        richLabel(node, values),
        number(
          "fontSize",
          node.kind === "heading" ? typeScale.title : typeScale.bodyLarge,
        ),
        color,
        node.kind === "heading" || Number(visual.fontWeight) >= 600,
      );
    } else if (node.kind === "check")
      prose(`${current ? "☑" : "☐"} ${label || richString(node, "text")}`);
    else if (node.kind === "range")
      prose(
        `${label}  ${richRange(node, current).value}${richString(node, "suffix")}`,
      );
    else if (node.kind === "select")
      prose(
        `${label}  ${richOptions(node).find((option) => option.value === current)?.label ?? current ?? ""}`,
      );
    else if (node.kind === "input") prose(`${label}\n${current ?? ""}`);
    else if (node.kind === "video")
      height = add(
        layoutShareVideo(
          images?.get(richString(node, "src")),
          colors,
          innerX,
          innerY,
          innerWidth,
        ),
      );
    else if (node.kind === "audio")
      prose(
        richString(node, "alt", i18n.t("message.renderer.imageFallbackTitle")),
      );
    else {
      const md = richMarkdown(node);
      if (md !== null) height = add(markdown(md, innerX, innerY, innerWidth));
      else prose([label, richString(node, "text")].filter(Boolean).join("\n"));
    }
    const caption = richString(node, "caption");
    if (caption) {
      height += spacing.xs;
      prose(caption, typeScale.footnote, colors.textSecondary);
    }
    height = Math.max(height + pt + pb, number("minHeight"));
    if (visual.borderWidth)
      result.rectangles.push({
        x: left,
        y: top + margin,
        width: outerWidth,
        height,
        rx: number("borderRadius"),
        fill: "none",
        stroke: colors.border,
      });
    return margin + height + number("marginBottom");
  };
  for (const id of doc.roots)
    result.height += visit(id, x, y + result.height, width) + spacing.lg;
  result.height = Math.max(0, result.height - spacing.lg);
  if (doc.issues)
    result.height += text(
      i18n.t("message.richAnswer.incomplete"),
      x,
      y + result.height,
      width,
    );
  // Redact visible output after expressions resolve; the caller separately checks cross-node secrets.
  for (const block of result.textBlocks)
    block.lines = block.lines.map(redactSensitiveText);
  for (const { vector } of result.vectors)
    for (const shape of vector.shapes)
      if (shape.text) shape.text = redactSensitiveText(shape.text);
  return result;
}

const escape = (value: unknown) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
const attributes = (props: Record<string, unknown>) =>
  Object.entries(props)
    .map(
      ([key, value]) =>
        `${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${escape(value)}"`,
    )
    .join(" ");
export function shareVectorMarkup(item: ShareVector): string {
  return `<svg x="${item.x}" y="${item.y}" width="${item.width}" height="${item.height}" viewBox="${item.vector.viewBox}" fill="${escape(item.color)}">${item.vector.shapes.map((shape) => `<${shape.type} ${attributes(shape.props)}>${escape(shape.text ?? "")}</${shape.type}>`).join("")}</svg>`;
}
export function shareRichLayoutMarkup(
  layout: ShareRichLayout,
  width: number,
): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${layout.height}" viewBox="0 0 ${width} ${layout.height}" style="display:block;max-width:100%;height:auto;font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif">` +
    layout.rectangles
      .map(
        (rect) =>
          `<rect ${attributes(rect as unknown as Record<string, unknown>)} />`,
      )
      .join("") +
    layout.images
      .map(
        (image) =>
          `<image x="${image.x}" y="${image.y}" width="${image.width}" height="${image.height}" href="${escape(image.uri)}" />`,
      )
      .join("") +
    layout.vectors.map(shareVectorMarkup).join("") +
    layout.textBlocks
      .map((block) =>
        block.lines
          .map(
            (line, index) =>
              `<text x="${block.x}" y="${block.y + index * block.lineHeight}" fill="${escape(block.color)}" font-size="${block.fontSize}" font-weight="${block.bold ? 600 : 400}"${block.monospace ? ' font-family="monospace"' : ""}${block.italic ? ' font-style="italic"' : ""}${block.decoration ? ` text-decoration="${block.decoration}"` : ""}>${escape(line)}</text>`,
          )
          .join(""),
      )
      .join("") +
    "</svg>"
  );
}

/** The iOS capture keeps browser text shaping and the existing formula/diagram loaders. */
export function conversationShareRichHtml(
  source: string,
  edited: RichValues | undefined,
  colors: ConversationShareWebViewColors,
  width: number,
  markdown: (source: string) => string,
  layoutMarkdown: ShareMarkdownLayout,
  images?: ConversationShareMessage["images"],
): string {
  const { doc, values, children } = shareRichDocument(source, edited);
  const palette = sharePalette(colors);
  const visit = (id: string, available: number): string => {
    const node = doc.nodes.get(id);
    if (!node) return "";
    const visual = richVisualStyle(node, palette);
    const style: Record<string, string | number> = {
      minWidth: 0,
      maxWidth: "100%",
      ...visual,
    };
    if (typeof style.minWidth === "number")
      style.minWidth = Math.min(style.minWidth, available);
    const css = () =>
      escape(
        Object.entries(style)
          .map(([key, value]) => {
            const unitless =
              ["opacity", "flexGrow", "flexShrink", "fontWeight"].includes(
                key,
              ) ||
              (key === "lineHeight" && Number(value) <= 4);
            return `${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${value}${typeof value === "number" && !unitless ? "px" : ""}`;
          })
          .join(";"),
      );
    const label = shareRichTitle(node),
      current = values[richString(node, "bind", id)];
    let content = "";
    if (richCalculationUnavailable(node, values))
      content = escape(i18n.t("message.richAnswer.calculationUnavailable"));
    else if (["row", "grid"].includes(node.kind)) {
      const aside = richString(node, "layout") === "aside";
      const mobile = available <= 600 && !aside;
      const weights = Array.isArray(node.props.weights)
        ? node.props.weights.filter(
            (n): n is number =>
              typeof n === "number" && Number.isFinite(n) && n > 0,
          )
        : aside
          ? [0.7, 1.8]
          : [];
      const columns = Math.min(
        Math.max(1, node.children.length),
        Math.max(
          1,
          Math.round(
            visual.flexDirection === "column"
              ? 1
              : mobile
                ? richNumber(node, "mobileColumns", 1)
                : weights.length || richNumber(node, "columns", 2),
          ),
        ),
      );
      const gap = Number(visual.gap ?? spacing.sm);
      const tracks =
        !mobile && weights.length === columns
          ? weights
          : Array.from({ length: columns }, () => 1);
      const usable = Math.max(1, available - gap * (columns - 1));
      style.display = "grid";
      style.gridTemplateColumns = tracks
        .map((n) => `minmax(0,${n}fr)`)
        .join(" ");
      style.gap = gap;
      content = node.children
        .map((child, index) =>
          visit(
            child,
            (usable * tracks[index % columns]!) /
              tracks.reduce((a, b) => a + b, 0),
          ),
        )
        .join("");
    } else if (
      ["stack", "group", "form", "details", "tabs"].includes(node.kind)
    ) {
      style.display = "flex";
      style.flexDirection ??= "column";
      style.gap ??= spacing.sm;
      if (node.kind === "details" || node.kind === "tabs")
        content = `<strong>${escape(node.kind === "details" ? label : richString(doc.nodes.get(children(node)[0]!) ?? node, "label"))}</strong>`;
      content += children(node)
        .map((child) => visit(child, available))
        .join("");
    } else if (node.kind === "svg" || node.kind === "chart") {
      // Graphics share native geometry, while prose is shaped by the browser.
      const isolated = JSON.stringify({
        version: 1,
        seq: 1,
        op: "create",
        ...node,
        props: { ...node.props, style: undefined, caption: undefined },
      });
      content = shareRichLayoutMarkup(
        layoutConversationShareRichAnswer(
          isolated,
          values,
          colors,
          0,
          0,
          available,
          layoutMarkdown,
        ),
        available,
      );
    } else if (node.kind === "stat")
      content = `<div style="font-size:${typeScale.footnote}px;line-height:1.5;color:${escape(colors.textSecondary)}">${escape(label)}</div><div style="font-size:${typeScale.headline}px;line-height:1.3;font-weight:600;margin-top:${spacing.xs}px">${escape(richLabel(node, values))}</div>`;
    else if (node.kind === "text" || node.kind === "heading") {
      style.whiteSpace = "pre-wrap";
      if (node.kind === "heading") {
        style.fontSize ??= typeScale.title;
        style.fontWeight ??= 600;
      }
      content = escape(richLabel(node, values));
    } else if (node.kind === "divider") {
      style.borderTop = `1px solid ${colors.border}`;
    } else if (node.kind === "check")
      content = escape(
        `${current ? "☑" : "☐"} ${label || richString(node, "text")}`,
      );
    else if (node.kind === "input")
      content = `${escape(label)}<div>${escape(current ?? "")}</div>`;
    else if (node.kind === "range")
      content = escape(
        `${label}  ${richRange(node, current).value}${richString(node, "suffix")}`,
      );
    else if (node.kind === "select")
      content = escape(
        `${label}  ${richOptions(node).find((option) => option.value === current)?.label ?? current ?? ""}`,
      );
    else if (node.kind === "video") {
      const layout = layoutShareVideo(
        images?.get(richString(node, "src")),
        colors,
        0,
        0,
        available,
      );
      // Keep the frame as an HTML image so the existing decode barrier waits for
      // it before WKWebView capture. The SVG contains only the play overlay.
      content = `<div style="position:relative;width:100%">${layout.images.map((image) => `<img src="${escape(image.uri)}" alt="${escape(richString(node, "alt"))}" style="position:absolute;left:0;top:0;width:${(image.width / available) * 100}%;height:100%;object-fit:contain">`).join("")}<div style="position:relative">${shareRichLayoutMarkup({ ...layout, images: [] }, available)}</div></div>`;
    } else if (node.kind === "audio")
      content = escape(richString(node, "alt", node.kind));
    else {
      const md = richMarkdown(node);
      content =
        md !== null
          ? markdown(md)
          : [label, richString(node, "text")]
              .filter(Boolean)
              .map(escape)
              .join("<br>");
      style.display = "flex";
      style.flexDirection ??= "column";
      style.gap ??= spacing.sm;
    }
    if (richString(node, "caption"))
      content += `<div style="font-size:${typeScale.footnote}px;line-height:1.5;color:${escape(colors.textSecondary)};margin-top:${spacing.xs}px">${escape(richString(node, "caption"))}</div>`;
    return `<div style="box-sizing:border-box;${css()}">${content}</div>`;
  };
  return `<div style="display:flex;flex-direction:column;gap:${spacing.lg}px;min-width:0">${doc.roots.map((id) => visit(id, width)).join("")}${doc.issues ? `<div>${escape(i18n.t("message.richAnswer.incomplete"))}</div>` : ""}</div>`;
}
