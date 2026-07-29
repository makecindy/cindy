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

export interface ChatBridgeToolSpec {
  kind: ChatBridgeToolKind;
  chatName: string;
  name: string;
  namespace?: string;
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
    context.collectToolSearchTools(request.input);
    return context;
  }

  get chatTools(): ChatCompletionsRequest['tools'] {
    return this.chatToolsValue.length > 0 ? this.chatToolsValue : undefined;
  }

  lookupChatName(chatName: string): ChatBridgeToolSpec | undefined {
    return this.specsByChatName.get(chatName);
  }

  chatNameForResponse(name: string, namespace?: string): string {
    return this.chatNamesByResponseName.get(`${namespace ?? ''}\0${name}`)
      ?? clampChatToolName(namespace ? `${namespace}__${name}` : name);
  }

  private reserveName(preferred: string, identity: string): string {
    const clamped = clampChatToolName(preferred);
    const existing = this.specsByChatName.get(clamped);
    if (!existing) return clamped;
    if (`${existing.namespace ?? ''}\0${existing.name}` === identity) return clamped;
    const suffix = `__${shortHash(identity)}`;
    return `${clamped.slice(0, CHAT_TOOL_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
  }

  private addFunction(tool: ResponsesFunctionTool, namespace?: string): void {
    const nested = isPlainObject((tool as unknown as Record<string, unknown>).function)
      ? (tool as unknown as Record<string, unknown>).function
      : undefined;
    const source = nested ? { ...tool, ...nested } as ResponsesFunctionTool : tool;
    if (!source.name?.trim()) return;
    const identity = `${namespace ?? ''}\0${source.name}`;
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
    const identity = `${namespace ?? ''}\0${tool.name}`;
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
    if (this.specsByChatName.has(TOOL_SEARCH_CHAT_NAME)) return;
    const spec: ChatBridgeToolSpec = {
      kind: 'tool_search',
      chatName: TOOL_SEARCH_CHAT_NAME,
      name: TOOL_SEARCH_CHAT_NAME,
    };
    this.specsByChatName.set(TOOL_SEARCH_CHAT_NAME, spec);
    this.chatNamesByResponseName.set(`\0${TOOL_SEARCH_CHAT_NAME}`, TOOL_SEARCH_CHAT_NAME);
    this.chatToolsValue.push({
      type: 'function',
      function: {
        name: TOOL_SEARCH_CHAT_NAME,
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

  private collectToolSearchTools(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) this.collectToolSearchTools(item);
      return;
    }
    if (!isPlainObject(value)) return;
    if (value.type === 'tool_search_call') this.addToolSearch();
    if (value.type === 'custom_tool_call' && typeof value.name === 'string') {
      this.addCustom({ type: 'custom', name: value.name });
    }
    if (value.type === 'tool_search_output' || value.type === 'tool_search_call_output') {
      if (Array.isArray(value.tools)) {
        for (const tool of value.tools) {
          this.addResponseTool(tool as ResponseTool);
        }
      }
    }
    for (const child of Object.values(value)) this.collectToolSearchTools(child);
  }
}
