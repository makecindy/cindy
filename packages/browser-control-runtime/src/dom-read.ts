/**
 * `extract` — structured DOM extraction, compiled to a single injected JS
 * function shared by the isolated DOM reader and the legacy `act:evaluate`
 * fallback. Pulling just the fields you need is far cheaper than a
 * full-page snapshot + letting the model hunt for them in thousands of nodes.
 *
 * `buildExtractFnSource()` is a PURE function (spec → JS source string) so it is
 * unit-testable without a browser. All selectors/attrs are injected via
 * `JSON.stringify` (never string-concatenated) to avoid breaking out of the
 * generated source.
 */

import { z } from "zod";

/** Reusable zod schema for an extract spec — shared by the `browser` tool input
 *  and recipe `extract` steps so the two never drift. */
export const ExtractSpecSchema = z.object({
  from: z.string().optional(),
  multiple: z.boolean().optional(),
  fields: z.record(
    z.string(),
    z.union([
      z.string(),
      z.object({
        selector: z.string().optional(),
        attr: z.string().optional(),
        type: z.enum(["text", "html", "attr", "href"]).optional(),
      }),
    ]),
  ),
  limit: z.number().int().positive().optional(),
});

/** A field is either a CSS selector shorthand (→ trimmed textContent) or a spec. */
export type ExtractFieldSpec =
  | string
  | {
      /** CSS selector relative to the record container; omit = the container itself. */
      selector?: string;
      /** Attribute name (implies type 'attr' unless `type` says otherwise). */
      attr?: string;
      /** How to read the resolved element. Default 'text'. */
      type?: "text" | "html" | "attr" | "href";
    };

export interface ExtractSpec {
  /** Container selector. With `multiple`, one record per match; else a single record. Omit = whole document. */
  from?: string;
  /** querySelectorAll over `from` → one record each. */
  multiple?: boolean;
  /** Field name → how to extract it. */
  fields: Record<string, ExtractFieldSpec>;
  /** Cap the number of records (only meaningful with `multiple`). */
  limit?: number;
}

interface NormalizedField {
  selector?: string;
  attr?: string;
  type: "text" | "html" | "attr" | "href";
}

/**
 * Agent-facing teaching hint embedded in the extract result when a selector is
 * invalid — mirrors the upstream "teach via error" idiom (SELECTOR_UNSUPPORTED_MESSAGE):
 * the error itself shows the correct usage so the model self-corrects.
 */
export const EXTRACT_FIELD_HINT =
  "fields 的简写 string 是**纯 CSS 选择器**(取该元素 textContent);" +
  '要取属性用对象形式 {selector:"h3 a", attr:"title"};取链接用 {selector:"a", type:"href"}。' +
  '不要把属性名拼进选择器(如 "h3 a@title" 非法),也不要写自然语言。' +
  "不确定真实结构时,先用 snapshot(可带 selector 收窄)看 DOM,再据此写 extract 的选择器。";

/** All selector strings referenced by a spec (`from` + each field's selector). */
export function collectSelectors(spec: ExtractSpec): string[] {
  const out: string[] = [];
  if (spec.from) out.push(spec.from);
  for (const f of Object.values(spec.fields)) {
    if (typeof f === "string") out.push(f);
    else if (f.selector) out.push(f.selector);
  }
  return out;
}

/** Expand field shorthands to a uniform `{selector, attr, type}` shape. */
function normalizeFields(
  fields: Record<string, ExtractFieldSpec>,
): Record<string, NormalizedField> {
  const out: Record<string, NormalizedField> = {};
  for (const [name, f] of Object.entries(fields)) {
    if (typeof f === "string") {
      out[name] = { selector: f, type: "text" };
    } else {
      out[name] = {
        selector: f.selector,
        attr: f.attr,
        type: f.type ?? (f.attr ? "attr" : "text"),
      };
    }
  }
  return out;
}

/** JSON quoting plus script-delimiter/line-separator escaping for JS source. */
function javascriptLiteral(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>\u2028\u2029]/g,
    (char) =>
      ({
        "<": "\\u003c",
        ">": "\\u003e",
        "\u2028": "\\u2028",
        "\u2029": "\\u2029",
      })[char]!,
  );
}

/**
 * Compile an extract spec into a zero-arg JS function source string suitable for
 * `act:evaluate`. The function runs in page context and returns
 * `{ ok: true, count, records }`.
 */
export function buildExtractFnSource(spec: ExtractSpec): string {
  const normalized = {
    from: spec.from,
    multiple: Boolean(spec.multiple),
    limit: spec.limit,
    fields: normalizeFields(spec.fields),
  };
  // The whole spec + hint are embedded as JSON literals — selectors/attrs are
  // data, not code, so there is no injection surface.
  const specLiteral = javascriptLiteral(normalized);
  const hintLiteral = javascriptLiteral(EXTRACT_FIELD_HINT);
  // querySelector is guarded: an invalid selector (e.g. natural language, or the
  // "h3 a@title" attr-in-selector mistake) is collected into `bad` and reported
  // as ok:false + hint, instead of throwing and killing the whole extract.
  return `() => {
  const SPEC = ${specLiteral};
  const HINT = ${hintLiteral};
  const bad = [];
  const qOne = (root, s) => { try { return root.querySelector(s); } catch (e) { bad.push(s); return null; } };
  const qAll = (root, s) => { try { return Array.from(root.querySelectorAll(s)); } catch (e) { bad.push(s); return []; } };
  const containers = SPEC.from
    ? (SPEC.multiple ? qAll(document, SPEC.from) : [qOne(document, SPEC.from)].filter(Boolean))
    : [document];
  const limited = SPEC.limit ? containers.slice(0, SPEC.limit) : containers;
  const pick = (container, f) => {
    const el = f.selector ? qOne(container, f.selector) : container;
    if (!el) return null;
    if (f.type === 'html') return el.innerHTML;
    if (f.type === 'href') {
      const h = el.getAttribute('href');
      try { return h == null ? null : new URL(h, location.href).href; } catch (_e) { return h; }
    }
    if (f.type === 'attr') return f.attr ? el.getAttribute(f.attr) : null;
    return (el.textContent || '').trim();
  };
  const records = limited.map((container) => {
    const rec = {};
    for (const name of Object.keys(SPEC.fields)) rec[name] = pick(container, SPEC.fields[name]);
    return rec;
  });
  if (bad.length) {
    return { ok: false, error: 'invalid CSS selector(s): ' + Array.from(new Set(bad)).join(', '), hint: HINT, count: records.length, records };
  }
  return { ok: true, count: records.length, records };
}`;
}

/** Fixed internal reads, not an assertion that arbitrary JavaScript is safe. */
export const BrowserDomReadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("extract"), extract: ExtractSpecSchema }).strict(),
  z.object({ kind: z.literal("login-wall") }).strict(),
]);
export type BrowserDomRead = z.infer<typeof BrowserDomReadSchema>;

export const LOGIN_WALL_FN = `() => {
  const docs = [document];
  for (const frame of document.querySelectorAll('iframe')) {
    try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch {}
  }
  const has = (selector) => docs.some((doc) => doc.querySelector(selector));
  return {
    password: !!has('input[type=password]'),
    code: !!has('input[autocomplete="one-time-code"]'),
  };
}`;

export function buildDomReadSource(input: unknown): string {
  const read = BrowserDomReadSchema.parse(input);
  return read.kind === "extract"
    ? buildExtractFnSource(read.extract)
    : LOGIN_WALL_FN;
}
