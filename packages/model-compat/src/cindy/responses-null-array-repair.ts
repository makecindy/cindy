import { Transform, type TransformCallback } from "node:stream";

/**
 * Repairs Responses output items whose required array fields were serialized as `null`.
 *
 * Some third-party models proxied through a Responses passthrough emit
 * `response.output_item.added` items such as `{ type: 'reasoning', summary: null }` or
 * `{ type: 'message', content: null }`. Codex's `ResponseItem` parser tolerates missing ids and
 * unknown fields but requires these arrays, so the item is dropped and every following
 * `output_text.delta` is discarded as "without active item" (#4251). The wire contract says
 * these fields are arrays, so the only semantics-preserving repair is `null -> []`.
 *
 * Nothing else is touched: item types, ids, call ids and unknown fields pass through byte for
 * byte, and frames that need no repair are re-emitted exactly as received.
 */

interface JsonObject {
  [key: string]: unknown;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Array fields Codex requires per item type. `reasoning.content` is optional and stays as is. */
const REQUIRED_ARRAY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  reasoning: ["summary"],
  message: ["content"],
};

/** Returns the repaired item, or null when the item needs no repair. */
export function repairResponsesItemNullArrays(
  item: unknown,
): JsonObject | null {
  if (!isObject(item) || typeof item.type !== "string") return null;
  const fields = REQUIRED_ARRAY_FIELDS[item.type];
  if (!fields) return null;
  let next: JsonObject | null = null;
  for (const field of fields) {
    if (item[field] !== null) continue;
    next ??= { ...item };
    next[field] = [];
  }
  return next;
}

function repairOutputList(output: unknown): unknown[] | null {
  if (!Array.isArray(output)) return null;
  let changed = false;
  const next = output.map((item) => {
    const repaired = repairResponsesItemNullArrays(item);
    if (!repaired) return item;
    changed = true;
    return repaired;
  });
  return changed ? next : null;
}

/**
 * Returns the repaired Responses SSE event, or null when the event needs no repair.
 *
 * Covers `response.output_item.added` / `response.output_item.done` (`event.item`) and every
 * event carrying a full `response.output` array (`response.completed`, `response.incomplete`,
 * non-streaming bodies wrapped by the caller).
 */
export function repairResponsesEventNullArrays(
  event: unknown,
): JsonObject | null {
  if (!isObject(event) || typeof event.type !== "string") return null;
  if (
    event.type === "response.output_item.added" ||
    event.type === "response.output_item.done"
  ) {
    const item = repairResponsesItemNullArrays(event.item);
    return item ? { ...event, item } : null;
  }
  if (isObject(event.response)) {
    const output = repairOutputList(event.response.output);
    return output
      ? { ...event, response: { ...event.response, output } }
      : null;
  }
  return null;
}

/**
 * A single SSE frame is never larger than a few KiB in practice; a frame that grows past this
 * bound without a delimiter is forwarded verbatim instead of being buffered forever. Failing
 * open here is deliberate: this transform only repairs, it must never turn a working stream
 * into a proxy error.
 */
const MAX_PENDING_FRAME_BYTES = 16 * 1024 * 1024;

/** One SSE event boundary: a line break (LF or CRLF) followed by an empty line. */
const FRAME_BOUNDARY = /\r?\n\r?\n/;

/** SSE frame rewriter; frames that need no repair are re-emitted byte for byte. */
export class ResponsesNullArrayRepairTransform extends Transform {
  private readonly decoder = new TextDecoder();
  private pending = "";

  private rewriteFrame(frame: string, delimiter: string): string {
    const lines = frame.split(/\r?\n/);
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return frame + delimiter;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return frame + delimiter;
    }
    const repaired = repairResponsesEventNullArrays(event);
    if (!repaired) return frame + delimiter;
    const eventLine = lines.find((line) => line.startsWith("event:"));
    return `${eventLine ? `${eventLine}\n` : ""}data: ${JSON.stringify(repaired)}${delimiter}`;
  }

  private drainFrames(): void {
    // SSE ends a line with LF or CRLF and an event with a blank line, so the four
    // boundaries `\n\n`, `\r\n\r\n`, `\n\r\n` and `\r\n\n` are all legal and may be
    // mixed by one upstream (same convention as the proxy's own frame reader).
    // The matched delimiter is re-emitted verbatim.
    for (;;) {
      const match = FRAME_BOUNDARY.exec(this.pending);
      if (!match) return;
      const delimiter = match[0];
      this.push(
        this.rewriteFrame(this.pending.slice(0, match.index), delimiter),
      );
      this.pending = this.pending.slice(match.index + delimiter.length);
    }
  }

  override _transform(
    chunk: Buffer,
    _encoding: string,
    callback: TransformCallback,
  ): void {
    this.pending += this.decoder.decode(chunk, { stream: true });
    this.drainFrames();
    if (Buffer.byteLength(this.pending, "utf8") > MAX_PENDING_FRAME_BYTES) {
      this.push(this.pending);
      this.pending = "";
    }
    callback();
  }

  override _flush(callback: TransformCallback): void {
    this.pending += this.decoder.decode();
    this.drainFrames();
    if (this.pending) this.push(this.rewriteFrame(this.pending, ""));
    this.pending = "";
    callback();
  }
}

/**
 * Builds the repair transform for one upstream response, or null when the body is not a plain
 * (uncompressed) SSE stream. Non-SSE and compressed bodies are left untouched rather than
 * rejected: the repair is best effort and must not change how such responses are delivered.
 */
export function createResponsesNullArrayRepairTransform(response: {
  contentType: string;
  contentEncoding: string;
}): Transform | null {
  const encoding = response.contentEncoding.trim().toLowerCase();
  if (encoding && encoding !== "identity") return null;
  if (
    !response.contentType.trim().toLowerCase().startsWith("text/event-stream")
  )
    return null;
  return new ResponsesNullArrayRepairTransform();
}

/**
 * Chains response transforms into one so a proxy that accepts a single transform can run
 * several. Bytes flow `head -> ... -> tail`; the chained transform ends only after the tail
 * ends, and an error in any stage fails the whole chain. Null stages are skipped.
 */
export function chainResponseTransforms(
  ...stages: Array<Transform | null | undefined>
): Transform | null {
  const present = stages.filter(
    (stage): stage is Transform => stage instanceof Transform,
  );
  if (present.length === 0) return null;
  if (present.length === 1) return present[0]!;
  return new ChainedTransform(present);
}

class ChainedTransform extends Transform {
  private readonly head: Transform;
  private readonly tail: Transform;
  private readonly stages: readonly Transform[];

  constructor(stages: readonly Transform[]) {
    super();
    this.stages = stages;
    this.head = stages[0]!;
    this.tail = stages[stages.length - 1]!;
    for (let index = 0; index < stages.length; index += 1) {
      const stage = stages[index]!;
      stage.on("error", (error: Error) => this.destroy(error));
      const next = stages[index + 1];
      if (next) stage.pipe(next);
    }
    // Readable-side backpressure: when the consumer stops reading, stop pulling
    // from the tail (pipe then throttles every earlier stage) until `_read` runs.
    this.tail.on("data", (chunk: Buffer) => {
      if (!this.push(chunk)) this.tail.pause();
    });
  }

  override _read(size: number): void {
    if (this.tail.isPaused()) this.tail.resume();
    super._read(size);
  }

  override _transform(
    chunk: Buffer,
    _encoding: string,
    callback: TransformCallback,
  ): void {
    if (this.head.write(chunk)) callback();
    else this.head.once("drain", () => callback());
  }

  override _flush(callback: TransformCallback): void {
    this.tail.once("end", () => callback());
    this.head.end();
  }

  override _destroy(
    error: Error | null,
    callback: (error: Error | null) => void,
  ): void {
    for (const stage of this.stages) {
      if (!stage.destroyed) stage.destroy();
    }
    callback(error);
  }
}
