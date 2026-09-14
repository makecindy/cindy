// Pure protocol helpers extracted verbatim from the pinned upstream adapter.
import { EMPTY_TOOL_OUTPUT_ANNOTATION, isWhitespaceOnlyTextPartArray } from "./empty-tool-output-annotation";
export const CANONICAL_ONLY_TOOL_FIELDS: readonly { field: string; toolTypes?: ReadonlySet<string>; capabilityGated?: boolean }[] = [
  // ChatGPT's browsing policy bit. The public hosted tool is enabled by its presence alone.
  // OWNERSHIP: official OpenAI API-key traffic and unclassified gateways ACCEPT this field, so
  // it is only stripped when the provider capability denies it (supportsOpenAiWebSearchToolFields
  // === false), matching stripOpenAiOnlyWebSearchFields; see
  // tests/responses/responses-routed-web-search-fields.test.ts.
  { field: "external_web_access", toolTypes: new Set(["web_search", "web_search_preview"]), capabilityGated: true },
  // Deferred-discovery marker. `activateDeferredTool` clears it only for tools a `tool_search_output`
  // already loaded, so a still-deferred declaration — including one promoted out of a namespace
  // group — otherwise reaches the wire carrying it.
  { field: "defer_loading" },
];

export function stripCanonicalOnlyToolFields(body: unknown, includeCapabilityGated: boolean): unknown {
  if (!isPlainObject(body)) return body;

  const rewriteTools = (tools: unknown[]): unknown[] => {
    let changed = false;
    const rewritten = tools.map(tool => {
      if (!isPlainObject(tool)) return tool;
      let next = tool;
      for (const { field, toolTypes, capabilityGated } of CANONICAL_ONLY_TOOL_FIELDS) {
        if (capabilityGated && !includeCapabilityGated) continue;
        if (!Object.hasOwn(next, field)) continue;
        if (toolTypes && (typeof next.type !== "string" || !toolTypes.has(next.type))) continue;
        const { [field]: _private, ...rest } = next;
        next = rest;
      }
      if (next === tool) return tool;
      changed = true;
      return next;
    });
    return changed ? rewritten : tools;
  };

  let rewrittenBody = body;
  if (Array.isArray(body.tools)) {
    const tools = rewriteTools(body.tools);
    if (tools !== body.tools) rewrittenBody = { ...rewrittenBody, tools };
  }
  if (!Array.isArray(body.input)) return rewrittenBody;

  let input: unknown[] | undefined;
  for (let index = 0; index < body.input.length; index += 1) {
    const item = body.input[index];
    if (!isPlainObject(item) || item.type !== "additional_tools" || !Array.isArray(item.tools)) continue;
    const tools = rewriteTools(item.tools);
    if (tools === item.tools) continue;
    input ??= [...body.input];
    input[index] = { ...item, tools };
  }
  return input ? { ...rewrittenBody, input } : rewrittenBody;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function isToolOutputEmpty(output: unknown): boolean {
  if (typeof output === "string") return output.trim() === "";
  if (Array.isArray(output)) {
    // Mirror the Chat wire rule through the shared contract: only a pure
    // text/refusal part array whose joined content trims empty is annotated.
    // input_image, encrypted_content, input_file and any other non-text part is
    // real output and must never be replaced.
    return isWhitespaceOnlyTextPartArray(output);
  }
  // A missing or null `output` is not a present-but-empty result: it is an
  // incomplete payload. Leave it untouched so the upstream contract fails
  // closed, and the orphan repair can surface it honestly instead of claiming
  // the tool ran with no output.
  return false;
}

export function annotateEmptyResponsesToolOutputs(body: unknown, enabled: boolean): unknown {
  if (!enabled || !isPlainObject(body) || !Array.isArray(body.input)) return body;
  let changed = false;
  const input = body.input.map(item => {
    if (!isPlainObject(item) || (item.type !== "function_call_output" && item.type !== "custom_tool_call_output")) return item;
    if (!isToolOutputEmpty(item.output)) return item;
    changed = true;
    return { ...item, output: EMPTY_TOOL_OUTPUT_ANNOTATION };
  });
  return changed ? { ...body, input } : body;
}

export function backfillWebSearchQueries(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;
  let changed = false;
  const input = body.input.map(item => {
    if (!isPlainObject(item) || item.type !== "web_search_call") return item;
    const action = item.action;
    if (!isPlainObject(action) || action.type !== "search") return item;
    // Repair whichever side is missing so both strict parsers pass:
    // DeepSeek native Responses requires `queries`; Console Go requires `query`.
    const rep: Record<string, unknown> = { ...action };
    let itemChanged = false;
    const hasQuery = typeof action.query === "string";
    const queries = Array.isArray(action.queries) ? action.queries : undefined;
    if (queries !== undefined && queries.length === 0) {
      // An empty array satisfies neither validator. Canonicalize to the empty-search
      // shape the bridge emits, keeping an existing query rather than discarding it.
      const query = hasQuery ? action.query as string : "";
      rep.query = query;
      rep.queries = [query];
      itemChanged = true;
    } else if (!hasQuery && queries !== undefined) {
      // A plural array is only a usable source for the singular field when EVERY member
      // is a string: deriving `query` from a partly-malformed array would satisfy Console
      // Go while leaving DeepSeek to reject the same replay. Wholly malformed arrays are
      // left untouched — coercing or dropping members would invent semantics the stored
      // item never had.
      if (queries.every(entry => typeof entry === "string")) {
        rep.query = queries[0];            // multi-query item recorded before the fix
        itemChanged = true;
      }
    } else if (hasQuery && queries === undefined) {
      rep.queries = [action.query];        // single-query item recorded before the fix
      itemChanged = true;
    }
    if (itemChanged) changed = true;
    return itemChanged ? { ...item, action: rep } : item;
  });
  return changed ? { ...body, input } : body;
}

export function normalizeResponsesToolResultAdjacency(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;
  const input = body.input;
  const calls = new Map<string, number[]>();
  const outputs = new Map<string, number[]>();

  const appendIndex = (map: Map<string, number[]>, key: string, index: number): void => {
    const existing = map.get(key);
    if (existing) existing.push(index);
    else map.set(key, [index]);
  };

  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (!isPlainObject(item) || typeof item.call_id !== "string" || item.call_id.length === 0) continue;
    if (item.type === "function_call" || item.type === "local_shell_call") {
      appendIndex(calls, `function:${item.call_id}`, index);
    } else if (item.type === "custom_tool_call") {
      appendIndex(calls, `custom:${item.call_id}`, index);
    } else if (item.type === "function_call_output") {
      appendIndex(outputs, `function:${item.call_id}`, index);
    } else if (item.type === "custom_tool_call_output") {
      appendIndex(outputs, `custom:${item.call_id}`, index);
    }
  }

  const pairs: Array<{ callIndex: number; outputIndex: number }> = [];
  for (const [key, callIndices] of calls) {
    const outputIndices = outputs.get(key);
    if (!outputIndices) return body;
    if (callIndices.length !== 1 || outputIndices.length !== 1) return body;
    const callIndex = callIndices[0]!;
    const outputIndex = outputIndices[0]!;
    if (outputIndex <= callIndex) return body;
    pairs.push({ callIndex, outputIndex });
  }
  // Reject any collected output that lacks exactly one matching call. A lone or
  // duplicated output is ambiguous, and normalizing on top of it could sever a
  // result from the reasoning-bearing call turn it belongs to.
  for (const [key, outputIndices] of outputs) {
    const callIndices = calls.get(key);
    if (!callIndices || callIndices.length !== 1 || outputIndices.length !== 1) return body;
  }
  pairs.sort((left, right) => left.callIndex - right.callIndex);

  const movedIndices = new Set<number>();
  const batchAt = new Map<number, unknown[]>();
  for (let cursor = 0; cursor < pairs.length;) {
    const group = [pairs[cursor]!];
    let firstOutputIndex = pairs[cursor]!.outputIndex;
    let next = cursor + 1;
    while (next < pairs.length && pairs[next]!.callIndex < firstOutputIndex) {
      group.push(pairs[next]!);
      firstOutputIndex = Math.min(firstOutputIndex, pairs[next]!.outputIndex);
      next += 1;
    }

    // Within one reasoning turn the outputs must appear in the same order as their
    // calls. If they are reversed, normalizing would fabricate a new output order;
    // leave the ambiguous history untouched instead.
    for (let groupIndex = 1; groupIndex < group.length; groupIndex += 1) {
      if (group[groupIndex]!.outputIndex < group[groupIndex - 1]!.outputIndex) return body;
    }

    const batch = [
      ...group.map(pair => input[pair.callIndex]),
      ...group.map(pair => input[pair.outputIndex]),
    ];
    const anchor = group[0]!.callIndex;
    const alreadyContiguous = batch.every((item, offset) => input[anchor + offset] === item);
    if (!alreadyContiguous) {
      batchAt.set(anchor, batch);
      for (const pair of group) {
        movedIndices.add(pair.callIndex);
        movedIndices.add(pair.outputIndex);
      }
    }
    cursor = next;
  }
  if (batchAt.size === 0) return body;

  const normalized: unknown[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const batch = batchAt.get(index);
    if (batch) normalized.push(...batch);
    if (!movedIndices.has(index)) normalized.push(input[index]);
  }
  return { ...body, input: normalized };
}
