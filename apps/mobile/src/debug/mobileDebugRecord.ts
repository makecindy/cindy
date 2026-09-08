import type { MobileDebugLevel, MobileDebugScope } from "./mobileDebugLog";

// Defense in depth for explicitly instrumented local events, not a license to capture arbitrary console.
const privateKey =
  /authorization|cookie|password|secret|token|api.?key|credential|^(body|payload|prompt|messages?|content|text|transcript|headers|args|input|output|data)$/i;
const MAX_STRING = 4000;
export function redactMobileDebugText(value: string): string {
  // Header values can span quoted fields, separators and folded lines. Never guess their end.
  if (
    /\b(?:[\w-]*authorization|[\w-]*cookie)["']?\s*[:=]/i.test(
      value.slice(0, MAX_STRING).replace(/\\+["']/g, '"'),
    )
  )
    return "[redacted credential header]";
  // Escaped JSON may contain quoted delimiters inside the secret itself. Drop that text
  // rather than partially matching a value and leaking its suffix (also handles nested encoding).
  if (
    /\\+["']/.test(value.slice(0, MAX_STRING)) &&
    /\b[\w-]{0,40}(?:token|password|secret|api[-_]?key|authorization|cookie)[\w-]{0,40}["']?\s*[:=]/i.test(
      value.slice(0, MAX_STRING).replace(/\\+["']/g, '"'),
    )
  )
    return "[redacted escaped credential]";
  return value
    .slice(0, MAX_STRING)
    .replace(/\b(Bearer|Basic)\s+[^\s,;'"}]+/gi, "$1 [redacted]")
    .replace(
      /(\b[\w-]{0,40}(?:token|password|secret|api[-_]?key|authorization|cookie)[\w-]{0,40}["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi,
      "$1[redacted]",
    )
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_)[a-zA-Z0-9_-]{8,}/g, "[redacted]")
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[redacted]",
    )
    .replace(/(?:https?|wss?):\/\/[^\s<>"')]+/gi, (url) => {
      try {
        const parsed = new URL(url);
        return `${parsed.protocol}//${parsed.host}/[redacted-path]`;
      } catch {
        return "[redacted-url]";
      }
    })
    .replace(/\b[\w.+-]{1,128}@[\w.-]{1,128}\.[a-z]{2,}/gi, "[redacted-email]")
    .replace(/(?:\/Users\/|\/home\/)[^\s/]+/g, "/[home]")
    .slice(0, MAX_STRING);
}

/** Keep error causes/stacks, enums and timings; no arbitrary getters/toJSON (Error.stack may be lazy). */
export function serializeMobileDebugRecord(
  level: MobileDebugLevel,
  scope: MobileDebugScope,
  args: unknown[],
  at = Date.now(),
): string {
  const seen = new WeakSet<object>();
  let remaining = 120;
  function safe(value: unknown, depth = 0): unknown {
    if (--remaining < 0 || depth > 5) return "[truncated]";
    if (typeof value === "string") return redactMobileDebugText(value);
    if (typeof value === "number")
      return Number.isFinite(value) ? value : String(value);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "function") return "[function]";
    if (typeof value !== "object") return String(value);
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    if (Array.isArray(value))
      return value.slice(0, 30).map((item) => safe(item, depth + 1));
    const out: Record<string, unknown> = Object.create(null);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      value instanceof Error &&
      descriptors.stack &&
      !("value" in descriptors.stack)
    ) {
      try {
        out.stack = safe(value.stack, depth + 1);
      } catch {
        out.stack = "[unavailable]";
      }
    }
    for (const [key, descriptor] of Object.entries(descriptors).slice(0, 40)) {
      if (key === "stack" && "stack" in out) continue;
      out[redactMobileDebugText(key)] =
        privateKey.test(key) && !(value instanceof Error && key === "message")
          ? "[redacted]"
          : "value" in descriptor
            ? safe(descriptor.value, depth + 1)
            : "[accessor]";
    }
    if (value instanceof Error && !("name" in out)) out.name = "Error";
    return out;
  }
  const record = {
    at,
    level,
    scope,
    args: args.slice(0, 12).map((arg) => safe(arg)),
  };
  const json = JSON.stringify(record);
  // Preserve valid NDJSON even when one error object is unusually large.
  return (
    (json.length <= 16_000
      ? json
      : JSON.stringify({
          at,
          level,
          scope,
          args: [
            typeof args[0] === "string"
              ? redactMobileDebugText(args[0])
              : "[record]",
            "[record truncated]",
          ],
        })) + "\n"
  );
}
