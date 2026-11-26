import { AsyncLocalStorage } from 'node:async_hooks';
import {
  StreamableHTTPServerTransport, type StreamableHTTPServerTransportOptions,
} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  isJSONRPCErrorResponse, isJSONRPCRequest, isJSONRPCResultResponse,
  type JSONRPCMessage, type RequestId, type Tool,
} from '@modelcontextprotocol/sdk/types.js';

/*
 * agy (Antigravity CLI) puts every tool of the MCP servers it receives over ACP `session/new`
 * into one eager budget shared by all servers (measured at about 16 KB of the per-tool JSON it
 * writes under ~/.gemini/antigravity-cli/mcp/<server>/: name, description and parameters).
 * When the budget is full it drops the largest tools entirely: they are neither declared to
 * the model nor reachable otherwise (https://github.com/google-antigravity/antigravity-cli/issues/1530).
 * Cindy's full catalog is about ten times that, so plugin, scheduler and Orca entry points
 * silently disappeared.
 *
 * For agy only, each server's tools/list is projected to its share of a total that stays well
 * under that budget. Tools are shortened to a one-line summary with parameter types; the full
 * usage comes from `describe_tool`. Tools that do not fit are called through `run_tool`, which
 * the transport turns back into the original tools/call before the server sees it, so the
 * normal registration, argument validation and authorization run unchanged.
 */

const ANTIGRAVITY_CLIENT_NAME = 'antigravity-client';
/** Bytes of tool JSON all Cindy servers may declare to one agy session together. */
export const ANTIGRAVITY_TOTAL_DECLARATION_BYTES = 12_000;
const DESCRIBE_TOOL = 'describe_tool';
const RUN_TOOL = 'run_tool';
const SUMMARY_MAX_BYTES = 100;
const DETAILS_HINT = ' See describe_tool.';

/** Servers carrying more than one entry the model must see directly get a larger share. */
const SHARE_WEIGHT: Record<string, number> = { cindy: 3, cindy_orca: 3.5, cindy_helper: 2, orca_worker_bridge: 1.5 };

/** Tools kept directly declared first, in order, with an optional fixed summary. */
const PREFERRED: Record<string, Array<[name: string, summary?: string]>> = {
  cindy: [
    ['ghost_info', 'Inspect a Cindy plugin and its tools.'],
    ['ghost_call', 'Call a Cindy plugin tool.'],
    ['ghost_manual', 'Read a Cindy plugin manual.'],
    ['ghost_list', 'List installed Cindy plugins.'],
    ['connect_account', 'Show the sign-in button for a plugin or service account.'],
  ],
  cindy_orca: [
    ['start_team', 'Start an Orca team.'],
    ['create_workers', 'Create multiple Workers with initial tasks.'],
    ['send_to_worker', 'Send a message to a Worker.'],
    ['list_workers', 'List the team\'s Workers.'],
    ['read_worker', 'Read a Worker\'s latest output.'],
    ['list_available_models', 'List available Worker models.'],
    ['set_worker_runtime', 'Change a Worker runtime.'],
  ],
  orca_worker_bridge: [['send_to_lead', 'Report to the Lead.'], ['read_lead'], ['lead_status']],
  cindy_helper: [
    ['list_tools', 'Find Cindy controls and capabilities; returns the next call.'],
    ['call_tool', 'Call a tool that list_tools returned.'],
    ['ask_user_question_async'],
    ['request_input_handoff'],
  ],
  cindy_feishu_bot: [['list_tools'], ['call_tool'], ['send_text'], ['send_markdown']],
};
const GATEWAY_NAME = /(^|_)(list_tools|call_tool)$/;

type Definition = Pick<Tool, 'name' | 'description' | 'inputSchema'>;

/** Size of a tool as agy counts it: the JSON file it writes for the tool. */
function declarationBytes(tool: Tool): number {
  return Buffer.byteLength(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.inputSchema }));
}

/** First sentence, cut to SUMMARY_MAX_BYTES (CJK text costs three bytes per character). */
function summarize(description: string | undefined): string {
  const first = (description ?? '').trim().split(/\n|(?<=[。！？])|(?<=[.!?])\s/u)[0]?.trim() ?? '';
  if (Buffer.byteLength(first) <= SUMMARY_MAX_BYTES) return first;
  let out = '';
  for (const char of first) {
    if (Buffer.byteLength(out + char) > SUMMARY_MAX_BYTES - 3) break;
    out += char;
  }
  return `${out}…`;
}

function parameterTypes(schema: Tool['inputSchema']) {
  return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([name, property]) => {
    const type = property && typeof property === 'object' && 'type' in property ? property.type : undefined;
    return [name, type === 'array' ? { type, items: {} } : type ? { type } : {}];
  }));
}

function compact(tool: Tool, summary: string | undefined, hint = DETAILS_HINT): Tool {
  return {
    ...tool,
    description: (summary ?? summarize(tool.description)) + hint,
    inputSchema: {
      type: 'object', properties: parameterTypes(tool.inputSchema),
      ...(tool.inputSchema.required?.length ? { required: tool.inputSchema.required } : {}),
    },
  };
}

const describeDeclaration: Tool = {
  name: DESCRIBE_TOOL,
  description: 'List tools; with name, full usage.',
  inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
  annotations: { readOnlyHint: true },
};
const runDeclaration: Tool = {
  name: RUN_TOOL,
  description: 'Run an undeclared tool.',
  inputSchema: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object' } }, required: ['name'] },
};

export interface CatalogProjection {
  tools: Tool[];
  /** Tools not declared directly; reachable through run_tool. */
  hidden: string[];
}

/** Project one server's tools/list for agy into at most `budgetBytes` of declarations. */
export function projectAntigravityCatalog(serverName: string, tools: Tool[], budgetBytes: number): CatalogProjection {
  const own = tools.filter(tool => tool.name !== DESCRIBE_TOOL && tool.name !== RUN_TOOL);
  if (own.reduce((sum, tool) => sum + declarationBytes(tool), 0) <= budgetBytes) return { tools: own, hidden: [] };

  const preferred = PREFERRED[serverName] ?? [];
  const summaries = new Map(preferred.map(([name, summary]) => [name, summary]));
  const sum = (list: Tool[]) => list.reduce((total, tool) => total + declarationBytes(tool), 0);

  // A gateway server's own list_tools already explains its tools, so it needs no describe_tool.
  if (own.every(tool => GATEWAY_NAME.test(tool.name))) {
    const gateways = own.map(tool => compact(tool, summaries.get(tool.name), ''));
    if (sum(gateways) <= budgetBytes) return { tools: gateways, hidden: [] };
  }
  const compacted = own.map(tool => compact(tool, summaries.get(tool.name)));
  if (sum(compacted) + declarationBytes(describeDeclaration) <= budgetBytes) {
    return { tools: [...compacted, describeDeclaration], hidden: [] };
  }

  // Over budget: only the preferred entries and the gateway tools may stay declared, in that order.
  const rank = (name: string) => {
    const index = preferred.findIndex(([preferredName]) => preferredName === name);
    return index >= 0 ? index : GATEWAY_NAME.test(name) ? preferred.length : Number.POSITIVE_INFINITY;
  };
  const candidates = compacted.filter(tool => Number.isFinite(rank(tool.name)))
    .sort((a, b) => rank(a.name) - rank(b.name));
  let used = declarationBytes(describeDeclaration) + declarationBytes(runDeclaration);
  const direct = new Set<string>();
  for (const tool of candidates) {
    const bytes = declarationBytes(tool);
    if (used + bytes > budgetBytes) continue;
    direct.add(tool.name);
    used += bytes;
  }
  return {
    tools: [...candidates.filter(tool => direct.has(tool.name)), describeDeclaration, runDeclaration],
    hidden: own.filter(tool => !direct.has(tool.name)).map(tool => tool.name),
  };
}

/** This server's share of the total, weighted across every server the bridge offers. */
export function antigravityServerBudget(serverName: string, serverNames: readonly string[]): number {
  const weight = (name: string) => SHARE_WEIGHT[name] ?? 1;
  const total = serverNames.reduce((sum, name) => sum + weight(name), 0) || 1;
  return Math.floor(ANTIGRAVITY_TOTAL_DECLARATION_BYTES * weight(serverName) / total);
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) };
}

export interface ObservedMcpToolCallResult {
  serverName: string;
  toolName: string;
  input: unknown;
  fullText: string;
  isError: boolean;
}

const MAX_IN_FLIGHT_OBSERVED_CALLS = 256;

function extractMcpToolResponse(
  message: JSONRPCMessage,
): { fullText: string; isError: boolean } | null {
  if (isJSONRPCResultResponse(message)) {
    const result = message.result as {
      content?: unknown;
      structuredContent?: unknown;
      isError?: unknown;
    };
    const parts: string[] = [];
    if (Array.isArray(result.content)) {
      for (const item of result.content) {
        if (!item || typeof item !== 'object') continue;
        const block = item as Record<string, unknown>;
        if (block.type === 'text' && typeof block.text === 'string') {
          if (block.text.length > 0) parts.push(block.text);
        } else if (block.type === 'resource' && block.resource && typeof block.resource === 'object') {
          const resource = block.resource as Record<string, unknown>;
          if (typeof resource.text === 'string' && resource.text.length > 0) parts.push(resource.text);
          else if (typeof resource.uri === 'string' && resource.uri.length > 0) parts.push(resource.uri);
        } else if (block.type === 'resource_link' && typeof block.uri === 'string' && block.uri.length > 0) {
          parts.push(block.uri);
        }
      }
    }
    if (parts.length === 0 && result.structuredContent !== undefined) {
      try {
        const serialized = JSON.stringify(result.structuredContent);
        if (serialized) parts.push(serialized);
      } catch {
        // ignore unserializable structuredContent
      }
    }
    return { fullText: parts.join('\n'), isError: result.isError === true };
  }
  if (isJSONRPCErrorResponse(message)) {
    const text = typeof message.error?.message === 'string' && message.error.message.length > 0
      ? message.error.message
      : 'MCP tool call failed';
    return { fullText: text, isError: true };
  }
  return null;
}

/**
 * Observes `tools/call` JSON-RPC requests and emits their final text response synchronously
 * before the HTTP bytes are sent back to the client, so ACP engines that omit `content`/
 * `rawOutput` on `tool_call_update` always find the receipt already recorded.
 */
class ObservedStreamableHTTPServerTransport extends StreamableHTTPServerTransport {
  private readonly inFlightToolCalls = new Map<RequestId, { toolName: string; input: unknown }>();

  constructor(
    options: StreamableHTTPServerTransportOptions,
    protected readonly observedServerName: string,
    private readonly onToolCallResult?: (receipt: ObservedMcpToolCallResult) => void,
  ) {
    super(options);
  }

  override set onmessage(handler: Transport['onmessage']) {
    super.onmessage = handler && ((message, extra) => {
      if (this.onToolCallResult && isJSONRPCRequest(message) && message.method === 'tools/call') {
        const params = message.params as { name?: unknown; arguments?: unknown } | undefined;
        if (typeof params?.name === 'string' && params.name.length > 0) {
          if (this.inFlightToolCalls.size >= MAX_IN_FLIGHT_OBSERVED_CALLS && !this.inFlightToolCalls.has(message.id)) {
            const oldest = this.inFlightToolCalls.keys().next().value;
            if (oldest !== undefined) this.inFlightToolCalls.delete(oldest);
          }
          this.inFlightToolCalls.set(message.id, { toolName: params.name, input: params.arguments });
        }
      }
      return handler(message, extra);
    });
  }
  override get onmessage(): Transport['onmessage'] { return super.onmessage; }

  override send(message: JSONRPCMessage, options?: TransportSendOptions) {
    if (
      this.onToolCallResult &&
      (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) &&
      message.id !== undefined
    ) {
      const pending = this.inFlightToolCalls.get(message.id);
      if (pending) {
        this.inFlightToolCalls.delete(message.id);
        const extracted = extractMcpToolResponse(message);
        if (extracted) {
          this.onToolCallResult({
            serverName: this.observedServerName,
            toolName: pending.toolName,
            input: pending.input,
            fullText: extracted.fullText,
            isError: extracted.isError,
          });
        }
      }
    }
    return super.send(message, options);
  }

  override close(): Promise<void> {
    this.inFlightToolCalls.clear();
    return super.close();
  }
}

/**
 * describe_tool and run_tool exist only in this transport: the McpServer is never touched, so
 * servers that install their own tools/list and tools/call handlers (MCP App and companion
 * connection proxies) keep their discovery and execution unchanged.
 */
class AntigravityCatalogTransport extends ObservedStreamableHTTPServerTransport {
  private readonly listing = new AsyncLocalStorage<RequestId>();
  private readonly definitions = new Map<string, Definition>();
  private hidden = new Set<string>();
  /** Whether the latest listing declared describe_tool / run_tool. */
  private helpers = false;

  constructor(
    options: StreamableHTTPServerTransportOptions,
    private readonly serverName: string,
    private readonly budgetBytes: number,
    onToolCallResult?: (receipt: ObservedMcpToolCallResult) => void,
  ) {
    super(options, serverName, onToolCallResult);
  }

  private unknownTool(name: unknown) {
    return textResult(`No tool named ${String(name)} on this server. Call describe_tool without name to list them.`, true);
  }

  /** The reply to a describe_tool call, or to a run_tool call that cannot be forwarded. */
  private localResult(name: unknown, args: Record<string, unknown>) {
    if (name === DESCRIBE_TOOL) {
      if (args.name === undefined) {
        return textResult(JSON.stringify([...this.definitions.values()].map(tool => ({
          name: tool.name, summary: summarize(tool.description), declared: !this.hidden.has(tool.name),
        }))));
      }
      const definition = typeof args.name === 'string' ? this.definitions.get(args.name) : undefined;
      return definition ? textResult(JSON.stringify(definition)) : this.unknownTool(args.name);
    }
    if (name === RUN_TOOL && !(typeof args.name === 'string' && this.definitions.has(args.name))) {
      return this.unknownTool(args.name);
    }
    return undefined;
  }

  // SDK handlers may run concurrently, including requests in the same JSON-RPC batch.
  // Bind the projection to the individual tools/list handler, never to tools/call output.
  override set onmessage(handler: Transport['onmessage']) {
    super.onmessage = handler && ((message, extra) => {
      if (!isJSONRPCRequest(message)) return handler(message, extra);
      if (message.method === 'tools/list') return this.listing.run(message.id, () => handler(message, extra));
      const params = message.params as { name?: unknown; arguments?: unknown } | undefined;
      if (!this.helpers || message.method !== 'tools/call' || (params?.name !== DESCRIBE_TOOL && params?.name !== RUN_TOOL)) {
        return handler(message, extra);
      }
      const args = params.arguments && typeof params.arguments === 'object' ? params.arguments as Record<string, unknown> : {};
      const local = this.localResult(params.name, args);
      if (local) {
        void this.send({ jsonrpc: '2.0', id: message.id, result: local }).catch(error => this.onerror?.(error as Error));
        return;
      }
      // run_tool → the tools/call it stands for; the server validates and authorizes it as usual.
      const forwarded = args.arguments && typeof args.arguments === 'object' ? args.arguments : {};
      return handler({ ...message, params: { ...params, name: args.name, arguments: forwarded } }, extra);
    });
  }
  override get onmessage(): Transport['onmessage'] { return super.onmessage; }

  override send(message: JSONRPCMessage, options?: TransportSendOptions) {
    const listId = this.listing.getStore();
    if (listId !== undefined && isJSONRPCResultResponse(message) && listId === message.id && Array.isArray(message.result.tools)) {
      const original = message.result.tools as Tool[];
      this.definitions.clear();
      for (const { name, description, inputSchema } of original) this.definitions.set(name, { name, description, inputSchema });
      // A server with its own describe_tool or run_tool keeps its catalog; never shadow its tools.
      const projection = original.some(tool => tool.name === DESCRIBE_TOOL || tool.name === RUN_TOOL)
        ? { tools: original, hidden: [] }
        : projectAntigravityCatalog(this.serverName, original, this.budgetBytes);
      this.hidden = new Set(projection.hidden);
      this.helpers = projection.tools !== original && projection.tools.some(tool => tool.name === DESCRIBE_TOOL);
      return super.send({ ...message, result: { ...message.result, tools: projection.tools } }, options);
    }
    return super.send(message, options);
  }
}

export function createCatalogTransport(
  clientName: string,
  serverName: string,
  serverNames: readonly string[],
  options: StreamableHTTPServerTransportOptions,
  onToolCallResult?: (receipt: ObservedMcpToolCallResult) => void,
): StreamableHTTPServerTransport {
  if (clientName === ANTIGRAVITY_CLIENT_NAME) {
    return new AntigravityCatalogTransport(
      options,
      serverName,
      antigravityServerBudget(serverName, serverNames),
      onToolCallResult,
    );
  }
  return onToolCallResult
    ? new ObservedStreamableHTTPServerTransport(options, serverName, onToolCallResult)
    : new StreamableHTTPServerTransport(options);
}
