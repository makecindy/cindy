export { RICH_COLOR_ROLES, richColor, richVisualStyle, richVector, type RichColorRole, type RichPalette } from "./richAnswerVisual";
export { youtubeVideo } from "./youtubeVideo";
/** Model-neutral, declarative answer components. No code evaluation or I/O. */
export const RICH_ANSWER_LANGUAGE = "cindy-ui";
export const RICH_ANSWER_KINDS = [
  "text",
  "markdown",
  "heading",
  "icon",
  "stack",
  "row",
  "grid",
  "group",
  "divider",
  "image",
  "video",
  "audio",
  "code",
  "math",
  "diagram",
  "stat",
  "chart",
  "svg",
  "range",
  "input",
  "check",
  "select",
  "button",
  "form",
  "details",
  "tabs",
] as const;
export type RichAnswerKind = (typeof RICH_ANSWER_KINDS)[number];
export type RichValue = string | number | boolean;
export type RichValues = Readonly<Record<string, RichValue | undefined>>;
export interface RichNode {
  id: string;
  kind: RichAnswerKind;
  props: Record<string, unknown>;
  children: string[];
}
export interface RichDocument {
  nodes: ReadonlyMap<string, RichNode>;
  roots: readonly string[];
  revision: number;
  issues: number;
}
export type RichPart = {
  kind: "markdown" | "rich";
  key: number;
  source: string;
  complete: boolean;
};
const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const MAX_SOURCE = 2_000_000;
const MAX_NODES = 2048;
const MAX_DEPTH = 32;
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const value = (v: unknown): v is RichValue =>
  typeof v === "string" ||
  typeof v === "boolean" ||
  (typeof v === "number" && Number.isFinite(v));
const own = (o: object, k: string) =>
  Object.prototype.hasOwnProperty.call(o, k);

/** Split only explicit answer fences, never a cindy-ui example inside another fence. */
export function splitRichAnswer(source: string): RichPart[] {
  const parts: RichPart[] = [];
  let cursor = 0,
    start = 0,
    richStart = -1;
  let fence: { char: string; count: number; rich: boolean } | undefined;
  // Line iteration preserves source offsets/keys as the tail grows.
  for (const line of source.split(/(?<=\n)/)) {
    const body = line.replace(/\r?\n$/, "");
    if (!fence) {
      const open = body.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/);
      if (open) {
        fence = {
          char: open[1][0],
          count: open[1].length,
          rich: open[2].trim() === RICH_ANSWER_LANGUAGE,
        };
        if (fence.rich) {
          if (cursor > start)
            parts.push({
              kind: "markdown",
              key: start,
              source: source.slice(start, cursor),
              complete: true,
            });
          richStart = cursor;
          start = cursor + line.length;
        }
      }
    } else if (
      new RegExp(`^ {0,3}${fence.char}{${fence.count},}\\s*$`).test(body)
    ) {
      if (fence.rich && richStart >= 0) {
        parts.push({
          kind: "rich",
          key: richStart,
          source: source.slice(start, cursor),
          complete: true,
        });
        start = cursor + line.length;
        richStart = -1;
      }
      fence = undefined;
    }
    cursor += line.length;
  }
  if (richStart >= 0)
    parts.push({
      kind: "rich",
      key: richStart,
      source: source.slice(start),
      complete: false,
    });
  else if (start < source.length)
    parts.push({
      kind: "markdown",
      key: start,
      source: source.slice(start),
      complete: false,
    });
  return parts;
}
export const hasRichAnswer = (source: string): boolean =>
  splitRichAnswer(source).some((p) => p.kind === "rich");

/** One instance per answer fragment. Snapshot corrections rebuild; append-only deltas parse once. */
export class RichAnswerStream {
  private source = "";
  private offset = 0;
  private seq = 0;
  private nodes = new Map<string, RichNode>();
  private roots: string[] = [];
  private revision = 0;
  private issues = 0;
  update(source: string, complete = false): RichDocument {
    if (!source.startsWith(this.source)) {
      this.source = "";
      this.offset = 0;
      this.seq = 0;
      this.nodes = new Map();
      this.roots = [];
      this.issues = 0;
      this.revision++;
    }
    if (source.length > MAX_SOURCE) {
      this.issues = Math.max(1, this.issues);
      return this.snapshot();
    }
    this.source = source;
    this.nodes = new Map(this.nodes);
    let end: number;
    while ((end = source.indexOf("\n", this.offset)) !== -1) {
      this.line(source.slice(this.offset, end));
      this.offset = end + 1;
    }
    if (complete && this.offset < source.length) {
      this.line(source.slice(this.offset));
      this.offset = source.length;
    }
    return this.snapshot();
  }
  private snapshot(): RichDocument {
    return {
      nodes: this.nodes,
      roots: this.roots,
      revision: this.revision,
      issues: this.issues,
    };
  }
  private line(line: string) {
    if (!line.trim()) return;
    try {
      const op: unknown = JSON.parse(line);
      if (!record(op) || !Number.isSafeInteger(op.seq) || Number(op.seq) < 1)
        throw Error("sequence");
      const seq = Number(op.seq);
      if (seq <= this.seq) return;
      // A malformed or absent line leaves a numbering gap: committed content stays,
      // the missing operations are reported, and later lines still apply.
      this.issues += Math.min(seq - this.seq - 1, MAX_NODES);
      this.seq = seq;
      if (op.version !== undefined && op.version !== 1) throw Error("version");
      if (typeof op.id !== "string" || !ID.test(op.id)) throw Error("id");
      const current = this.nodes.get(op.id);
      const props = this.props(op.props);
      // Some real harness outputs place visual style beside props. Normalize once.
      if (record(op.style) && props.style === undefined)
        props.style = this.props(op.style);
      if (op.op === "create") {
        if (
          current ||
          this.nodes.size >= MAX_NODES ||
          !RICH_ANSWER_KINDS.includes(op.kind as RichAnswerKind)
        )
          throw Error("component");
        const parent =
          op.parent === undefined || op.parent === "root"
            ? null
            : this.nodes.get(String(op.parent));
        if (op.parent && op.parent !== "root" && !parent) throw Error("parent");
        if (
          parent &&
          ![
            "stack",
            "row",
            "grid",
            "group",
            "form",
            "details",
            "tabs",
          ].includes(parent.kind)
        )
          throw Error("leaf");
        const node: RichNode = {
          id: op.id,
          kind: op.kind as RichAnswerKind,
          props,
          children: [],
        };
        // The bounded depth also limits recursive React rendering.
        if (parent && this.depth(parent.id) >= MAX_DEPTH) throw Error("depth");
        this.nodes.set(node.id, node);
        const index = Number.isInteger(op.index)
          ? Math.max(0, Number(op.index))
          : Infinity;
        if (parent) {
          const children = [...parent.children];
          children.splice(index, 0, node.id);
          this.nodes.set(parent.id, { ...parent, children });
        } else {
          this.roots = [...this.roots];
          this.roots.splice(index, 0, node.id);
        }
      } else if (op.op === "append") {
        if (
          !current ||
          !["text", "markdown", "heading", "code", "math", "diagram"].includes(
            current.kind,
          ) ||
          typeof op.text !== "string"
        )
          throw Error("text");
        this.nodes.set(current.id, {
          ...current,
          props: {
            ...current.props,
            text: richString(current, "text") + op.text,
          },
        });
      } else if (op.op === "patch") {
        if (!current) throw Error("target");
        this.nodes.set(current.id, {
          ...current,
          props: { ...current.props, ...props },
        });
      } else if (op.op === "remove") {
        if (!current) throw Error("target");
        const remove = (id: string) => {
          this.nodes.get(id)?.children.forEach(remove);
          this.nodes.delete(id);
        };
        remove(current.id);
        this.roots = this.roots.filter((id) => id !== current.id);
        for (const [id, node] of this.nodes)
          if (node.children.includes(current.id))
            this.nodes.set(id, {
              ...node,
              children: node.children.filter((x) => x !== current.id),
            });
      } else if (op.op === "move") {
        if (!current) throw Error("target");
        const parent =
          op.parent === "root" ? null : this.nodes.get(String(op.parent));
        if (op.parent !== "root" && !parent) throw Error("parent");
        if (
          parent &&
          (![
            "stack",
            "row",
            "grid",
            "group",
            "form",
            "details",
            "tabs",
          ].includes(parent.kind) ||
            this.descendant(current.id, parent.id))
        )
          throw Error("cycle");
        const height = (id: string): number =>
          1 + Math.max(0, ...(this.nodes.get(id)?.children.map(height) ?? []));
        if (
          (parent ? this.depth(parent.id) : 0) + height(current.id) >
          MAX_DEPTH
        )
          throw Error("depth");
        this.roots = this.roots.filter((id) => id !== current.id);
        for (const [id, node] of this.nodes)
          if (node.children.includes(current.id))
            this.nodes.set(id, {
              ...node,
              children: node.children.filter((x) => x !== current.id),
            });
        const index = Number.isInteger(op.index)
          ? Math.max(0, Number(op.index))
          : Infinity;
        if (parent) {
          const node = this.nodes.get(parent.id)!;
          const children = [...node.children];
          children.splice(index, 0, current.id);
          this.nodes.set(node.id, { ...node, children });
        } else {
          this.roots = [...this.roots];
          this.roots.splice(index, 0, current.id);
        }
      } else throw Error("operation");
      this.revision++;
    } catch {
      this.issues++;
    }
  }
  private props(v: unknown): Record<string, unknown> {
    if (v === undefined) return {};
    if (!record(v) || JSON.stringify(v).length > 65_536) throw Error("props");
    return Object.fromEntries(
      Object.entries(v).filter(
        ([key]) => !["__proto__", "constructor", "prototype"].includes(key),
      ),
    );
  }
  private descendant(root: string, id: string): boolean {
    return (
      root === id ||
      !!this.nodes
        .get(root)
        ?.children.some((child) => this.descendant(child, id))
    );
  }
  private depth(id: string): number {
    for (const node of this.nodes.values())
      if (node.children.includes(id)) return 1 + this.depth(node.id);
    return 1;
  }
}
export function richString(node: RichNode, key: string, fallback = ""): string {
  return typeof node.props[key] === "string"
    ? (node.props[key] as string)
    : fallback;
}
export function richNumber(
  node: RichNode,
  key: string,
  fallback: number,
): number {
  const v = node.props[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
export function richOptions(
  node: RichNode,
): { label: string; value: string }[] {
  return Array.isArray(node.props.options)
    ? node.props.options
        .slice(0, 100)
        .filter(record)
        .filter(
          (x) => typeof x.label === "string" && typeof x.value === "string",
        )
        .map((x) => ({ label: String(x.label), value: String(x.value) }))
    : [];
}
export function richDefaults(
  document: RichDocument,
): Record<string, RichValue> {
  return Object.fromEntries(
    [...document.nodes.values()]
      .filter((n) =>
        ["input", "range", "select", "check", "tabs", "details"].includes(
          n.kind,
        ),
      )
      .map((n) => [
        richString(n, "bind", n.id),
        value(n.props.default)
          ? n.props.default
          : n.kind === "check" || n.kind === "details"
            ? false
            : n.kind === "range"
              ? richNumber(n, "min", 0)
              : "",
      ]),
  );
}
/** Resolve inputs and calculated node references from one document snapshot.
 * Forward references are supported; cycles and missing values stay unavailable. */
export function richResolvedValues(
  document: RichDocument,
  edited: RichValues = {},
): RichValues {
  const values: Record<string, RichValue | undefined> = {
    ...richDefaults(document),
    ...edited,
  };
  const visiting = new Set<string>();
  const resolve = (id: string): RichValue | undefined => {
    if (own(values, id)) return values[id];
    if (visiting.has(id) || visiting.size >= MAX_DEPTH) return undefined;
    const node = document.nodes.get(id);
    if (!node || !["stat", "text", "heading"].includes(node.kind))
      return undefined;
    visiting.add(id);
    const result = richEvaluate(
      node.props.value ?? node.props.text,
      values,
      0,
      resolve,
    );
    visiting.delete(id);
    Object.defineProperty(values, id, {
      value: result,
      enumerable: true,
      configurable: true,
    });
    return result;
  };
  for (const node of document.nodes.values()) resolve(node.id);
  return values;
}

/** Whitelisted arithmetic, never JavaScript. Unavailable values cannot coerce to zero. */
export function richEvaluate(
  expr: unknown,
  values: RichValues,
  depth = 0,
  resolve?: (id: string) => RichValue | undefined,
): RichValue | undefined {
  if (value(expr)) return expr;
  if (!record(expr) || depth > 16) return undefined;
  if (typeof expr.ref === "string")
    return own(values, expr.ref) ? values[expr.ref] : resolve?.(expr.ref);
  if (!Array.isArray(expr.args) || expr.args.length > 32) return undefined;
  const evaluate = (x: unknown) => richEvaluate(x, values, depth + 1, resolve);
  // Evaluate only the selected branch: an unused forward reference is harmless.
  if (expr.op === "if") {
    if (expr.args.length !== 3) return undefined;
    const condition = evaluate(expr.args[0]);
    return condition === undefined
      ? undefined
      : evaluate(expr.args[condition ? 1 : 2]);
  }
  const args = expr.args.map(evaluate);
  if (args.some((x) => x === undefined)) return undefined;
  if (expr.op === "concat") {
    // Computed references may share and repeatedly double strings. Bound the
    // result before allocating it, just like an individual node props payload.
    if (
      args.reduce<number>((size, arg) => size + String(arg).length, 0) > 65_536
    )
      return undefined;
    return args.join("");
  }
  if (
    ["eq", "lt", "gt", "sub", "div"].includes(String(expr.op)) &&
    args.length !== 2
  )
    return undefined;
  if (expr.op === "eq") return args[0] === args[1];
  if (args.length === 0 || args.some((x) => typeof x === "string" && !x.trim()))
    return undefined;
  const nums = args.map(Number);
  if (!nums.every(Number.isFinite)) return undefined;
  let result: number;
  switch (expr.op) {
    case "add":
      result = nums.reduce((a, b) => a + b, 0);
      break;
    case "mul":
      result = nums.reduce((a, b) => a * b, 1);
      break;
    case "sub":
      result = nums[0] - nums[1];
      break;
    case "div":
      result = nums[0] / nums[1];
      break;
    case "min":
      result = Math.min(...nums);
      break;
    case "max":
      result = Math.max(...nums);
      break;
    case "lt":
      return nums[0] < nums[1];
    case "gt":
      return nums[0] > nums[1];
    default:
      return undefined;
  }
  return Number.isFinite(result) ? result : undefined;
}
export function richValue(
  node: RichNode,
  values: RichValues,
): RichValue | undefined {
  return richEvaluate(node.props.value ?? node.props.text ?? "", values);
}
export function richLabel(node: RichNode, values: RichValues): string {
  const result = richValue(node, values);
  return result === undefined
    ? "—"
    : richString(node, "prefix") + String(result) + richString(node, "suffix");
}
/** Component-local pending/error display; unaffected prose and controls remain usable. */
export function richCalculationUnavailable(
  node: RichNode,
  values: RichValues,
): boolean {
  if (["stat", "text", "heading"].includes(node.kind))
    return richValue(node, values) === undefined;
  return (
    node.kind === "chart" &&
    Array.isArray(node.props.data) &&
    node.props.data.some((item) => {
      if (!record(item)) return true;
      const result = richEvaluate(item.value, values);
      return (
        result === undefined ||
        (typeof result === "string" && !result.trim()) ||
        !Number.isFinite(Number(result))
      );
    })
  );
}
export function richAction(
  node: RichNode,
  values: RichValues,
): Record<string, RichValue> {
  const action = node.props.set;
  if (!record(action)) return {};
  const changes: Record<string, RichValue> = {};
  for (const [key, expr] of Object.entries(action)
    .filter(([key]) => ID.test(key))
    .slice(0, 100)) {
    const result = richEvaluate(expr, values);
    if (result === undefined) return {}; // an invalid form cannot partially apply
    Object.defineProperty(changes, key, {
      value: result,
      enumerable: true,
      configurable: true,
    });
  }
  return changes;
}

/** Optional message action. The host supplies the current conversation; generated
 * content cannot select a recipient, tool or command. Nothing runs on value changes. */
export function richSendText(node: RichNode, values: RichValues): string | undefined {
  if (node.kind !== "button" && node.kind !== "form") return undefined;
  const text = richEvaluate(node.props.send, values);
  return typeof text === "string" && text.trim() && text.length <= 16_000
    ? text.trim() : undefined;
}

export type RichMessageSender = (text: string) => Promise<boolean>;
export type RichSubmissionStatus = "idle" | "sending" | "sent" | "failed";

/** Click receipts live outside model-editable bindings. Pending submissions survive
 * virtualization, and failed sends leave controls untouched for an explicit retry. */
export class RichSubmissionController {
  private pending = new Set<string>();
  private failed = new Set<string>();
  private listeners = new Set<() => void>();
  constructor(private memory: RichInteractionMemory) {}
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    const unsubscribe = this.memory.subscribe(listener);
    return () => { this.listeners.delete(listener); unsubscribe(); };
  };
  private notify() { this.listeners.forEach(listener => listener()); }
  status(key: string, text: string | undefined): RichSubmissionStatus {
    if (this.pending.has(key)) return "sending";
    if (text !== undefined && this.memory.get(key).text === text) return "sent";
    return this.failed.has(key) ? "failed" : "idle";
  }
  async submit(key: string, text: string, send: RichMessageSender): Promise<void> {
    if (["sending", "sent"].includes(this.status(key, text))) return;
    this.pending.add(key);
    this.failed.delete(key);
    this.notify();
    try {
      await this.memory.load();
      if (this.memory.get(key).text === text) return;
      if (!await send(text)) throw new Error("message-not-accepted");
      this.memory.set(key, { text });
      this.memory.flushSync();
      await this.memory.flush();
    } catch {
      this.failed.add(key);
      if (this.failed.size > 256) this.failed.delete(this.failed.values().next().value!);
    } finally {
      this.pending.delete(key);
      this.notify();
    }
  }
}

/** Route media and links through the existing Markdown trust and file-origin path. */
export function richMarkdown(node: RichNode): string | null {
  const text = richString(node, "text");
  const fenced = (language: string) => {
    const fence = "`".repeat(
      Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)),
    );
    return `${fence}${language}\n${text}\n${fence}`;
  };
  if (node.kind === "markdown") return text;
  if (node.kind === "code")
    return fenced(richString(node, "language").replace(/[^\w+-]/g, ""));
  if (node.kind === "diagram") return fenced("mermaid");
  if (node.kind === "math") return `$$\n${text}\n$$`;
  if (["image", "video", "audio"].includes(node.kind)) {
    const src = richString(node, "src").replace(/[\n\r<>]/g, "");
    const alt = richString(node, "alt").replace(/[\[\]\\\n\r]/g, "");
    return src ? `![${alt}](<${src}>)` : "";
  }
  return null;
}

/** View-state cache, keyed by owner/device/message/fragment by each host. Never model context. */
export interface RichStateStorage {
  read(): Promise<string | null>;
  write(serialized: string): Promise<void>;
  writeSync?(serialized: string): void;
}
export class RichInteractionMemory {
  private entries = new Map<string, RichValues>();
  private empty: RichValues = Object.freeze({});
  private listeners = new Set<() => void>();
  private loading?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private writes = Promise.resolve();
  constructor(private storage?: RichStateStorage) {}
  get(key: string): RichValues {
    return this.entries.get(key) ?? this.empty;
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }
  load(): Promise<void> {
    return (this.loading ??= (async () => {
      if (!this.storage) return;
      try {
        const raw = await this.storage.read();
        if (!raw || raw.length > 524288) return;
        const parsed: unknown = JSON.parse(raw);
        if (
          !record(parsed) ||
          parsed.version !== 1 ||
          !Array.isArray(parsed.entries)
        )
          return;
        const stored = new Map<string, RichValues>();
        for (const pair of parsed.entries.slice(-256)) {
          if (
            !Array.isArray(pair) ||
            typeof pair[0] !== "string" ||
            !record(pair[1])
          )
            continue;
          const values = Object.fromEntries(
            Object.entries(pair[1]).filter(
              ([key, v]) => ID.test(key) && value(v),
            ),
          );
          if (JSON.stringify(values).length <= 65536)
            stored.set(pair[0], values as Record<string, RichValue>);
        }
        // A slow read never overwrites input entered while hydration is pending.
        for (const [key, edited] of this.entries)
          stored.set(key, { ...stored.get(key), ...edited });
        this.entries = stored;
        this.trim();
        this.notify();
      } catch {
        /* View-state recovery must not prevent reading the answer. */
      }
    })());
  }
  set(key: string, patch: RichValues): RichValues {
    const next = { ...this.get(key), ...patch };
    if (Object.keys(next).length > 2048 || JSON.stringify(next).length > 65536)
      return this.get(key);
    this.entries.delete(key);
    this.entries.set(key, next);
    this.trim();
    this.notify();
    if (this.storage) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        void this.flush();
      }, 200);
    }
    return next;
  }
  private serialize(): string {
    return JSON.stringify({ version: 1, entries: [...this.entries] });
  }
  private trim(): void {
    while (this.entries.size > 256 || this.serialize().length > 524288)
      this.entries.delete(this.entries.keys().next().value!);
  }
  flushSync(): void {
    clearTimeout(this.timer);
    try {
      this.storage?.writeSync?.(this.serialize());
    } catch {
      /* Storage unavailable: keep in-memory values. */
    }
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    await this.load();
    const serialized = this.serialize();
    this.writes = this.writes
      .then(() => this.storage?.write(serialized))
      .then(() => undefined)
      .catch(() => undefined);
    return this.writes;
  }
  clear(): void {
    this.entries.clear();
    this.notify();
  }
}
export function richChart(
  node: RichNode,
  values: RichValues,
): { label: string; value: number }[] {
  return Array.isArray(node.props.data)
    ? node.props.data
        .slice(0, 100)
        .filter(record)
        .map((item) => ({
          label: typeof item.label === "string" ? item.label : "",
          value: Number(richEvaluate(item.value, values)),
        }))
        .filter((item) => Number.isFinite(item.value))
    : [];
}

/** Shared plot coordinates keep native and desktop charts aligned with the same data. */
export function richLinePlot(
  data: { label: string; value: number }[],
  width: number,
  options: Record<string, unknown> = {},
) {
  const number = (key: string, fallback: number) =>
    typeof options[key] === "number" && Number.isFinite(options[key])
      ? (options[key] as number)
      : fallback;
  const w = Math.max(180, width),
    height = Math.max(80, number("height", 220));
  const top = Math.max(0, number("top", 28)),
    bottom = height - Math.max(0, number("bottom", 28));
  let min = Math.min(...data.map((item) => item.value)),
    max = Math.max(...data.map((item) => item.value));
  if (!data.length) {
    min = 0;
    max = 1;
  }
  if (options.includeZero === true) {
    min = Math.min(0, min);
    max = Math.max(0, max);
  }
  const pad = (max - min || Math.abs(max) * 0.05 || 1) * 0.1;
  min = number("yMin", min - pad);
  max = number("yMax", max + pad);
  if (max <= min) max = min + 1;
  const scale = Math.max(Math.abs(min), Math.abs(max), 1),
    span = max / scale - min / scale;
  const y = (v: number) =>
    bottom - ((v / scale - min / scale) / span) * (bottom - top);
  const tickCount = Math.max(2, Math.min(50, Math.round(number("ticks", 4))));
  const tickStep = (max - min) / (tickCount - 1);
  const decimals = Math.max(
    0,
    Math.min(12, number("decimals", Math.ceil(-Math.log10(tickStep)) + 1)),
  );
  const ticks = Array.from({ length: tickCount }, (_, i) => {
    const value = min + tickStep * i;
    return {
      value,
      y: y(value),
      label: Number(value.toFixed(decimals)).toLocaleString(undefined, {
        maximumFractionDigits: decimals,
      }),
    };
  });
  const left = Math.max(
    0,
    number(
      "left",
      Math.max(...ticks.map((tick) => tick.label.length * 7)) + 12,
    ),
  );
  const right = Math.max(0, number("right", 20));
  const pointSpace = (w - left - right) / Math.max(1, data.length);
  const longest = Math.max(1, ...data.map((item) => String(item.value).length));
  const labelWidth = Math.max(
    1,
    ...data.map((item) =>
      Array.from(item.label).reduce(
        (n, c) => n + (c.charCodeAt(0) > 255 ? 12 : 7),
        0,
      ),
    ),
  );
  const labelStep = Math.max(
    1,
    Math.ceil((labelWidth + 12) / Math.max(1, pointSpace)),
  );
  return {
    width: w,
    height,
    labelY: height - 6,
    labels: data.flatMap((item, i) =>
      options.showLabels === false || i % labelStep !== 0
        ? []
        : [{ label: item.label, x: left + (i + 0.5) * pointSpace }],
    ),
    left,
    right,
    min,
    max,
    ticks,
    points: data.map((item, i) => ({
      ...item,
      x: left + (i + 0.5) * pointSpace,
      y: y(item.value),
    })),
    showValues:
      typeof options.showValues === "boolean"
        ? options.showValues
        : longest * 8 + 16 <= pointSpace,
  };
}
export function richRange(
  node: RichNode,
  current: unknown,
): { min: number; max: number; step: number; value: number } {
  const min = richNumber(node, "min", 0),
    max = Math.max(min + 1, richNumber(node, "max", 100));
  const step = Math.max(Number.EPSILON, richNumber(node, "step", 1));
  const n = Number(current);
  return {
    min,
    max,
    step,
    value: Math.min(max, Math.max(min, Number.isFinite(n) ? n : min)),
  };
}

/** Readable copy/export for channels without a component renderer. */
export function richAnswerText(source: string): string {
  return splitRichAnswer(source)
    .map((part) => {
      if (part.kind === "markdown") return part.source;
      const doc = new RichAnswerStream().update(part.source, true);
      const values = richResolvedValues(doc);
      const visit = (id: string): string => {
        const node = doc.nodes.get(id);
        if (!node) return "";
        const md = richMarkdown(node);
        if (md !== null)
          return (
            md +
            (richString(node, "caption")
              ? `\n${richString(node, "caption")}`
              : "")
          );
        if (node.children.length)
          return [richString(node, "label"), ...node.children.map(visit)]
            .filter(Boolean)
            .join("\n\n");
        if (node.kind === "svg")
          return richString(node, "label", richString(node, "alt"));
        if (node.kind === "heading") return `### ${richLabel(node, values)}`;
        if (node.kind === "icon")
          return [richString(node, "label"), richString(node, "text")]
            .filter(Boolean)
            .join("\n");
        if (node.kind === "text") return richLabel(node, values);
        if (node.kind === "divider") return "---";
        if (node.kind === "stat")
          return `${richString(node, "label")}: ${richLabel(node, values)}`;
        if (node.kind === "chart")
          return [
            richString(node, "label"),
            ...richChart(node, values).map(
              (item) => `${item.label}: ${item.value}`,
            ),
          ].join("\n");
        const current = values[richString(node, "bind", node.id)];
        if (node.kind === "check")
          return `${current ? "☑" : "☐"} ${richString(node, "label", richString(node, "text"))}`;
        return (
          richString(node, "label") +
          (current === undefined ? "" : `: ${current}`)
        );
      };
      return doc.roots.map(visit).filter(Boolean).join("\n\n");
    })
    .join("\n\n");
}
/** Collapse redundant operations into a complete replayable tree for bounded history frames. */
export function compactRichAnswer(source: string): string {
  return splitRichAnswer(source)
    .map((part) => {
      if (part.kind === "markdown") return part.source;
      const doc = new RichAnswerStream().update(part.source, true);
      const events: string[] = [];
      const visit = (id: string, parent?: string) => {
        const node = doc.nodes.get(id);
        if (!node) return;
        events.push(
          JSON.stringify({
            version: 1,
            seq: events.length + 1,
            op: "create",
            id,
            kind: node.kind,
            ...(parent ? { parent } : {}),
            props: node.props,
          }),
        );
        node.children.forEach((child) => visit(child, id));
      };
      doc.roots.forEach((id) => visit(id));
      return "```cindy-ui\n" + events.join("\n") + "\n```\n";
    })
    .join("");
}

export function richMediaSource(node: RichNode): string | null {
  const src = richString(node, "src").trim();
  if (!src || /[\r\n]/.test(src)) return null;
  const allowed = /^(https?|file|xdt-(?:file|image|video|audio)|cindy-(?:remote-)?media):\/\//i.exec(src);
  if (
    /^[a-zA-Z][\w+.-]*:/.test(src) &&
    !/^[a-zA-Z]:[\\/]/.test(src) &&
    !allowed
  )
    return null;
  return allowed
    ? allowed[1].toLowerCase() + src.slice(allowed[1].length)
    : src;
}
