import { Buffer } from "node:buffer";
import type { Transform } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createResponsesCustomToolFunctionAdapter } from "../custom-tool-function-adapter.js";

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

describe("Responses custom-tool function adapter", () => {
  afterEach(() => {
    vi.useRealTimers();
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
