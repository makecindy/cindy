import { createHash } from 'node:crypto';

import type {
  ChatCompletionsRequest,
  ResponsesCustomTool,
  ResponsesFunctionTool,
  ResponsesNamespaceTool,
  ResponsesRequest,
} from './types.js';

type ResponseTool = NonNullable<ResponsesRequest['tools']>[number];
const CHAT_TOOL_NAME_MAX_LENGTH = 64;
const TOOL_SEARCH_CHAT_NAME = 'tool_search';
const CUSTOM_TOOL_INPUT_DESCRIPTION =
  'Raw string input for the original custom tool. Preserve formatting exactly.';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function clampChatToolName(name: string): string {
  if (name.length <= CHAT_TOOL_NAME_MAX_LENGTH) return name;
  const suffix = `__${shortHash(name)}`;
  return `${name.slice(0, CHAT_TOOL_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
}

function normalizeFunctionParameters(parameters: unknown): Record<string, unknown> {
  if (!isPlainObject(parameters)) return { type: 'object', properties: {} };
  return parameters.type === 'object'
    ? { ...parameters }
    : { ...parameters, type: 'object' };
}

function stableToolDescription(tool: unknown): string {
  try {
    return `Original Responses custom tool definition:\n${JSON.stringify(tool)}`;
  } catch {
    return 'Original Responses custom tool definition is unavailable.';
  }
}

export type ChatBridgeToolKind = 'function' | 'namespace' | 'custom' | 'tool_search';
type ResponseToolIdentityKind = 'function' | 'custom' | 'tool_search';

export interface ChatBridgeToolSpec {
  kind: ChatBridgeToolKind;
  chatName: string;
  name: string;
  namespace?: string;
}

function responseToolIdentity(
  kind: ResponseToolIdentityKind,
  name: string,
  namespace?: string,
): string {
  return `${kind}\0${namespace ?? ''}\0${name}`;
}

function specIdentity(spec: ChatBridgeToolSpec): string {
  const kind = spec.kind === 'custom' || spec.kind === 'tool_search'
    ? spec.kind
    : 'function';
  return responseToolIdentity(kind, spec.name, spec.namespace);
}

/**
 * One request-scoped catalog for the lossy Chat `function` namespace. It makes request and
 * response translation symmetrical: names flattened for Chat are restored to their Responses
 * function/custom/tool_search representation on the way back.
 */
export class ChatBridgeToolContext {
  private readonly chatToolsValue: NonNullable<ChatCompletionsRequest['tools']> = [];
  private readonly specsByChatName = new Map<string, ChatBridgeToolSpec>();
  private readonly chatNamesByResponseName = new Map<string, string>();

  static fromRequest(request: ResponsesRequest): ChatBridgeToolContext {
    const context = new ChatBridgeToolContext();
    for (const tool of request.tools ?? []) context.addResponseTool(tool);
    context.collectHistoryTools(request.input);
    return context;
  }

  get chatTools(): ChatCompletionsRequest['tools'] {
    return this.chatToolsValue.length > 0 ? this.chatToolsValue : undefined;
  }

  lookupChatName(chatName: string): ChatBridgeToolSpec | undefined {
    return this.specsByChatName.get(chatName);
  }

  /** Whether a streamed name may still resolve to a longer catalogued Chat tool name. */
  hasChatNamePrefix(prefix: string): boolean {
    if (!prefix) return false;
    for (const chatName of this.specsByChatName.keys()) {
      if (chatName !== prefix && chatName.startsWith(prefix)) return true;
    }
    return false;
  }

  chatNameForResponse(
    name: string,
    namespace?: string,
    kind: ResponseToolIdentityKind = 'function',
  ): string {
    return this.chatNamesByResponseName.get(responseToolIdentity(kind, name, namespace))
      ?? clampChatToolName(namespace ? `${namespace}__${name}` : name);
  }

  private reserveName(preferred: string, identity: string): string {
    const clamped = clampChatToolName(preferred);
    const existing = this.specsByChatName.get(clamped);
    if (!existing) return clamped;
    if (specIdentity(existing) === identity) return clamped;
    for (let attempt = 0; ; attempt += 1) {
      const suffix = `__${shortHash(attempt === 0 ? identity : `${identity}\0${attempt}`)}`;
      const candidate = `${clamped.slice(0, CHAT_TOOL_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
      const occupant = this.specsByChatName.get(candidate);
      if (!occupant || specIdentity(occupant) === identity) return candidate;
    }
  }

  private addFunction(tool: ResponsesFunctionTool, namespace?: string): void {
    const nested = isPlainObject((tool as unknown as Record<string, unknown>).function)
      ? (tool as unknown as Record<string, unknown>).function
      : undefined;
    const source = nested ? { ...tool, ...nested } as ResponsesFunctionTool : tool;
    if (!source.name?.trim()) return;
    const identity = responseToolIdentity('function', source.name, namespace);
    const chatName = this.reserveName(namespace ? `${namespace}__${source.name}` : source.name, identity);
    if (this.specsByChatName.has(chatName)) return;
    const spec: ChatBridgeToolSpec = {
      kind: namespace ? 'namespace' : 'function',
      chatName,
      name: source.name,
      ...(namespace ? { namespace } : {}),
    };
    this.specsByChatName.set(chatName, spec);
    this.chatNamesByResponseName.set(identity, chatName);
    this.chatToolsValue.push({
      type: 'function',
      function: {
        name: chatName,
        ...(source.description ? { description: source.description } : {}),
        parameters: normalizeFunctionParameters(source.parameters),
        ...(typeof source.strict === 'boolean' ? { strict: source.strict } : {}),
      },
    });
  }

  private addCustom(tool: ResponsesCustomTool, namespace?: string): void {
    if (!tool.name?.trim()) return;
    const identity = responseToolIdentity('custom', tool.name, namespace);
    const chatName = this.reserveName(namespace ? `${namespace}__${tool.name}` : tool.name, identity);
    if (this.specsByChatName.has(chatName)) return;
    const spec: ChatBridgeToolSpec = {
      kind: 'custom',
      chatName,
      name: tool.name,
      ...(namespace ? { namespace } : {}),
    };
    this.specsByChatName.set(chatName, spec);
    this.chatNamesByResponseName.set(identity, chatName);
    this.chatToolsValue.push({
      type: 'function',
      function: {
        name: chatName,
        description: tool.description
          ? `${tool.description}\n\n${stableToolDescription(tool)}`
          : stableToolDescription(tool),
        parameters: {
          type: 'object',
          properties: {
            input: {
              type: 'string',
              description: CUSTOM_TOOL_INPUT_DESCRIPTION,
            },
          },
          required: ['input'],
        },
      },
    });
  }

  private addToolSearch(): void {
    const identity = responseToolIdentity('tool_search', TOOL_SEARCH_CHAT_NAME);
    const chatName = this.reserveName(TOOL_SEARCH_CHAT_NAME, identity);
    if (this.specsByChatName.has(chatName)) return;
    const spec: ChatBridgeToolSpec = {
      kind: 'tool_search',
      chatName,
      name: TOOL_SEARCH_CHAT_NAME,
    };
    this.specsByChatName.set(chatName, spec);
    this.chatNamesByResponseName.set(identity, chatName);
    this.chatToolsValue.push({
      type: 'function',
      function: {
        name: chatName,
        description: 'Search and load Codex tools, plugins, connectors, and MCP namespaces.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query for tools or connectors to load.' },
            limit: { type: 'integer', description: 'Maximum number of tool groups to return.' },
          },
          required: ['query'],
        },
      },
    });
  }

  private addNamespace(tool: ResponsesNamespaceTool): void {
    if (!tool.name?.trim()) return;
    for (const child of tool.tools ?? tool.children ?? []) {
      if (!isPlainObject(child) || typeof child.name !== 'string') continue;
      if (child.type === 'function') this.addFunction(child as unknown as ResponsesFunctionTool, tool.name);
      if (child.type === 'custom') this.addCustom(child as unknown as ResponsesCustomTool, tool.name);
    }
  }

  private addResponseTool(tool: ResponseTool): void {
    if (typeof tool === 'string') {
      this.addCustom({ type: 'custom', name: tool });
      return;
    }
    if (!isPlainObject(tool)) return;
    if (tool.type === 'function') this.addFunction(tool as unknown as ResponsesFunctionTool);
    if (tool.type === 'custom') this.addCustom(tool as unknown as ResponsesCustomTool);
    if (tool.type === 'tool_search') this.addToolSearch();
    if (tool.type === 'namespace') this.addNamespace(tool as unknown as ResponsesNamespaceTool);
  }

  private collectHistoryTools(input: ResponsesRequest['input']): void {
    if (!Array.isArray(input)) return;
    for (const item of input) {
      if (!isPlainObject(item)) continue;
      if (item.type === 'tool_search_call') this.addToolSearch();
      if (item.type === 'custom_tool_call' && typeof item.name === 'string') {
        this.addCustom(
          { type: 'custom', name: item.name },
          typeof item.namespace === 'string' ? item.namespace : undefined,
        );
      }
      if (
        (item.type === 'tool_search_output' || item.type === 'tool_search_call_output')
        && Array.isArray(item.tools)
      ) {
        for (const tool of item.tools) {
          this.addResponseTool(tool as ResponseTool);
        }
      }
    }
  }
}
