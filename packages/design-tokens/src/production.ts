import { PROTECTED_IDS, SEMANTIC_EXEMPTION_IDS } from "./classify.ts";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { TokenNormalizedSet } from "@terrazzo/parser";

export const EXTENSION = "com.cindy.desktop";
export type SourceToken = {
  $type: string;
  $value: unknown;
  $extensions?: Record<string, Record<string, unknown>>;
};
export type TokenTree = { [key: string]: TokenTree | SourceToken | unknown };
const FOUNDATION_FAMILIES = [
  "css",
  "numeric",
  "text",
  "lineHeight",
  "spacing",
  "radius",
  "defaults",
  "fontWeight",
  "motion",
] as const;
export interface DesktopBindings {
  defaults: Record<string, { light: string | null; dark: string | null }>;
  retained: Record<string, string>;
  bootstrapCss: string[];
  themes: Record<
    string,
    {
      tokens: Record<string, string>;
      retained: Record<string, string>;
      type: "light" | "dark";
    }
  >;
  windowBacking: Record<"light" | "dark", string>;
  documentation: {
    semanticColors: Array<{ id: string; category: string; use: string }>;
    loginColors: Array<{ label: string; ids: string[]; use: string }>;
  };
  foundations: Record<
    (typeof FOUNDATION_FAMILIES)[number],
    Record<string, string>
  >;
}
export function readBindings(root: string): DesktopBindings {
  const bindings: DesktopBindings = JSON.parse(
    readFileSync(
      join(root, "packages/design-tokens/src/desktop-bindings.json"),
      "utf8",
    ),
  );
  const themeFiles = readdirSync(
    join(root, "apps/desktop/src/renderer/themes/builtin"),
  )
    .filter((file) => file.endsWith(".ts"))
    .sort();
  if (
    JSON.stringify(Object.keys(bindings.themes).sort()) !==
    JSON.stringify(themeFiles)
  )
    throw new Error("Theme bindings must cover every builtin file");
  return bindings;
}
export function flatten(
  tree: TokenTree,
  prefix = "",
  result: Record<string, SourceToken> = {},
): Record<string, SourceToken> {
  for (const [key, value] of Object.entries(tree)) {
    if (key.startsWith("$")) continue;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`Invalid token group: ${prefix}${key}`);
    const id = prefix ? `${prefix}.${key}` : key;
    if ("$value" in value) result[id] = value as SourceToken;
    else flatten(value as TokenTree, id, result);
  }
  return result;
}
export function aliasTarget(value: unknown): string | null {
  return typeof value === "string" && /^\{[^{}]+\}$/.test(value)
    ? value.slice(1, -1)
    : null;
}
export function validateProduction(
  tokens: Record<string, SourceToken>,
  bindings: DesktopBindings,
): void {
  for (const family of FOUNDATION_FAMILIES) {
    const map = bindings.foundations?.[family];
    if (
      !map ||
      typeof map !== "object" ||
      Array.isArray(map) ||
      !Object.keys(map).length
    )
      throw new Error(`Missing foundation bindings: ${family}`);
    for (const id of Object.values(map))
      if (!tokens[id])
        throw new Error(`Missing foundation token: ${family} → ${id}`);
  }
  const types = new Set([
    "color",
    "dimension",
    "number",
    "duration",
    "cubicBezier",
    "fontFamily",
    "fontWeight",
    "shadow",
  ]);
  for (const [id, token] of Object.entries(tokens)) {
    const role = id.startsWith("semantic.defaults.")
      ? id.split(".")[2]
      : undefined;
    if (role) {
      const governance = token.$extensions?.["com.cindy.governance"];
      if (
        PROTECTED_IDS[role] &&
        JSON.stringify(governance?.protected) !==
          JSON.stringify(PROTECTED_IDS[role])
      )
        throw new Error(`Missing protection metadata: ${id}`);
      if (
        SEMANTIC_EXEMPTION_IDS[role] &&
        JSON.stringify(governance?.exemption) !==
          JSON.stringify(SEMANTIC_EXEMPTION_IDS[role])
      )
        throw new Error(`Missing exemption metadata: ${id}`);
    }
    if (
      id.includes(".defaults.") &&
      Object.entries(PROTECTED_IDS).some(
        ([role, rule]) =>
          rule.mode === "register-only" && id.split(".")[2] === role,
      )
    )
      throw new Error(`Protected singleton must remain registered-only: ${id}`);
    if (!types.has(token.$type))
      throw new Error(`Unsupported standard type: ${id} (${token.$type})`);
    const target = aliasTarget(token.$value);
    if (target) {
      if (!tokens[target]) throw new Error(`Missing alias: ${id} → ${target}`);
      if (tokens[target].$type !== token.$type)
        throw new Error(`Alias type mismatch: ${id}`);
      const layer = id.split(".")[0];
      if (
        layer === "reference" ||
        (layer === "semantic" && !target.startsWith("reference.")) ||
        (layer === "component" && !target.startsWith("semantic.")) ||
        (layer === "themes" && !/^(semantic|reference)\./.test(target))
      ) {
        throw new Error(`Alias direction: ${id} → ${target}`);
      }
    } else {
      if (!id.startsWith("reference."))
        throw new Error(`Literal outside reference: ${id}`);
      if (token.$type === "dimension" || token.$type === "duration") {
        const v = token.$value as { value: number; unit: string };
        const units = token.$type === "dimension" ? ["px", "rem"] : ["ms", "s"];
        if (
          !v ||
          !Number.isFinite(v.value) ||
          !units.includes(v.unit) ||
          (token.$type === "duration" && v.value < 0)
        )
          throw new Error(`Invalid unit/value: ${id}`);
      }
      if (token.$type === "color") {
        const v = token.$value as {
          colorSpace: string;
          components: number[];
          alpha?: number;
        };
        const limits =
          v.colorSpace === "hsl"
            ? [360, 100, 100]
            : v.colorSpace === "srgb"
              ? [1, 1, 1]
              : null;
        if (
          !limits ||
          !Array.isArray(v.components) ||
          v.components.length !== 3 ||
          v.components.some(
            (n, i) =>
              !Number.isFinite(n) ||
              n < 0 ||
              n > limits[i] ||
              (v.colorSpace === "hsl" && i === 0 && n === 360),
          ) ||
          (v.alpha !== undefined &&
            (!Number.isFinite(v.alpha) || v.alpha < 0 || v.alpha > 1))
        )
          throw new Error(`Invalid color range: ${id}`);
      }
    }
    if (id.includes(".defaults.") && !/\.(light|dark)$/.test(id))
      throw new Error(`Invalid mode: ${id}`);
  }
  for (const [id, modes] of Object.entries(bindings.defaults)) {
    if (Object.keys(modes).sort().join(",") !== "dark,light")
      throw new Error(`Missing mode binding: ${id}`);
    for (const [mode, token] of Object.entries(modes)) {
      if (token !== null && (!tokens[token] || !token.endsWith(`.${mode}`)))
        throw new Error(`Invalid mode binding: ${id}.${mode}`);
    }
  }
  for (const [file, theme] of Object.entries(bindings.themes)) {
    if (!["light", "dark"].includes(theme.type))
      throw new Error(`Invalid theme mode: ${file}`);
    for (const token of Object.values(theme.tokens))
      if (!tokens[token])
        throw new Error(`Missing theme binding: ${file} → ${token}`);
  }
  for (const id of bindings.bootstrapCss) {
    if (!bindings.defaults[id])
      throw new Error(`Missing bootstrap CSS binding: ${id}`);
    for (const token of Object.values(bindings.defaults[id])) {
      if (!token || !tokens[token].$extensions?.[EXTENSION]?.cssAlias)
        throw new Error(`Bootstrap CSS requires symbolic alias: ${id}`);
    }
  }
  // These mappings enter the existing runtime scale calculation as numbers.
  // Other CSS dimensions may use rem, but dropping that unit here would turn
  // (for example) 1rem into 1px after applyFontSettings runs. Symbolic aliases
  // must be rejected as well: formatToken() would emit `var(--…)`, and the
  // parseFloat in generate.ts would silently bake NaN into the mappings.
  for (const family of ["numeric", "text", "lineHeight", "defaults"] as const) {
    for (const id of Object.values(bindings.foundations[family])) {
      if (tokens[id].$extensions?.[EXTENSION]?.cssAlias)
        throw new Error(`Runtime pixel binding cannot use a CSS alias: ${id}`);
      const value = referenceToken(id, tokens);
      if (
        value.$type !== "dimension" ||
        (value.$value as { unit?: string }).unit !== "px"
      )
        throw new Error(`Runtime pixel binding requires px dimension: ${id}`);
    }
  }
  validateSymbolicAliases(tokens, bindings);
}
function validateSymbolicAliases(
  tokens: Record<string, SourceToken>,
  bindings: DesktopBindings,
): void {
  const check = (
    id: string,
    mode: string,
    target: (role: string) => string | null | undefined,
  ) => {
    const ext = tokens[id].$extensions?.[EXTENSION];
    if (!ext?.cssAlias) return;
    if (
      typeof ext.cssAlias !== "string" ||
      !/^[a-z][a-z0-9-]*$/.test(ext.cssAlias) ||
      !["hsl", "var"].includes(String(ext.wrapper)) ||
      ext.mode !== mode
    )
      throw new Error(`Invalid symbolic alias: ${id}`);
    const destination = target(ext.cssAlias);
    if (
      !destination ||
      referenceToken(id, tokens) !== referenceToken(destination, tokens)
    )
      throw new Error(
        `Symbolic alias disconnected from DTCG: ${id} → ${ext.cssAlias}`,
      );
  };
  for (const modes of Object.values(bindings.defaults))
    for (const [mode, id] of Object.entries(modes))
      if (id)
        check(
          id,
          mode,
          (role) =>
            bindings.defaults[role]?.[mode as "light" | "dark"] ??
            bindings.defaults[role]?.light,
        );
  for (const theme of Object.values(bindings.themes))
    for (const id of Object.values(theme.tokens))
      check(
        id,
        theme.type,
        (role) => theme.tokens[role] ?? bindings.defaults[role]?.[theme.type],
      );
}
export function referenceToken(
  id: string,
  tokens: Record<string, SourceToken>,
): SourceToken {
  const token = tokens[id];
  if (!token) throw new Error(`Missing token: ${id}`);
  const target = aliasTarget(token.$value);
  return target ? referenceToken(target, tokens) : token;
}
/** Preserve historical trailing zeroes without rounding away a newly edited source value. */
function decimal(value: unknown, precision = 0): string {
  const n = Number(value);
  const padded = n.toFixed(precision);
  return Number(padded) === n ? padded : String(n);
}
/** Formatting metadata carries syntax only. All numeric values come from Terrazzo. */
export function formatToken(
  id: string,
  tokens: TokenNormalizedSet,
  source: Record<string, SourceToken>,
): string {
  const original = source[id];
  const own = original.$extensions?.[EXTENSION];
  if (own?.cssAlias)
    return own.wrapper === "hsl"
      ? `hsl(var(--${own.cssAlias}))`
      : `var(--${own.cssAlias})`;
  const token = tokens[id];
  if (!token) throw new Error(`Terrazzo did not build ${id}`);
  const format = referenceToken(id, source).$extensions?.[EXTENSION] ?? {};
  switch (token.$type) {
    case "dimension":
    case "duration":
      return `${token.$value.value}${token.$value.unit}`;
    case "number":
    case "fontWeight":
      return String(token.$value);
    case "fontFamily":
      return (Array.isArray(token.$value) ? token.$value : [token.$value])
        .map((v) => (/\s/.test(v) ? `'${v}'` : v))
        .join(", ");
    case "cubicBezier":
      return `cubic-bezier(${token.$value.join(", ")})`;
    case "shadow":
      return token.$value
        .map((shadow) => {
          if (shadow.color.colorSpace !== "srgb")
            throw new Error(`Historical shadow format requires sRGB: ${id}`);
          const dim = (v: { value: number; unit: string }) =>
            `${v.value}${v.unit}`;
          const rgb = shadow.color.components.map((v) =>
            Math.round(Number(v) * 255),
          );
          const color =
            format.format === "shadow-space-rgb"
              ? `rgb(${rgb.join(" ")} / ${shadow.color.alpha})`
              : `rgba(${rgb.join(", ")}, ${shadow.color.alpha})`;
          return `${shadow.inset ? "inset " : ""}${format.bareZeroX && shadow.offsetX.value === 0 ? "0" : dim(shadow.offsetX)} ${dim(shadow.offsetY)} ${dim(shadow.blur)}${format.omitZeroSpread && shadow.spread.value === 0 ? "" : ` ${dim(shadow.spread)}`} ${color}`;
        })
        .join(", ");
    case "color": {
      const color = token.$value;
      if (format.format === "triplet") {
        if (color.colorSpace !== "hsl")
          throw new Error(`Triplet requires HSL: ${id}`);
        if (format.alphaPrecision === undefined && color.alpha !== 1)
          throw new Error(`Triplet format cannot discard alpha: ${id}`);
        const precision = format.precision as number[];
        return (
          color.components
            .map((v, i) => `${decimal(v, precision[i])}${i ? "%" : ""}`)
            .join(" ") +
          (format.alphaPrecision !== undefined
            ? ` / ${decimal(color.alpha, format.alphaPrecision as number)}`
            : "")
        );
      }
      if (color.colorSpace !== "srgb") throw new Error(`Expected sRGB: ${id}`);
      const components = color.components.map((v) =>
        Math.round(Number(v) * 255),
      );
      if (format.format === "transparent") {
        if (color.alpha !== 0 || components.some((v) => v !== 0))
          throw new Error(
            `Transparent format requires transparent black: ${id}`,
          );
        return "transparent";
      }
      if (format.format !== "transparent" && !format.alpha && color.alpha !== 1)
        throw new Error(`Color format cannot discard alpha: ${id}`);
      if (format.format === "rgb")
        return format.alpha
          ? `rgba(${components.join(", ")}, ${decimal(color.alpha, format.precision as number)})`
          : `rgb(${components.join(", ")})`;
      if (format.format !== "hex")
        throw new Error(`Missing color format: ${id}`);
      if (format.alpha) components.push(Math.round(Number(color.alpha) * 255));
      let hex = components.map((v) => v.toString(16).padStart(2, "0")).join("");
      if (format.uppercase) hex = hex.toUpperCase();
      return `#${hex}`;
    }
    default:
      throw new Error(`Unsupported output type: ${token.$type}`);
  }
}
export function replaceRegion(
  contents: string,
  name: string,
  body: string,
  style: "code" | "markdown" = "code",
): string {
  const marker = (edge: string) =>
    style === "markdown"
      ? `<!-- ${edge} GENERATED DS-8: ${name} -->`
      : `// ${edge} GENERATED DS-8: ${name}`;
  const start = marker("BEGIN");
  const end = marker("END");
  if (contents.split(start).length !== 2 || contents.split(end).length !== 2)
    throw new Error(`Missing/duplicate generated region: ${name}`);
  const a = contents.indexOf(start),
    b = contents.indexOf(end);
  if (b < a) throw new Error(`Reversed generated region: ${name}`);
  return (
    contents.slice(0, a) +
    start +
    "\n" +
    body.trimEnd() +
    "\n" +
    contents.slice(b)
  );
}
