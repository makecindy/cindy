export function parseRangeHeader(
  headerValue: string | null,
  size: number,
):
  | { kind: "range"; start: number; end: number }
  | { kind: "unsatisfiable" }
  | null {
  if (!headerValue) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(headerValue.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return null;
  if (rawStart === "") {
    // suffix range: 最后 N 字节
    const n = parseInt(rawEnd, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (size === 0) return { kind: "unsatisfiable" };
    return { kind: "range", start: Math.max(0, size - n), end: size - 1 };
  }
  const start = parseInt(rawStart, 10);
  const end =
    rawEnd === "" ? size - 1 : Math.min(parseInt(rawEnd, 10), size - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start >= size || start > end) return { kind: "unsatisfiable" };
  return { kind: "range", start, end };
}
