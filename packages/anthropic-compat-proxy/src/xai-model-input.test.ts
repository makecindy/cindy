import { describe, expect, it } from "vitest";

import {
  createXaiModelInputRecoveryRule,
  createXaiModelInputSanitizeTransform,
  looksLikeXaiResponsesModel,
  sanitizeXaiModelInputBody,
  sanitizeXaiModelInputFromBody,
  supportsXaiReasoningModel,
} from "./xai-model-input.js";

describe("looksLikeXaiResponsesModel", () => {
  it.each([
    "grok-4.5",
    "xai/grok-4.5",
    "x-ai/grok-4.5",
    "X-AI/Grok-4.20",
    "litellm/grok-code-fast",
  ])("accepts %s", (model) => {
    expect(looksLikeXaiResponsesModel(model)).toBe(true);
  });

  it.each([
    "gpt-5.5",
    "openai/gpt-5.5",
    "claude-sonnet-4-5",
    "x-ai-not-grok",
    "",
    1,
    null,
  ])("rejects %s", (model) => {
    expect(looksLikeXaiResponsesModel(model)).toBe(false);
  });
});

describe("sanitizeXaiModelInputBody", () => {
  it("returns null when input is already xAI-safe", () => {
    expect(
      sanitizeXaiModelInputBody({
        model: "grok-4.5",
        input: [{ type: "message", role: "user", content: "hi" }],
      }),
    ).toBeNull();
  });

  it("rewrites Codex collab + custom tool history and LiteLLM chat leftovers", () => {
    const out = sanitizeXaiModelInputBody({
      model: "x-ai/grok-4.5",
      input: [
        { role: "user", content: "go" },
        {
          type: "agent_message",
          author: "/root",
          content: [
            { type: "input_text", text: "done" },
            { type: "encrypted_content", encrypted_content: "gAAA" },
          ],
        },
        {
          type: "custom_tool_call",
          id: "ctc_1",
          call_id: "call_1",
          name: "exec",
          input: "console.log(1)",
        },
        {
          type: "custom_tool_call_output",
          call_id: "call_1",
          output: [{ type: "input_text", text: "ok" }],
        },
        {
          type: "function",
          id: "call_2",
          function: { name: "read_file", arguments: '{"path":"a"}' },
        },
        { role: "tool", tool_call_id: "call_2", content: "file body" },
        {
          type: "reasoning",
          id: "rs_1",
          content: null,
          encrypted_content: "BLOB",
        },
        { type: "web_search_call", id: "ws_1", status: "completed" },
        "plain text item",
      ],
    });

    expect(out?.input).toEqual([
      { type: "message", role: "user", content: "go" },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "[collab /root]\ndone" }],
      },
      {
        type: "function_call",
        id: "ctc_1",
        name: "exec",
        arguments: '{"input":"console.log(1)"}',
        call_id: "call_1",
      },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
      {
        type: "function_call",
        id: "call_2",
        name: "read_file",
        arguments: '{"path":"a"}',
        call_id: "call_2",
      },
      { type: "function_call_output", call_id: "call_2", output: "file body" },
      { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "BLOB" },
      { type: "web_search_call", id: "ws_1", status: "completed" },
      { type: "message", role: "user", content: "plain text item" },
    ]);
  });

  it("keeps official attachments and server-side tool items when rewriting a bad sibling", () => {
    const filePart = {
      type: "input_file",
      file_id: "file_123",
      filename: "notes.pdf",
    };
    const imagePart = {
      type: "input_image",
      image_url: "https://example.com/a.png",
      detail: "high",
    };
    const webSearch = {
      type: "web_search_call",
      id: "ws_1",
      status: "completed",
      action: { type: "search", query: "xai responses" },
    };
    const code = {
      type: "code_interpreter_call",
      id: "ci_1",
      status: "completed",
    };
    const files = { type: "file_search_call", id: "fs_1", status: "completed" };
    const out = sanitizeXaiModelInputBody({
      model: "x-ai/grok-4.6",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "see these" },
            filePart,
            imagePart,
          ],
        },
        { type: "agent_message", author: "bot", content: "ok" },
        webSearch,
        code,
        files,
      ],
    });

    expect(out?.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "see these" },
          filePart,
          imagePart,
        ],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "[collab bot]\nok" }],
      },
      webSearch,
      code,
      files,
    ]);
  });

  it("keeps host-allowed xAI server tool replay items", () => {
    const shellCall = {
      type: "shell_call",
      id: "sh_1",
      status: "completed",
    };
    const shellOut = {
      type: "shell_call_output",
      call_id: "sh_1",
      output: "ok",
    };
    const execCall = { type: "code_execution_call", id: "ce_1" };
    const collections = { type: "collections_search_call", id: "cs_1" };
    const out = sanitizeXaiModelInputBody({
      model: "x-ai/grok-4.6",
      input: [
        { type: "agent_message", author: "bot", content: "ok" },
        shellCall,
        shellOut,
        execCall,
        collections,
      ],
    });
    expect(out?.input).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "[collab bot]\nok" }],
      },
      shellCall,
      shellOut,
      execCall,
      collections,
    ]);
  });

  it("flattens Chat-compat {image_url:{url,detail}} into Responses string + detail", () => {
    const out = sanitizeXaiModelInputBody({
      model: "x-ai/grok-4.6",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: {
                url: "https://example.com/a.png",
                detail: "high",
              },
            },
          ],
        },
      ],
    });
    expect(out?.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: "https://example.com/a.png",
            detail: "high",
          },
        ],
      },
    ]);
  });

  it("rewrites compaction blobs into a readable context note instead of dropping them", () => {
    const out = sanitizeXaiModelInputBody({
      model: "my-custom-alias",
      input: [
        { type: "compaction", encrypted_content: "OPENAI-BLOB" },
        { type: "message", role: "user", content: "continue" },
      ],
    });
    expect(out?.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: expect.stringContaining(
              "not readable on the current model provider",
            ),
          },
        ],
      },
      { type: "message", role: "user", content: "continue" },
    ]);
  });

  it("maps Anthropic tool_result.tool_use_id and drops outputs with no id", () => {
    const out = sanitizeXaiModelInputBody({
      model: "x-ai/grok-4.6",
      input: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: "ok",
        },
        { type: "tool_result", content: "orphan" },
      ],
    });
    expect(out?.input).toEqual([
      { type: "function_call_output", call_id: "t1", output: "ok" },
    ]);
  });

  it("does not treat output item id as a call association", () => {
    const out = sanitizeXaiModelInputBody({
      model: "x-ai/grok-4.6",
      input: [
        { type: "function_call", name: "ok", arguments: "{}", call_id: "c1" },
        { type: "function_call_output", id: "msg_abc", output: "nope" },
        { role: "tool", id: "msg_def", content: "also nope" },
        { type: "function_call_output", call_id: "c1", output: "ok" },
      ],
    });
    expect(out?.input).toEqual([
      {
        type: "function_call",
        name: "ok",
        arguments: "{}",
        call_id: "c1",
      },
      { type: "function_call_output", call_id: "c1", output: "ok" },
    ]);
  });

  it("drops tool calls that have no non-empty call id", () => {
    const out = sanitizeXaiModelInputBody({
      model: "x-ai/grok-4.6",
      input: [
        { type: "custom_tool_call", name: "exec", input: "pwd" },
        {
          type: "function",
          function: { name: "read_file", arguments: "{}" },
        },
        { type: "function_call", name: "ok", arguments: "{}", call_id: "c1" },
      ],
    });
    expect(out?.input).toEqual([
      {
        type: "function_call",
        name: "ok",
        arguments: "{}",
        call_id: "c1",
      },
    ]);
  });

  it("drops empty reasoning shells and image generation items", () => {
    const out = sanitizeXaiModelInputBody({
      model: "grok-4.5",
      input: [
        { type: "message", role: "user", content: "hi" },
        { type: "reasoning", summary: [] },
        { type: "image_generation_call", status: "completed" },
      ],
    });
    expect(out?.input).toEqual([
      { type: "message", role: "user", content: "hi" },
    ]);
  });

  it.each([
    "grok-code-fast",
    "x-ai/grok-code-fast",
    "grok-build-0.1",
    "xai/grok-build-preview",
  ])("drops reasoning by default for non-reasoning model %s", (model) => {
    expect(supportsXaiReasoningModel(model)).toBe(false);
    const out = sanitizeXaiModelInputBody({
      model,
      input: [
        {
          type: "reasoning",
          id: "rs_1",
          summary: [],
          encrypted_content: "BLOB",
        },
        { type: "message", role: "user", content: "hi" },
      ],
    });
    expect(out?.input).toEqual([
      { type: "message", role: "user", content: "hi" },
    ]);
  });

  it("keeps well-formed reasoning for general Grok models by default", () => {
    expect(supportsXaiReasoningModel("x-ai/grok-4.6")).toBe(true);
    expect(
      sanitizeXaiModelInputBody({
        model: "x-ai/grok-4.6",
        input: [
          {
            type: "reasoning",
            id: "rs_1",
            summary: [],
            encrypted_content: "BLOB",
          },
          { type: "message", role: "user", content: "hi" },
        ],
      }),
    ).toBeNull();
  });

  it("drops reasoning for unrecognized LiteLLM aliases", () => {
    const out = sanitizeXaiModelInputBody({
      model: "litellm-hidden-coding",
      input: [
        {
          type: "reasoning",
          id: "rs_1",
          summary: [],
          encrypted_content: "BLOB",
        },
        { type: "agent_message", author: "bot", content: "hi" },
      ],
    });
    expect(out?.input).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "[collab bot]\nhi" }],
      },
    ]);
  });

  it("uses output_text for assistant string parts and string content", () => {
    const out = sanitizeXaiModelInputBody({
      model: "x-ai/grok-4.6",
      input: [
        {
          type: "message",
          role: "assistant",
          content: ["reply"],
        },
        {
          type: "message",
          role: "assistant",
          content: "also a reply",
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "input_text", text: "legacy" }],
        },
      ],
    });
    expect(out?.input).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "reply" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "also a reply" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "legacy" }],
      },
    ]);
  });

  it("converts refusal parts to output_text instead of emptying the message", () => {
    const out = sanitizeXaiModelInputBody({
      model: "x-ai/grok-4.6",
      input: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "refusal", refusal: "I can't help with that." }],
        },
      ],
    });
    expect(out?.input).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "I can't help with that." }],
      },
    ]);
  });

  it("emits empty-string text when input_text.text is not a string", () => {
    const out = sanitizeXaiModelInputBody({
      model: "x-ai/grok-4.6",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: null }],
        },
      ],
    });
    expect(out?.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "" }],
      },
    ]);
  });

  it("wraps a single object input into an array before sanitizing", () => {
    const out = sanitizeXaiModelInputBody({
      model: "grok-4.5",
      input: { role: "user", content: "hi" },
    });
    expect(out?.input).toEqual([
      { type: "message", role: "user", content: "hi" },
    ]);
  });
});

describe("createXaiModelInputSanitizeTransform", () => {
  const transform = createXaiModelInputSanitizeTransform();
  const ctx = { reqId: 1, method: "POST", url: "/responses", headers: {} };

  it("sanitizes gateway grok models even without an xAI session", () => {
    const out = transform(
      {
        model: "x-ai/grok-4.5",
        input: [{ type: "agent_message", author: "bot", content: "hi" }],
      },
      ctx,
    );
    expect(out).toMatchObject({
      input: [{ type: "message", role: "assistant" }],
    });
  });

  it("does not rewrite GPT history", () => {
    const body = {
      model: "gpt-5.5",
      input: [{ type: "agent_message", author: "bot", content: "hi" }],
    };
    expect(transform(body, ctx)).toBeNull();
  });

  it("drops reasoning on gateway coding models without an explicit override", () => {
    const out = transform(
      {
        model: "x-ai/grok-code-fast",
        input: [
          {
            type: "reasoning",
            id: "rs_1",
            summary: [],
            encrypted_content: "BLOB",
          },
          { type: "message", role: "user", content: "hi" },
        ],
      },
      ctx,
    );
    expect(out).toEqual({
      model: "x-ai/grok-code-fast",
      input: [{ type: "message", role: "user", content: "hi" }],
    });
  });
});

describe("createXaiModelInputRecoveryRule", () => {
  const rule = createXaiModelInputRecoveryRule();

  it("matches the LiteLLM-wrapped xAI 422 the client actually surfaces", () => {
    const error =
      "unexpected status 422 Unprocessable Entity: litellm.BadRequestError: XaiException - " +
      '{"error":"Failed to deserialize the JSON body into the target type: ' +
      'data did not match any variant of untagged enum ModelInput"}, ' +
      "url: http://127.0.0.1:55081/responses";
    expect(rule.matches(error)).toBe(true);
  });

  it("does not match unrelated 422s", () => {
    expect(
      rule.matches("Could not decrypt the provided encrypted_content"),
    ).toBe(false);
  });

  it("strips the offending items so a retry can proceed", () => {
    const stripped = rule.strip(
      Buffer.from(
        JSON.stringify({
          model: "my-grok-alias",
          input: [
            { type: "message", role: "user", content: "hi" },
            { type: "agent_message", author: "bot", content: "secret" },
          ],
        }),
      ),
    );
    expect(stripped).not.toBeNull();
    expect(JSON.parse(stripped!.toString("utf8")).input).toEqual([
      { type: "message", role: "user", content: "hi" },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "[collab bot]\nsecret" }],
      },
    ]);
  });

  it("drops reasoning on grok-code when retrying a ModelInput 422", () => {
    const stripped = rule.strip(
      Buffer.from(
        JSON.stringify({
          model: "x-ai/grok-code-fast",
          input: [
            { type: "reasoning", encrypted_content: "BLOB" },
            { type: "agent_message", author: "bot", content: "hi" },
          ],
        }),
      ),
    );
    expect(JSON.parse(stripped!.toString("utf8")).input).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "[collab bot]\nhi" }],
      },
    ]);
  });

  it("drops reasoning when recovering a hidden coding-model alias", () => {
    const stripped = rule.strip(
      Buffer.from(
        JSON.stringify({
          model: "litellm-hidden-coding",
          input: [
            { type: "reasoning", encrypted_content: "BLOB" },
            { type: "agent_message", author: "bot", content: "hi" },
          ],
        }),
      ),
    );
    expect(JSON.parse(stripped!.toString("utf8")).input).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "[collab bot]\nhi" }],
      },
    ]);
  });

  it("returns null when there is nothing to rewrite", () => {
    expect(sanitizeXaiModelInputFromBody(Buffer.from("not json"))).toBeNull();
    expect(
      sanitizeXaiModelInputFromBody(
        Buffer.from(
          JSON.stringify({
            model: "grok-4.5",
            input: [{ type: "message", role: "user", content: "hi" }],
          }),
        ),
      ),
    ).toBeNull();
  });
});
