import { Buffer } from "node:buffer";
import type { Transform } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createResponsesCustomToolFunctionAdapter, normalizeResponsesToolItemIds } from "../custom-tool-function-adapter.js";

async function collect(transform: Transform, body: string): Promise<string> {
  const chunks: Buffer[] = [];
  transform.on("data", (chunk: Buffer) => chunks.push(chunk));
  const completed = new Promise<void>((resolve, reject) => {
    transform.once("end", resolve);
    transform.once("error", reject);
  });
  transform.end(body);
  await completed;
  return Buffer.concat(chunks).toString("utf8");
}

function execRequest() {
  return {
    model: "stealth/ox-alpha",
    tools: [
      {
        type: "custom",
        name: "exec",
        description: "Run Code Mode JavaScript.",
      },
    ],
    input: [],
  };
}

describe("legacy Responses tool item ids", () => {
  it("repairs tool-less compact history without changing invocation ids, payloads or opaque items", () => {
    const body = { model: "gpt-6", input: [
      { type: "custom_tool_call", id: "fc_old", call_id: "fc_invocation", name: "exec", input: "fc_literal" },
      { type: "custom_tool_call_output", id: "fco_old", call_id: "fc_invocation", output: [{ type: "input_text", text: "fc_literal" }] },
      { type: "function_call", id: "ctc_old2", call_id: "ctc_invocation", arguments: "{}" },
      { type: "function_call_output", id: "ctco_old2", call_id: "ctc_invocation", output: "ok" },
      { type: "item_reference", id: "fc_old" },
      { type: "compaction", id: "fc_opaque", encrypted_content: "unchanged" },
      { type: "message", id: "fc_message", content: "unchanged" },
      { type: "custom_tool_call", id: "opaque_provider", call_id: "opaque" },
      { type: "custom_tool_call", call_id: "legacy" },
      { type: "function_call", id: "fc_valid", call_id: "valid" },
    ] };
    const original = structuredClone(body);
    const repaired = normalizeResponsesToolItemIds(body)!;
    const items = repaired.input as typeof body.input;
    expect(items.map(item => item.id)).toEqual([
      "ctc_old", "ctco_old", "fc_old2", "fco_old2", "fc_old", "fc_opaque", "fc_message",
      "opaque_provider", undefined, "fc_valid",
    ]);
    expect(items[0]).toEqual({ ...body.input[0], id: "ctc_old" });
    expect(items[1]).toEqual({ ...body.input[1], id: "ctco_old" });
    expect(items[1]!.output).toBe(body.input[1]!.output);
    expect(body).toEqual(original);
    expect(normalizeResponsesToolItemIds(repaired)).toBeNull();
    expect(normalizeResponsesToolItemIds({ input: "hello" })).toBeNull();
  });
});

describe("Responses custom-tool function adapter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([false, true])("keeps response ids consistent across parallel calls and final output (SSE=%s)", async (sse) => {
    const adapter = createResponsesCustomToolFunctionAdapter(["exec"]);
    adapter.adaptRequest(execRequest(), 1);
    const calls = ["a", "b"].map(key => ({
      type: "function_call", id: `fc_${key}`, call_id: `call_${key}`, name: "exec",
      arguments: JSON.stringify({ input: `text("你好 ${key}")` }),
    }));
    const unrelated = { type: "function_call", id: "fc_other", call_id: "call_other", name: "read_file", arguments: "{}" };
    const final = { type: "response.completed", response: { output: [...calls, unrelated] } };
    const events = [
      ...calls.map((item, output_index) => ({ type: "response.output_item.added", output_index, item: { ...item, arguments: "" } })),
      { type: "response.output_item.added", output_index: 2, item: unrelated },
      { type: "response.function_call_arguments.done", output_index: 2, item_id: unrelated.id, arguments: "{}" },
      ...[1, 0].flatMap(output_index => {
        const item = calls[output_index]!;
        return [
          { type: "response.function_call_arguments.delta", output_index, item_id: item.id, delta: item.arguments },
          { type: "response.function_call_arguments.done", output_index, item_id: item.id, arguments: item.arguments },
          { type: "response.output_item.done", output_index, item },
        ];
      }),
      final,
    ];
    const transform = adapter.createResponseTransform(1, { contentType: sse ? "text/event-stream" : "application/json", contentEncoding: "" })!;
    const body = sse ? events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("") : JSON.stringify(final.response);
    const chunks: Buffer[] = [];
    transform.on("data", chunk => chunks.push(Buffer.from(chunk)));
    const completed = new Promise<void>((resolve, reject) => { transform.on("end", resolve); transform.on("error", reject); });
    // Exercise split framing and multi-byte text while two calls are in flight.
    const bytes = Buffer.from(body);
    for (let offset = 0; offset < bytes.length; offset += 7) transform.write(bytes.subarray(offset, offset + 7));
    transform.end();
    await completed;
    const output = Buffer.concat(chunks).toString("utf8");
    const rewritten = sse ? output.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))) : [];
    const response = sse ? rewritten.at(-1).response : JSON.parse(output);
    expect(response.output).toEqual([
      ...calls.map((call, index) => ({ type: "custom_tool_call", id: index ? "ctc_b" : "ctc_a", call_id: call.call_id, name: "exec", input: JSON.parse(call.arguments).input })),
      unrelated,
    ]);
    if (sse) {
      expect(rewritten.filter(event => event.type === "response.custom_tool_call_input.done").map(event => event.item_id)).toEqual(["ctc_b", "ctc_a"]);
      for (const event of rewritten) {
        if (event.output_index === 0 || event.output_index === 1) {
          const expected = event.output_index === 0 ? "ctc_a" : "ctc_b";
          if (event.item) expect(event.item.id).toBe(expected);
          if (event.item_id) expect(event.item_id).toBe(expected);
        }
      }
      expect(rewritten).toContainEqual(events[3]);
    }
    const compactBody = { model: "gpt-6", input: response.output };
    expect(normalizeResponsesToolItemIds(compactBody)).toBeNull();
    const adapted = adapter.adaptRequest({ ...execRequest(), input: response.output }, 2) as { input: Array<{ id: string; call_id: string }> };
    expect(adapted.input.map(item => item.id)).toEqual(["fc_a", "fc_b", "fc_other"]);
    expect(adapted.input.map(item => item.call_id)).toEqual(["call_a", "call_b", "call_other"]);
  });

  it("flips dialect-coupled item id prefixes and drops ids in neither dialect", () => {
    const adapter = createResponsesCustomToolFunctionAdapter(["exec"]);
    const adapted = adapter.adaptRequest(
      {
        ...execRequest(),
        input: [
          // Both ids minted by Codex: the rollout was produced against a custom-tool upstream.
          { type: "custom_tool_call", id: "ctc_01", call_id: "a", name: "exec", input: "1" },
          { type: "custom_tool_call_output", id: "ctco_01", call_id: "a", output: "ok" },
          // The steady state on a function-only upstream: it minted the call id, Codex the output id.
          { type: "custom_tool_call", id: "fc_upstream", call_id: "b", name: "exec", input: "2" },
          { type: "custom_tool_call_output", id: "ctco_02", call_id: "b", output: "ok" },
          // Neither dialect: an upstream scheme we cannot vouch for, and a future Codex prefix.
          { type: "custom_tool_call", id: "weird_xyz", call_id: "c", name: "exec", input: "3" },
          { type: "custom_tool_call_output", id: "lsh_future", call_id: "c", output: "ok" },
        ],
      },
      1,
    ) as Record<string, unknown>;

    const input = adapted.input as Array<Record<string, unknown>>;
    expect(input.map((item) => [item.type, item.id])).toEqual([
      ["function_call", "fc_01"],
      ["function_call_output", "fco_01"],
      ["function_call", "fc_upstream"],
      ["function_call_output", "fco_02"],
      ["function_call", undefined],
      ["function_call_output", undefined],
    ]);
    expect(input[4]).not.toHaveProperty("id");
    expect(input[5]).not.toHaveProperty("id");
    expect(input[1]).toMatchObject({ call_id: "a", output: "ok" });
  });

  it("keeps Codex 0.145 replay items without ids compatible with the function dialect", () => {
    const adapter = createResponsesCustomToolFunctionAdapter(["exec"]);
    const adapted = adapter.adaptRequest(
      {
        ...execRequest(),
        input: [
          { type: "custom_tool_call", call_id: "legacy-call", name: "exec", input: "1" },
          { type: "custom_tool_call_output", call_id: "legacy-call", output: "ok" },
        ],
      },
      1,
    ) as Record<string, unknown>;

    expect(adapted.input).toEqual([
      {
        type: "function_call",
        call_id: "legacy-call",
        name: "exec",
        arguments: JSON.stringify({ input: "1" }),
      },
      { type: "function_call_output", call_id: "legacy-call", output: "ok" },
    ]);
  });

  it("rewrites only the id of a real Code Mode output payload", () => {
    const adapter = createResponsesCustomToolFunctionAdapter(["exec"]);
    // Captured verbatim from codex 0.152.1 with `[features.code_mode] enabled = true`. Code Mode
    // outputs are content blocks rather than a string, so the exhaustive toEqual below is the
    // assertion that the dialect flip forwards the payload untouched.
    const output = [
      { type: "input_text", text: "Script failed\nWall time 0.0 seconds\nOutput:\n" },
      { type: "input_text", text: "Script error:\nSyntaxError: Unexpected identifier 'hi'" },
    ];
    const adapted = adapter.adaptRequest(
      {
        ...execRequest(),
        input: [
          {
            type: "custom_tool_call",
            id: "ctc_mockupstream1",
            call_id: "call_mock1",
            name: "exec",
            input: "echo hi",
          },
          {
            type: "custom_tool_call_output",
            id: "ctco_01a05fbd-4e2a-7c93-9931-1591666b42bb",
            call_id: "call_mock1",
            output,
          },
        ],
      },
      1,
    ) as Record<string, unknown>;

    const input = adapted.input as Array<Record<string, unknown>>;
    expect(input[1]).toEqual({
      type: "function_call_output",
      id: "fco_01a05fbd-4e2a-7c93-9931-1591666b42bb",
      call_id: "call_mock1",
      output,
    });
    expect(input[0]).toMatchObject({
      type: "function_call",
      id: "fc_mockupstream1",
      call_id: "call_mock1",
    });
  });

  it("round-trips collision-safe names, tool choice, history, and parallel SSE calls", async () => {
    const adapter = createResponsesCustomToolFunctionAdapter(["exec"]);
    const adapted = adapter.adaptRequest(
      {
        model: "stealth/ox-alpha",
        parallel_tool_calls: true,
        tools: [
          {
            type: "function",
            name: "exec",
            description: "An unrelated function.",
            parameters: { type: "object" },
          },
          {
            type: "custom",
            name: "exec",
            description: "Run Code Mode JavaScript.",
          },
          {
            type: "function",
            name: "read_file",
            parameters: { type: "object" },
          },
        ],
        tool_choice: { type: "custom", name: "exec" },
        input: [
          {
            type: "custom_tool_call",
            call_id: "old-call",
            name: "exec",
            input: 'text("old")',
          },
          {
            type: "custom_tool_call_output",
            call_id: "old-call",
            output: "old result",
          },
        ],
      },
      1,
    ) as Record<string, unknown>;

    const tools = adapted.tools as Array<Record<string, unknown>>;
    const execFunction = tools.find((tool) => {
      const parameters = tool.parameters as { required?: string[] } | undefined;
      return (
        tool.type === "function" && parameters?.required?.includes("input")
      );
    });
    expect(execFunction?.name).toEqual(expect.stringMatching(/^exec__/));
    expect(tools).toContainEqual(
      expect.objectContaining({ type: "function", name: "exec" }),
    );
    expect(tools).toContainEqual(
      expect.objectContaining({ type: "function", name: "read_file" }),
    );
    expect(adapted.parallel_tool_calls).toBe(true);
    expect(adapted.tool_choice).toEqual({
      type: "function",
      name: execFunction?.name,
    });
    expect(adapted.input).toEqual([
      expect.objectContaining({
        type: "function_call",
        call_id: "old-call",
        name: execFunction?.name,
        arguments: '{"input":"text(\\"old\\")"}',
      }),
      {
        type: "function_call_output",
        call_id: "old-call",
        output: "old result",
      },
    ]);

    const responseTransform = adapter.createResponseTransform(1, {
      contentType: "text/event-stream; charset=utf-8",
      contentEncoding: "",
    });
    expect(responseTransform).not.toBeNull();
    const functionName = execFunction?.name as string;
    const output = await collect(
      responseTransform!,
      [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            name: functionName,
            call_id: "call-1",
            arguments: "",
          },
        },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: {
            type: "function_call",
            name: functionName,
            call_id: "call-2",
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 1,
          delta: '{"input":"text(\\"two\\")"}',
        },
        {
          type: "response.function_call_arguments.done",
          output_index: 1,
          arguments: '{"input":"text(\\"two\\")"}',
        },
        {
          type: "response.output_item.done",
          output_index: 1,
          item: {
            type: "function_call",
            name: functionName,
            call_id: "call-2",
            arguments: '{"input":"text(\\"two\\")"}',
          },
        },
        {
          type: "response.function_call_arguments.done",
          output_index: 0,
          arguments: '{"input":"text(\\"one\\")"}',
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "function_call",
            name: functionName,
            call_id: "call-1",
            arguments: '{"input":"text(\\"one\\")"}',
          },
        },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
    );
    const events = output
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);

    expect(
      events.filter((event) => event.type === "response.output_item.done"),
    ).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({
          type: "custom_tool_call",
          name: "exec",
          call_id: "call-2",
          input: 'text("two")',
        }),
      }),
      expect.objectContaining({
        item: expect.objectContaining({
          type: "custom_tool_call",
          name: "exec",
          call_id: "call-1",
          input: 'text("one")',
        }),
      }),
    ]);
  });

  it("keeps namespaced same-name custom tool history untouched", () => {
    const adapter = createResponsesCustomToolFunctionAdapter(["exec"]);
    const namespacedHistory = [
      {
        type: "custom_tool_call",
        call_id: "plugin-exec-call",
        namespace: "plugin",
        name: "exec",
        input: "plugin input",
      },
      {
        type: "custom_tool_call_output",
        call_id: "plugin-exec-call",
        output: "plugin output",
      },
    ];

    const adapted = adapter.adaptRequest(
      {
        ...execRequest(),
        tools: [
          ...execRequest().tools,
          {
            type: "namespace",
            name: "plugin",
            tools: [{ type: "custom", name: "exec" }],
          },
        ],
        input: namespacedHistory,
      },
      7,
    ) as Record<string, unknown>;

    expect(adapted.input).toEqual(namespacedHistory);
  });

  it("restores adapted function calls in a JSON response", async () => {
    const adapter = createResponsesCustomToolFunctionAdapter(["exec"]);
    const adapted = adapter.adaptRequest(execRequest(), 2) as {
      tools: Array<{ name: string }>;
    };
    const functionName = adapted.tools[0]!.name;
    const responseTransform = adapter.createResponseTransform(2, {
      contentType: "application/json",
      contentEncoding: "identity",
    });

    const output = await collect(
      responseTransform!,
      JSON.stringify({
        id: "response-1",
        output: [
          {
            type: "function_call",
            name: functionName,
            call_id: "call-json",
            arguments: '{"input":"text(\\"json\\")"}',
          },
        ],
      }),
    );
    expect(JSON.parse(output)).toMatchObject({
      output: [
        {
          type: "custom_tool_call",
          name: "exec",
          call_id: "call-json",
          input: 'text("json")',
        },
      ],
    });
  });

  it("fails explicitly instead of discarding live request mappings at the capacity limit", () => {
    const adapter = createResponsesCustomToolFunctionAdapter(["exec"]);
    for (let requestId = 1; requestId <= 256; requestId += 1) {
      expect(adapter.adaptRequest(execRequest(), requestId)).not.toBeNull();
    }

    expect(() => adapter.adaptRequest(execRequest(), 257)).toThrow(
      /too many in-flight custom tool requests/i,
    );
    expect(
      adapter.createResponseTransform(1, {
        contentType: "text/event-stream",
        contentEncoding: "",
      }),
    ).not.toBeNull();
    expect(
      adapter.createResponseTransform(256, {
        contentType: "application/json",
        contentEncoding: "",
      }),
    ).not.toBeNull();
  });

  it("releases settled request mappings before the timeout", () => {
    const adapter = createResponsesCustomToolFunctionAdapter(["exec"]);
    for (let requestId = 1; requestId <= 256; requestId += 1) {
      expect(adapter.adaptRequest(execRequest(), requestId)).not.toBeNull();
      adapter.releaseResponse(requestId);
    }

    expect(adapter.adaptRequest(execRequest(), 257)).not.toBeNull();
    expect(
      adapter.createResponseTransform(257, {
        contentType: "application/json",
        contentEncoding: "",
      }),
    ).not.toBeNull();
  });

  it("bounds incomplete parallel response calls", async () => {
    const adapter = createResponsesCustomToolFunctionAdapter(["exec"]);
    const adapted = adapter.adaptRequest(execRequest(), 5) as {
      tools: Array<{ name: string }>;
    };
    const functionName = adapted.tools[0]!.name;
    const responseTransform = adapter.createResponseTransform(5, {
      contentType: "text/event-stream",
      contentEncoding: "",
    });
    const frames = Array.from({ length: 257 }, (_, outputIndex) => (
      `data: ${JSON.stringify({
        type: "response.output_item.added",
        output_index: outputIndex,
        item: {
          type: "function_call",
          name: functionName,
          call_id: `call-${outputIndex}`,
          arguments: "",
        },
      })}\n\n`
    )).join("");

    await expect(collect(responseTransform!, frames)).rejects.toThrow(
      /too many active calls/i,
    );
  });

  it("bounds accumulated response call arguments", async () => {
    const adapter = createResponsesCustomToolFunctionAdapter(["exec"]);
    const adapted = adapter.adaptRequest(execRequest(), 6) as {
      tools: Array<{ name: string }>;
    };
    const functionName = adapted.tools[0]!.name;
    const responseTransform = adapter.createResponseTransform(6, {
      contentType: "text/event-stream",
      contentEncoding: "",
    });
    const frames = [
      `data: ${JSON.stringify({
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          name: functionName,
          call_id: "call-0",
          arguments: "",
        },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: "x".repeat(16 * 1024 * 1024 + 1),
      })}\n\n`,
    ].join("");

    await expect(collect(responseTransform!, frames)).rejects.toThrow(
      /arguments exceed the 16 MiB limit/i,
    );
  });

  it("keeps live mappings beyond five minutes instead of expiring them by wall clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T00:00:00Z"));
    const adapter = createResponsesCustomToolFunctionAdapter(["exec"]);
    for (let requestId = 1; requestId <= 255; requestId += 1) {
      adapter.adaptRequest(execRequest(), requestId);
    }

    vi.advanceTimersByTime(6 * 60 * 1000);
    adapter.adaptRequest(execRequest(), 256);

    expect(
      adapter.createResponseTransform(1, {
        contentType: "application/json",
        contentEncoding: "",
      }),
    ).not.toBeNull();
    expect(
      adapter.createResponseTransform(256, {
        contentType: "application/json",
        contentEncoding: "",
      }),
    ).not.toBeNull();
  });

  it("reclaims mappings only after the proxy socket timeout has elapsed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T00:00:00Z"));
    const adapter = createResponsesCustomToolFunctionAdapter(["exec"]);
    for (let requestId = 1; requestId <= 255; requestId += 1) {
      adapter.adaptRequest(execRequest(), requestId);
    }

    vi.advanceTimersByTime(16 * 60 * 1000);
    adapter.adaptRequest(execRequest(), 256);
    for (let requestId = 257; requestId <= 511; requestId += 1) {
      adapter.adaptRequest(execRequest(), requestId);
    }

    expect(
      adapter.createResponseTransform(1, {
        contentType: "application/json",
        contentEncoding: "",
      }),
    ).toBeNull();
    expect(
      adapter.createResponseTransform(256, {
        contentType: "application/json",
        contentEncoding: "",
      }),
    ).not.toBeNull();
  });

  it("rejects compressed or unknown response formats rather than translating unsafely", () => {
    const compressed = createResponsesCustomToolFunctionAdapter(["exec"]);
    compressed.adaptRequest(execRequest(), 3);
    expect(() =>
      compressed.createResponseTransform(3, {
        contentType: "application/json",
        contentEncoding: "gzip",
      }),
    ).toThrow(/compressed custom tool responses/i);

    const unknown = createResponsesCustomToolFunctionAdapter(["exec"]);
    unknown.adaptRequest(execRequest(), 4);
    expect(() =>
      unknown.createResponseTransform(4, {
        contentType: "text/plain",
        contentEncoding: "",
      }),
    ).toThrow(/unsupported content type/i);
  });
});
