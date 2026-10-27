import type { RichNode } from "./richAnswer";

/** Cross-client visual values. Only declarative values; no CSS URLs, handlers or code. */
export type RichVisualStyle = Record<string, string | number>;
const lengths = new Set([
  "width",
  "maxWidth",
  "minWidth",
  "height",
  "minHeight",
  "maxHeight",
  "padding",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "marginTop",
  "marginBottom",
  "gap",
  "borderRadius",
  "borderWidth",
  "fontSize",
  "lineHeight",
  "letterSpacing",
  "flexGrow",
  "flexShrink",
]);
const enums: Record<string, readonly string[]> = {
  textAlign: ["left", "center", "right", "justify"],
  fontStyle: ["normal", "italic"],
  alignItems: ["flex-start", "center", "flex-end", "stretch"],
  justifyContent: [
    "flex-start",
    "center",
    "flex-end",
    "space-between",
    "space-around",
    "space-evenly",
  ],
  flexDirection: ["row", "column", "row-reverse", "column-reverse"],
  flexWrap: ["wrap", "nowrap"],
  textDecorationLine: ["none", "underline", "line-through"],
  borderStyle: ["solid", "dashed", "dotted"],
};
/**
 * Colors are Cindy's, not the model's: answers may only name a role, and each client maps
 * roles to its theme tokens so both modes and every device stay consistent and calm.
 */
export const RICH_COLOR_ROLES = [
  "primary",
  "secondary",
  "tertiary",
  "success",
  "warning",
  "danger",
] as const;
export type RichColorRole = (typeof RICH_COLOR_ROLES)[number];
/** Host values for each role plus the host border; values are theme tokens or theme colors. */
export type RichPalette = Record<RichColorRole | "border", string>;
export function richColor(
  value: unknown,
  palette: RichPalette,
): string | undefined {
  return typeof value === "string" &&
    (RICH_COLOR_ROLES as readonly string[]).includes(value)
    ? palette[value as RichColorRole]
    : undefined;
}
/** Without a palette (layout-only callers) colors and borders are omitted. */
export function richVisualStyle(
  node: RichNode,
  palette?: RichPalette,
): RichVisualStyle {
  const raw = node.props.style;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const style = raw as Record<string, unknown>;
  const out: RichVisualStyle = {};
  for (const [key, value] of Object.entries(style)) {
    // Backgrounds and border colors stay with the host; text uses a named role only.
    if (key === "color") {
      const color = palette && richColor(value, palette);
      if (color) out[key] = color;
    } else if (key === "borderWidth" && typeof value === "number") {
      if (value > 0) out[key] = 1;
    } else if (
      lengths.has(key) &&
      typeof value === "number" &&
      Number.isFinite(value)
    ) {
      out[key] = value;
    } else if (
      [
        "width",
        "maxWidth",
        "minWidth",
        "height",
        "minHeight",
        "maxHeight",
      ].includes(key) &&
      typeof value === "string" &&
      /^(?:\d+(?:\.\d+)?%|auto)$/.test(value)
    ) {
      out[key] = value;
    } else if (
      key === "fontWeight" &&
      /^(?:[1-9]00|normal|bold)$/.test(String(value))
    )
      out[key] = String(value);
    else if (
      key === "fontFamily" &&
      typeof value === "string" &&
      /^[\w ,'-]{1,120}$/.test(value)
    )
      out[key] = value;
    else if (
      key === "opacity" &&
      typeof value === "number" &&
      Number.isFinite(value)
    )
      out[key] = Math.max(0, Math.min(1, value));
    else if (enums[key]?.includes(String(value))) out[key] = String(value);
  }
  if (palette && (out.borderWidth || out.borderStyle)) {
    out.borderWidth ??= 1;
    out.borderStyle ??= "solid";
    out.borderColor = palette.border;
  }
  return out;
}
export type RichVectorShape = {
  type:
    | "path"
    | "rect"
    | "circle"
    | "ellipse"
    | "line"
    | "polyline"
    | "polygon"
    | "text";
  props: Record<string, string | number>;
  text?: string;
};
const shapeTypes = new Set([
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
]);
const numbers = new Set([
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "width",
  "height",
  "rx",
  "ry",
  "cx",
  "cy",
  "r",
  "strokeWidth",
  "opacity",
  "fillOpacity",
  "strokeOpacity",
  "fontSize",
  "letterSpacing",
]);
export function richVector(
  node: RichNode,
  palette: RichPalette,
): { viewBox: string; shapes: RichVectorShape[] } {
  const vb = Array.isArray(node.props.viewBox)
    ? node.props.viewBox
    : String(node.props.viewBox ?? "")
        .split(/[ ,]+/)
        .map(Number);
  const viewBox =
    vb.length === 4 &&
    vb.every((v) => typeof v === "number" && Number.isFinite(v)) &&
    vb[2] > 0 &&
    vb[3] > 0
      ? vb.join(" ")
      : "0 0 640 360";
  const shapes: RichVectorShape[] = [];
  for (const raw of Array.isArray(node.props.shapes)
    ? node.props.shapes.slice(0, 2048)
    : []) {
    if (!raw || typeof raw !== "object" || !shapeTypes.has(raw.type)) continue;
    const props: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (numbers.has(k) && typeof v === "number" && Number.isFinite(v))
        props[k] = v;
      else if (["fill", "stroke"].includes(k)) {
        const c = v === "none" ? "none" : richColor(v, palette);
        if (c) props[k] = c;
      } else if (
        k === "d" &&
        typeof v === "string" &&
        /^[MmZzLlHhVvCcSsQqTtAa\d.,+eE\s-]+$/.test(v)
      )
        props[k] = v;
      else if (
        ["points", "strokeDasharray"].includes(k) &&
        typeof v === "string" &&
        /^[\d.,+eE\s-]+$/.test(v)
      )
        props[k] = v;
      else if (
        k === "transform" &&
        typeof v === "string" &&
        /^(?:(?:translate|scale|rotate|matrix|skewX|skewY)\([\d.,+eE\s-]+\)\s*)+$/.test(
          v,
        )
      )
        props[k] = v;
      else if (
        k === "textAnchor" &&
        ["start", "middle", "end"].includes(String(v))
      )
        props[k] = String(v);
      else if (
        k === "fontWeight" &&
        /^(?:[1-9]00|normal|bold)$/.test(String(v))
      )
        props[k] = String(v);
      else if (
        k === "strokeLinecap" &&
        ["butt", "round", "square"].includes(String(v))
      )
        props[k] = String(v);
      else if (
        k === "strokeLinejoin" &&
        ["miter", "round", "bevel"].includes(String(v))
      )
        props[k] = String(v);
    }
    shapes.push({
      type: raw.type,
      props,
      text: raw.type === "text" ? String(raw.text ?? "") : undefined,
    });
  }
  return { viewBox, shapes };
}
