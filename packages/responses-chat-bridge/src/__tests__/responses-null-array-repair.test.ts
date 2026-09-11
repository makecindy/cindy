import { PassThrough, Transform } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  chainResponseTransforms,
  createResponsesNullArrayRepairTransform,
  repairResponsesEventNullArrays,
  repairResponsesItemNullArrays,
  ResponsesNullArrayRepairTransform,
} from "../responses-null-array-repair.js";

/** The exact minimal reproduction from #4251: array fields serialized as `null`. */
const REASONING_ADDED_NULL =
  '{"type":"response.output_item.added","output_index":0,"item":{"id":"rs_1","type":"reasoning","status":"in_progress","summary":null}}';
const MESSAGE_ADDED_NULL =
  '{"type":"response.output_item.added","output_index":1,"item":{"id":"msg_2","type":"message","status":"in_progress","role":"assistant","content":null}}';
const TEXT_DELTA =
  '{"type":"response.output_text.delta","item_id":"msg_2","output_index":1,"content_index":0,"delta":"Hello"}';

async function pump(
  transform: Transform,
  chunks: readonly string[],
): Promise<string> {
  const out: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    transform.on("data", (chunk: Buffer) => out.push(chunk));
    transform.on("end", resolve);
    transform.on("error", reject);
  });
  for (const chunk of chunks) transform.write(Buffer.from(chunk, "utf8"));
  transform.end();
  await done;
  return Buffer.concat(out).toString("utf8");
}

describe("repairResponsesItemNullArrays", () => {
  it("replaces null reasoning.summary and message.content with empty arrays", () => {
    expect(
      repairResponsesItemNullArrays({
        type: "reasoning",
        id: "rs_1",
        summary: null,
      }),
    ).toEqual({
      type: "reasoning",
      id: "rs_1",
      summary: [],
    });
    expect(
      repairResponsesItemNullArrays({
        type: "message",
        role: "assistant",
        content: null,
        status: "in_progress",
      }),
    ).toEqual({
      type: "message",
      role: "assistant",
      content: [],
      status: "in_progress",
    });
  });

  it("leaves valid, missing, non-array and unknown-type items untouched", () => {
    expect(
      repairResponsesItemNullArrays({ type: "reasoning", summary: [] }),
    ).toBeNull();
    expect(
      repairResponsesItemNullArrays({ type: "reasoning", id: "rs_1" }),
    ).toBeNull();
    expect(
      repairResponsesItemNullArrays({ type: "reasoning", summary: "text" }),
    ).toBeNull();
    expect(
      repairResponsesItemNullArrays({
        type: "message",
        content: [{ type: "output_text", text: "x" }],
      }),
    ).toBeNull();
    expect(
      repairResponsesItemNullArrays({
        type: "function_call",
        name: "exec",
        arguments: null,
      }),
    ).toBeNull();
    expect(
      repairResponsesItemNullArrays({ type: "web_search_call", action: null }),
    ).toBeNull();
    expect(repairResponsesItemNullArrays(null)).toBeNull();
    expect(repairResponsesItemNullArrays("reasoning")).toBeNull();
  });

  it("does not touch the optional reasoning.content field", () => {
    expect(
      repairResponsesItemNullArrays({
        type: "reasoning",
        summary: [],
        content: null,
      }),
    ).toBeNull();
    expect(
      repairResponsesItemNullArrays({
        type: "reasoning",
        summary: null,
        content: null,
      }),
    ).toEqual({
      type: "reasoning",
      summary: [],
      content: null,
    });
  });
});

describe("repairResponsesEventNullArrays", () => {
  it("repairs output_item.added and output_item.done items", () => {
    const added = JSON.parse(REASONING_ADDED_NULL) as Record<string, unknown>;
    expect(repairResponsesEventNullArrays(added)).toEqual({
      ...added,
      item: { ...(added.item as object), summary: [] },
    });
    const done = {
      type: "response.output_item.done",
      output_index: 1,
      item: { type: "message", content: null },
    };
    expect(repairResponsesEventNullArrays(done)).toEqual({
      ...done,
      item: { type: "message", content: [] },
    });
  });

  it("repairs items inside response.output on completed events only when needed", () => {
    const completed = {
      type: "response.completed",
      response: {
        id: "resp_1",
        output: [
          { type: "reasoning", summary: null },
          {
            type: "function_call",
            call_id: "c1",
            name: "exec",
            arguments: "{}",
          },
          { type: "message", content: null },
        ],
        usage: { input_tokens: 1 },
      },
    };
    expect(repairResponsesEventNullArrays(completed)).toEqual({
      ...completed,
      response: {
        ...completed.response,
        output: [
          { type: "reasoning", summary: [] },
          {
            type: "function_call",
            call_id: "c1",
            name: "exec",
            arguments: "{}",
          },
          { type: "message", content: [] },
        ],
      },
    });
    expect(
      repairResponsesEventNullArrays({
        type: "response.completed",
        response: { output: [{ type: "message", content: [] }] },
      }),
    ).toBeNull();
    expect(
      repairResponsesEventNullArrays({
        type: "response.completed",
        response: { output: null },
      }),
    ).toBeNull();
  });

  it("ignores delta events, unknown shapes and non-objects", () => {
    expect(repairResponsesEventNullArrays(JSON.parse(TEXT_DELTA))).toBeNull();
    expect(
      repairResponsesEventNullArrays({
        type: "response.output_item.added",
        item: null,
      }),
    ).toBeNull();
    expect(
      repairResponsesEventNullArrays({
        item: { type: "message", content: null },
      }),
    ).toBeNull();
    expect(repairResponsesEventNullArrays("x")).toBeNull();
  });
});

describe("ResponsesNullArrayRepairTransform", () => {
  it("repairs the #4251 stream so every item carries an array", async () => {
    const input = `data: ${REASONING_ADDED_NULL}\n\ndata: ${MESSAGE_ADDED_NULL}\n\ndata: ${TEXT_DELTA}\n\ndata: [DONE]\n\n`;
    const output = await pump(new ResponsesNullArrayRepairTransform(), [input]);
    const frames = output.split("\n\n").filter(Boolean);
    expect(frames).toHaveLength(4);
    const added = frames.slice(0, 2).map(
      (frame) =>
        JSON.parse(frame.slice("data: ".length)) as {
          item: Record<string, unknown>;
        },
    );
    expect(added[0]!.item).toEqual({
      id: "rs_1",
      type: "reasoning",
      status: "in_progress",
      summary: [],
    });
    expect(added[1]!.item).toEqual({
      id: "msg_2",
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: [],
    });
    expect(frames[2]).toBe(`data: ${TEXT_DELTA}`);
    expect(frames[3]).toBe("data: [DONE]");
  });

  it("re-emits streams that need no repair byte for byte, including CRLF framing and comments", async () => {
    const valid = REASONING_ADDED_NULL.replace(
      '"summary":null',
      '"summary":[]',
    );
    const input = `: keepalive\r\n\r\nevent: response.output_item.added\r\ndata: ${valid}\r\n\r\ndata: ${TEXT_DELTA}\r\n\r\nnot-json\r\n\r\ndata: [DONE]\r\n\r\n`;
    expect(await pump(new ResponsesNullArrayRepairTransform(), [input])).toBe(
      input,
    );
  });

  it("keeps the event line and CRLF delimiter when rewriting a named frame", async () => {
    const input = `event: response.output_item.added\r\ndata: ${MESSAGE_ADDED_NULL}\r\n\r\n`;
    const output = await pump(new ResponsesNullArrayRepairTransform(), [input]);
    expect(output.startsWith("event: response.output_item.added\ndata: ")).toBe(
      true,
    );
    expect(output.endsWith("\r\n\r\n")).toBe(true);
    expect(
      (
        JSON.parse(output.split("\ndata: ")[1]!.trim()) as {
          item: { content: unknown };
        }
      ).item.content,
    ).toEqual([]);
  });

  it("handles frames and multi-byte characters split across chunks", async () => {
    const message = MESSAGE_ADDED_NULL.replace(
      '"status":"in_progress"',
      '"status":"进行中"',
    );
    const whole = `data: ${message}\n\ndata: ${TEXT_DELTA}\n\n`;
    const bytes = Buffer.from(whole, "utf8");
    const cut = whole.indexOf("进") + 1; // inside the multi-byte character
    const chunks = [
      bytes.subarray(0, cut),
      bytes.subarray(cut, cut + 40),
      bytes.subarray(cut + 40),
    ];
    const transform = new ResponsesNullArrayRepairTransform();
    const out: Buffer[] = [];
    const ended = new Promise<void>((resolve) => transform.on("end", resolve));
    transform.on("data", (chunk: Buffer) => out.push(chunk));
    for (const chunk of chunks) transform.write(chunk);
    transform.end();
    await ended;
    const frames = Buffer.concat(out)
      .toString("utf8")
      .split("\n\n")
      .filter(Boolean);
    expect(
      (
        JSON.parse(frames[0]!.slice(6)) as {
          item: { status: string; content: unknown };
        }
      ).item,
    ).toMatchObject({
      status: "进行中",
      content: [],
    });
    expect(frames[1]).toBe(`data: ${TEXT_DELTA}`);
  });

  it("splits frames on every legal SSE boundary, including mixed LF/CRLF, and keeps each delimiter", async () => {
    const input = `data: ${REASONING_ADDED_NULL}\n\r\ndata: ${MESSAGE_ADDED_NULL}\r\n\ndata: ${TEXT_DELTA}\r\n\r\ndata: [DONE]\n\n`;
    const output = await pump(new ResponsesNullArrayRepairTransform(), [input]);
    const frames = output.split(/\r?\n\r?\n/).filter(Boolean);
    expect(frames).toHaveLength(4);
    expect(
      (JSON.parse(frames[0]!.slice(6)) as { item: { summary: unknown } }).item
        .summary,
    ).toEqual([]);
    expect(
      (JSON.parse(frames[1]!.slice(6)) as { item: { content: unknown } }).item
        .content,
    ).toEqual([]);
    expect(frames[2]).toBe(`data: ${TEXT_DELTA}`);
    expect(frames[3]).toBe("data: [DONE]");
    expect(output.match(/\r?\n\r?\n/g)).toEqual([
      "\n\r\n",
      "\r\n\n",
      "\r\n\r\n",
      "\n\n",
    ]);
  });

  it("re-emits a mixed-newline stream byte for byte when nothing needs repair", async () => {
    const input = `data: ${TEXT_DELTA}\n\r\n: ping\r\n\ndata: ${TEXT_DELTA}\r\n\r\ndata: [DONE]\n\n`;
    expect(await pump(new ResponsesNullArrayRepairTransform(), [input])).toBe(
      input,
    );
  });

  it("does not treat a CR split across chunks as a boundary too early", async () => {
    const whole = `data: ${MESSAGE_ADDED_NULL}\r\n\r\ndata: ${TEXT_DELTA}\n\n`;
    const cut = whole.indexOf("\r\n\r\n") + 3; // pending ends with "\r\n\r"
    const output = await pump(new ResponsesNullArrayRepairTransform(), [
      whole.slice(0, cut),
      whole.slice(cut),
    ]);
    const frames = output.split(/\r?\n\r?\n/).filter(Boolean);
    expect(frames).toHaveLength(2);
    expect(
      (JSON.parse(frames[0]!.slice(6)) as { item: { content: unknown } }).item
        .content,
    ).toEqual([]);
    expect(frames[1]).toBe(`data: ${TEXT_DELTA}`);
  });

  it("repairs a trailing frame without a delimiter at end of stream", async () => {
    const output = await pump(new ResponsesNullArrayRepairTransform(), [
      `data: ${REASONING_ADDED_NULL}`,
    ]);
    expect(
      (JSON.parse(output.slice(6)) as { item: { summary: unknown } }).item
        .summary,
    ).toEqual([]);
    expect(output.endsWith("\n")).toBe(false);
  });
});

describe("createResponsesNullArrayRepairTransform", () => {
  it("only wraps uncompressed SSE responses", () => {
    expect(
      createResponsesNullArrayRepairTransform({
        contentType: "text/event-stream; charset=utf-8",
        contentEncoding: "",
      }),
    ).toBeInstanceOf(ResponsesNullArrayRepairTransform);
    expect(
      createResponsesNullArrayRepairTransform({
        contentType: "Text/Event-Stream",
        contentEncoding: "identity",
      }),
    ).toBeInstanceOf(ResponsesNullArrayRepairTransform);
    expect(
      createResponsesNullArrayRepairTransform({
        contentType: "application/json",
        contentEncoding: "",
      }),
    ).toBeNull();
    expect(
      createResponsesNullArrayRepairTransform({
        contentType: "text/event-stream",
        contentEncoding: "gzip",
      }),
    ).toBeNull();
    expect(
      createResponsesNullArrayRepairTransform({
        contentType: "",
        contentEncoding: "",
      }),
    ).toBeNull();
  });
});

describe("chainResponseTransforms", () => {
  const upper = () =>
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        callback(
          null,
          Buffer.from(chunk.toString("utf8").toUpperCase(), "utf8"),
        );
      },
    });
  const suffix = (text: string) =>
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        callback(null, chunk);
      },
      flush(callback) {
        callback(null, Buffer.from(text, "utf8"));
      },
    });

  it("returns null for no stages and the stage itself for a single stage", () => {
    expect(chainResponseTransforms()).toBeNull();
    expect(chainResponseTransforms(null, undefined)).toBeNull();
    const only = upper();
    expect(chainResponseTransforms(null, only)).toBe(only);
  });

  it("runs stages in order and ends after the last stage flushes", async () => {
    const chained = chainResponseTransforms(upper(), null, suffix("!"));
    expect(chained).not.toBeNull();
    expect(await pump(chained!, ["ab", "c"])).toBe("ABC!");
  });

  it("feeds repaired frames into a downstream stage", async () => {
    const seen: string[] = [];
    const observer = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        seen.push(chunk.toString("utf8"));
        callback(null, chunk);
      },
    });
    const chained = chainResponseTransforms(
      new ResponsesNullArrayRepairTransform(),
      observer,
    )!;
    await pump(chained, [`data: ${MESSAGE_ADDED_NULL}\n\n`]);
    expect(seen.join("")).toContain('"content":[]');
  });

  it("pauses the inner stages while the consumer is not reading and resumes on demand", async () => {
    const tail = new PassThrough();
    const chained = chainResponseTransforms(new PassThrough(), tail)!;
    const chunk = Buffer.alloc(8 * 1024, 0x61);
    // Write far more than the readable high-water mark with nobody consuming.
    for (let index = 0; index < 32; index += 1) chained.write(chunk);
    await new Promise((resolve) => setImmediate(resolve));
    expect(tail.isPaused()).toBe(true);
    expect(chained.readableLength).toBeLessThanOrEqual(
      chained.readableHighWaterMark + chunk.length,
    );
    // Consuming drains the outer buffer, resumes the tail and lets the rest through.
    let received = 0;
    const ended = new Promise<void>((resolve) => chained.on("end", resolve));
    chained.on("data", (data: Buffer) => {
      received += data.length;
    });
    chained.end();
    await ended;
    expect(received).toBe(32 * chunk.length);
    expect(tail.isPaused()).toBe(false);
  });

  it("fails the chain when any stage errors", async () => {
    const failing = new Transform({
      transform(_chunk, _encoding, callback) {
        callback(new Error("stage failed"));
      },
    });
    const chained = chainResponseTransforms(new PassThrough(), failing)!;
    const errored = new Promise<Error>((resolve) =>
      chained.on("error", resolve),
    );
    chained.write("x");
    expect((await errored).message).toBe("stage failed");
  });
});
