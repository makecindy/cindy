import {
  XAI_X_SEARCH_TOOL_TYPE,
  xaiServerSideTools,
} from "./xai-server-side-tools.js";
const XAI_LIVE_SEARCH_TOOL_TYPE = "live_search";
const XAI_MODEL_PREFIX = "xai/";
type PiNativeWireProtocol = "openai-chat" | "openai-responses";
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isXaiSearchToolType(value: unknown): boolean {
  return (
    value === XAI_X_SEARCH_TOOL_TYPE || value === XAI_LIVE_SEARCH_TOOL_TYPE
  );
}

function chatFunctionToolName(tool: unknown): string | null {
  if (
    !isPlainRecord(tool) ||
    tool.type !== "function" ||
    !isPlainRecord(tool.function)
  ) {
    return null;
  }
  return typeof tool.function.name === "string" ? tool.function.name : null;
}

function selectsRemovedXaiSearchTool(toolChoice: unknown): boolean {
  if (isXaiSearchToolType(toolChoice)) return true;
  return isPlainRecord(toolChoice) && isXaiSearchToolType(toolChoice.type);
}

function withoutNativeXaiChatSearchTools(
  body: Record<string, unknown>,
  existing: unknown[],
): Record<string, unknown> | null {
  const tools = existing.filter(
    (tool) => !isPlainRecord(tool) || !isXaiSearchToolType(tool.type),
  );
  if (tools.length === existing.length) return null;

  const next = { ...body };
  if (tools.length === 0) {
    delete next.tools;
    delete next.tool_choice;
    delete next.parallel_tool_calls;
    return next;
  }

  next.tools = tools;
  if (selectsRemovedXaiSearchTool(next.tool_choice)) {
    const functionToolNames = tools.flatMap((tool) => {
      const name = chatFunctionToolName(tool);
      return name === null ? [] : [name];
    });
    if (functionToolNames.length === 1) {
      next.tool_choice = {
        type: "function",
        function: { name: functionToolNames[0] },
      };
    } else {
      next.tool_choice = functionToolNames.length > 1 ? "required" : "auto";
    }
  }
  return next;
}

/**
 * PI already emits xAI-native payloads, so this path bypasses the Messages →
 * Responses bridge that normally supplies xAI's model-gated server tools.
 * Restore the same stable contract here while respecting the native endpoint.
 * Current xAI server-side search tools belong to Responses; Chat Completions'
 * legacy live_search path is deprecated. Strip either search spelling from Chat
 * requests while preserving PI function tools and tool_choice. For Responses,
 * normalize stale spellings, append one missing x_search declaration, and keep
 * forced-function narrowing from being satisfied by x_search instead.
 */
export function withNativeXaiServerSideTools(
  body: unknown,
  wireProtocol: PiNativeWireProtocol,
): Record<string, unknown> | null {
  if (!isPlainRecord(body) || typeof body.model !== "string") return null;
  const existing = Array.isArray(body.tools) ? body.tools : [];
  if (wireProtocol === "openai-chat") {
    return withoutNativeXaiChatSearchTools(body, existing);
  }

  const model = body.model.startsWith(XAI_MODEL_PREFIX)
    ? body.model.slice(XAI_MODEL_PREFIX.length)
    : body.model;
  const serverTools = xaiServerSideTools(model);
  if (serverTools.length === 0) return null;

  const preferredXSearchTool = existing.find(
    (tool) => isPlainRecord(tool) && tool.type === XAI_X_SEARCH_TOOL_TYPE,
  );
  let searchToolDeclared = false;
  let toolsChanged = false;
  const tools = existing.flatMap((tool) => {
    if (
      !isPlainRecord(tool) ||
      (tool.type !== XAI_X_SEARCH_TOOL_TYPE &&
        tool.type !== XAI_LIVE_SEARCH_TOOL_TYPE)
    ) {
      return [tool];
    }
    if (searchToolDeclared) {
      toolsChanged = true;
      return [];
    }
    searchToolDeclared = true;
    if (preferredXSearchTool !== undefined) {
      if (tool === preferredXSearchTool) return [tool];
      toolsChanged = true;
      return [preferredXSearchTool];
    }
    toolsChanged = true;
    // live_search options belong to the deprecated Chat Completions shape and
    // are not interchangeable with Responses x_search options.
    return [{ type: XAI_X_SEARCH_TOOL_TYPE }];
  });
  const declaredTypes = new Set(
    tools.map((tool) =>
      isPlainRecord(tool) && typeof tool.type === "string" ? tool.type : "",
    ),
  );
  const missing = serverTools.filter((tool) => !declaredTypes.has(tool.type));
  if (missing.length > 0) {
    tools.push(...missing);
    toolsChanged = true;
  }
  let next = toolsChanged ? { ...body, tools } : body;

  if (
    isPlainRecord(body.tool_choice) &&
    body.tool_choice.type === XAI_LIVE_SEARCH_TOOL_TYPE
  ) {
    return {
      ...next,
      tool_choice: { type: XAI_X_SEARCH_TOOL_TYPE },
    };
  }

  if (body.tool_choice === "required") {
    const functionToolNames = tools.flatMap((tool) => {
      if (!isPlainRecord(tool) || tool.type !== "function") return [];
      return typeof tool.name === "string" ? [tool.name] : [];
    });
    if (functionToolNames.length === 1) {
      const name = functionToolNames[0]!;
      next = {
        ...next,
        tool_choice: { type: "function", name },
      };
      return next;
    }
  }
  return toolsChanged ? next : null;
}
