/** Persist only known event names and bounded numbers/enums, never arbitrary log arguments. */
export type DiagnosticEvent = {
  at: number;
  event: string;
  fields: Record<string, number | string>;
};
export const MAX_DIAGNOSTIC_EVENTS = 500;
const names = [
  "app started",
  "app active",
  "app background",
  "app inactive",
  "js stall",
  "js error",
  "recovery phase",
  "getToken failed",
  "createWebSocket failed",
  "relay connection error",
  "device-link inbound frame failed",
  "device-link reliable frame failed",
  "device-link control frame failed",
  "device-link legacy frame failed",
  "device-link online",
  "device-link disconnected",
  "device-link stopped by host",
  "discarding live socket for reconnect",
  "device-link request timeout",
  "network probe timed out",
] as const;
const numericKeys = [
  "generation",
  "connection",
  "peer",
  "operation",
  "elapsedMs",
  "foregroundElapsedMs",
  "wallElapsedMs",
  "lifecycleElapsedMs",
  "count",
];
const phases = ["subscription", "history", "pending", "projection", "goal"];
/** Where a JS error surfaced: a React render (caught by the root boundary) or an uncaught callback. */
export const JS_ERROR_KINDS = ["render", "uncaught"] as const;
/** Error class names only; anything else is recorded as "other". Messages are never kept. */
export const JS_ERROR_NAMES = [
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "EvalError",
  "URIError",
  "AggregateError",
  "Invariant Violation",
  "other",
] as const;
/** Bundle positions of the top stack frames; they need the release's source map to mean anything. */
export const JS_ERROR_FRAME_KEYS = [
  "line1",
  "column1",
  "line2",
  "column2",
  "line3",
  "column3",
] as const;
const outcomes = ["applied", "superseded", "failed"];
function boundedNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1e12
  );
}

export function projectDiagnostic(
  args: readonly unknown[],
  at = Date.now(),
): DiagnosticEvent | null {
  const message = args[0];
  if (
    typeof message !== "string" ||
    message.length > 4096 ||
    !Number.isFinite(at)
  )
    return null;
  const event = names.find(
    (name) =>
      message === name ||
      message.startsWith(`${name} (`) ||
      (name === "device-link request timeout" &&
        message.startsWith(`${name} `)),
  );
  if (!event) return null;
  const fields: DiagnosticEvent["fields"] = {};
  // Do not serialize errors, stack traces, identifiers, endpoints, or even unknown nested fields.
  if (event === "recovery phase" || event === "js stall") {
    const data = args[1];
    if (data && typeof data === "object") {
      const record = data as Record<string, unknown>;
      for (const key of numericKeys)
        if (boundedNumber(record[key])) fields[key] = record[key];
      if (event === "recovery phase") {
        if (typeof record.phase === "string" && phases.includes(record.phase))
          fields.phase = record.phase;
        if (
          typeof record.outcome === "string" &&
          outcomes.includes(record.outcome)
        )
          fields.outcome = record.outcome;
      }
    }
  }
  // A JS error keeps its class name and bundle positions only: the message and the stack text can
  // carry user content, so neither is ever read here.
  if (event === "js error") {
    const data = args[1];
    if (data && typeof data === "object") {
      const record = data as Record<string, unknown>;
      const kind = JS_ERROR_KINDS.find((value) => value === record.kind);
      if (kind) fields.kind = kind;
      const name = JS_ERROR_NAMES.find((value) => value === record.name);
      if (name) fields.name = name;
      for (const key of JS_ERROR_FRAME_KEYS)
        if (boundedNumber(record[key])) fields[key] = record[key];
    }
  }
  // Extract only client-generated timing fields. Never retain the original interpolated message.
  if (event === "device-link online" || event === "network probe timed out") {
    const match = /elapsedMs=(\d+(?:\.\d+)?)/.exec(message);
    if (match && boundedNumber(Number(match[1])))
      fields.elapsedMs = Number(match[1]);
  }
  return { at, event, fields };
}

/** Re-project saved input too: an older/corrupt file must not bypass today's recording boundary. */
export function restoreDiagnosticEvents(value: unknown): DiagnosticEvent[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_DIAGNOSTIC_EVENTS).flatMap((row: unknown) => {
    if (!row || typeof row !== "object") return [];
    const record = row as Record<string, unknown>;
    if (
      typeof record.at !== "number" ||
      !Number.isFinite(record.at) ||
      record.at < 0
    )
      return [];
    const projected = projectDiagnostic(
      [record.event, record.fields],
      record.at,
    );
    if (!projected) return [];
    // The saved timing is separate from its canonical event label.
    if (
      (projected.event === "device-link online" ||
        projected.event === "network probe timed out") &&
      record.fields &&
      typeof record.fields === "object"
    ) {
      const elapsedMs = (record.fields as Record<string, unknown>).elapsedMs;
      if (boundedNumber(elapsedMs)) projected.fields.elapsedMs = elapsedMs;
    }
    return [projected];
  });
}
