import { Buffer } from 'node:buffer';
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
// Codex groups ordinary tools under this reserved namespace; they are bare tools on every wire.
const BUILTIN_FUNCTIONS_NAMESPACE = 'functions';
// `exec` also switches on nested-helper normalization upstream, so it never answers a bare selector.
const CODE_MODE_EXEC_TOOL_NAME = 'exec';
const CUSTOM_TOOL_INPUT_DESCRIPTION =
  'Raw string input for the original custom tool. Preserve formatting exactly.';
const CUSTOM_EXEC_DESCRIPTION_MAX_BYTES = 32 * 1024;
const COMPACT_CUSTOM_EXEC_DESCRIPTION = [
  'Execute JavaScript in the Code Mode runtime. Pass the complete JavaScript source in `input`.',
  'Call tools on the global `tools` object with `await tools.<name>(...)`; namespace tools use',
  'the flattened `await tools.<namespace>__<name>(...)` form.',
  'Inspect `ALL_TOOLS` for available shell, patch, plugin, connector, and MCP tools.',
  'Use `yield_control()` to yield while execution continues, and `exit()` to stop early.',
  'Return user-visible output with `text(...)`, `image(...)`, `audio(...)`, or',
  '`generatedImage(...)`. Share serializable state across exec calls with `store(key, value)`',
  'and `load(key)`, and report progress with `notify(value)`.',
].join(' ');

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

/**
 * Fit a Responses tool identity into the strict Chat function-name alphabet.
 *
 * Dots are legal in Responses namespace identities (`mcp.server`), but a Chat function name may
 * only carry letters, digits, `_` and `-`, and no provider accepts a longer name than 64. A
 * rejected name fails the whole turn, so map anything else to a hash suffix; the spec stored on
 * the context keeps the response side reversible.
 */
function clampChatToolName(name: string): string {
  const illegal = /[^A-Za-z0-9_-]/.test(name);
  if (!illegal && name.length <= CHAT_TOOL_NAME_MAX_LENGTH) return name;
  const suffix = `__${shortHash(name)}`;
  const head = illegal ? name.replace(/[^A-Za-z0-9_-]/g, '_') : name;
  return `${head.slice(0, CHAT_TOOL_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
}

function normalizeFunctionParameters(parameters: unknown): Record<string, unknown> {
  if (!isPlainObject(parameters)) return { type: 'object', properties: {} };
  return parameters.type === 'object'
    ? { ...parameters }
    : { ...parameters, type: 'object' };
}

function stableToolDescription(tool: ResponsesCustomTool): string {
  const metadata: Record<string, unknown> = { ...tool };
  delete metadata.description;
  try {
    return `Original Responses custom tool metadata:\n${JSON.stringify(metadata)}`;
  } catch {
    return 'Original Responses custom tool metadata is unavailable.';
  }
}

function chatCustomToolDescription(tool: ResponsesCustomTool, namespace?: string): string {
  const metadata = stableToolDescription(tool);
  // Untrusted JSON: a non-string description would make Buffer.byteLength throw, and the
  // handler only maps UnsupportedResponsesFeatureError to a 400. Fall back to metadata.
  if (typeof tool.description !== 'string') return metadata;
  if (!tool.description) return metadata;
  const description = namespace === undefined
    && tool.name === 'exec'
    && Buffer.byteLength(tool.description, 'utf8') > CUSTOM_EXEC_DESCRIPTION_MAX_BYTES
    ? COMPACT_CUSTOM_EXEC_DESCRIPTION
    : tool.description;
  return `${description}\n\n${metadata}`;
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

/**
 * Position of the `additional_tools` group that belongs to this turn.
 *
 * Codex appends the current turn's declarations last; earlier groups are replayed history that
 * must stay reachable for the provider but must not grant new tools.
 */
function indexOfCurrentTurnInlineTools(input: ResponsesRequest['input']): number {
  if (!Array.isArray(input)) return -1;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (isPlainObject(item) && item.type === 'additional_tools' && Array.isArray(item.tools)) {
      return index;
    }
  }
  return -1;
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
  /** Current-turn bare selector -> Chat name; null means the bare name is ambiguous. */
  private readonly currentSelectors = new Map<string, string | null>();
  /** Bare declarations only; a reserved `functions` selector may match just these. */
  private readonly currentBareSelectors = new Map<string, string>();
  /** Exact identities of this turn's declarations, for kind-aware selector resolution. */
  private readonly currentIdentities = new Map<string, string>();

  static fromRequest(request: ResponsesRequest): ChatBridgeToolContext {
    const context = new ChatBridgeToolContext();
    // Top-level tools always belong to this request, and the inline group that belongs to this
    // turn is known up front. Snapshot them first so the rest of collectHistoryTools (replay) can
    // never contribute a selector.
    for (const tool of request.tools ?? []) context.addResponseTool(tool);
    context.addCurrentInlineTools(request.input);
    // `tool_search_output` loads definitions into the current catalog, so a later turn may force
    // one by name. Register them before the snapshot: the reserved Chat name is only known after
    // reservation, so a predicted name could shadow or collide with a real declaration. The
    // tool_search adapter is reserved first to keep its established position in `tools`.
    context.addToolSearchForLoadedInput(request.input);
    context.addLoadedToolSearchTools(request.input);
    context.recordCurrentSelectors();
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

  /**
   * Resolve a `tool_choice` selector to the Chat name this turn actually declares.
   *
   * An unqualified selector may name a child of a namespaced group declared in this turn's
   * inline catalog. Resolve it only when exactly one catalogued tool carries that bare name:
   * two matches mean the caller must say which group it meant, so it stays unqualified.
   * Response restoration keeps using chatNameForResponse and is unaffected.
   */
  chatNameForToolChoice(
    name: string,
    namespace?: string,
    kind: ResponseToolIdentityKind = 'function',
  ): string {
    // The current-turn snapshot owns selector resolution: it knows every declaration this turn
    // made, so a name that only replayed history carries cannot become a forced selector, and a
    // name claimed by both a bare and a namespaced tool resolves to null (ambiguous).
    const selectorKind = kind === 'custom' ? 'custom' : 'function';
    // A reserved `functions` selector names an ordinary top-level tool, so it may only match a
    // declaration made directly, never a same-named child of another namespace.
    if (namespace === BUILTIN_FUNCTIONS_NAMESPACE) {
      const bareDecl = this.currentBareSelectors.get(`${selectorKind}\0${name}`);
      return clampChatToolName(bareDecl === undefined ? name : bareDecl);
    }
    const selectorName = namespace === undefined ? name : namespace + '.' + name;
    const recorded = this.currentSelectors.get(`${selectorKind}\0${selectorName}`);
    if (recorded) return recorded;
    // Only declarations this turn made may answer a selector, and only under the name the Chat
    // catalog actually advertises: the restoration map also holds replayed history and the raw
    // fallback can differ from the clamped wire name.
    const fallbackName = clampChatToolName(namespace === undefined ? name : `${namespace}__${name}`);
    const advertised = this.specsByChatName.get(fallbackName);
    // A different kind of tool may legitimately occupy the plain name; it keeps its reserved
    // wire name in the restoration map, so use only an entry this turn catalogued.
    const currentIdentity = this.currentIdentities.get(kind + '\0' + (namespace === undefined ? '' : namespace) + '\0' + name);
    if (advertised !== undefined && advertised.kind === selectorKind) return advertised.chatName;
    if (currentIdentity !== undefined) return currentIdentity;
    // A qualified selector this turn never declared keeps its namespace. Dropping to the bare
    // name would force a same-named tool the caller did not name; base and the canonical
    // lowering both send the flattened name and let the provider reject it.
    if (namespace !== undefined) return fallbackName;
    // A bare selector that this turn did not declare stays bare: `required`-style callers rely
    // on it being resolved only by an exact snapshot hit above.
    return clampChatToolName(name);
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
    // Malformed declarations arrive through untrusted JSON; skip them instead of throwing a
    // TypeError the handler does not translate into a 400.
    if (typeof source.name !== 'string' || source.name.trim().length === 0) return;
    // A non-string description would be forwarded as-is, and Chat types it as a string; drop it
    // rather than let a strict provider reject the whole request.
    if (source.description !== undefined && typeof source.description !== 'string') {
      delete (source as { description?: unknown }).description;
    }
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
    if (typeof tool.name !== 'string' || tool.name.trim().length === 0) return;
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
        description: chatCustomToolDescription(tool, namespace),
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
    if (typeof tool.name !== 'string' || tool.name.trim().length === 0) return;
    // The reserved functions namespace holds ordinary top-level tools; it has no wire prefix, so
    // its children are catalogued by bare name and restored without a namespace, matching the
    // upstream lowering and the undeclared-tool guard.
    const namespace = tool.name === BUILTIN_FUNCTIONS_NAMESPACE ? undefined : tool.name;
    // Untrusted JSON can put a non-array here; a raw TypeError would escape the handler, which
    // only maps UnsupportedResponsesFeatureError to a 400. Treat it as a malformed declaration.
    const children = tool.tools ?? tool.children;
    if (!Array.isArray(children)) return;
    for (const child of children) {
      if (!isPlainObject(child) || typeof child.name !== 'string') continue;
      if (child.type === 'function') this.addFunction(child as unknown as ResponsesFunctionTool, namespace);
      if (child.type === 'custom') this.addCustom(child as unknown as ResponsesCustomTool, namespace);
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

  /**
   * Snapshot the selectors this turn's own declarations may answer.
   *
   * Taken from the catalog after the current declarations are registered, so the snapshot names
   * are the ones actually advertised. Replayed history is excluded: a name that only appears
   * there must not become a forced selector.
   */
  private recordCurrentSelectors(): void {
    for (const [identity, chatName] of this.chatNamesByResponseName) {
      const [kind, namespace, name] = identity.split('\0');
      if (!name) continue;
      const identityKey = kind + '\0' + (namespace === undefined ? '' : namespace) + '\0' + name;
      this.currentIdentities.set(identityKey, chatName);
      if (!namespace) {
        this.recordCurrentSelector(kind, name, chatName);
        this.currentBareSelectors.set(kind + '\0' + name, chatName);
        continue;
      }
      // Codex accepts the bare child name, the dotted `namespace.name` spelling and the
      // flattened wire name. Index all of them with one ambiguity rule. `exec` keeps only the
      // qualified spellings: a bare `exec` switches on upstream nested-helper normalization.
      if (name !== CODE_MODE_EXEC_TOOL_NAME) this.recordCurrentSelector(kind, name, chatName);
      this.recordCurrentSelector(kind, namespace + '.' + name, chatName);
      this.recordCurrentSelector(kind, `${namespace}__${name}`, chatName);
    }
  }

  private recordCurrentSelector(kind: string, selector: string, chatName: string): void {
    const key = kind + '\0' + selector;
    const existing = this.currentSelectors.get(key);
    this.currentSelectors.set(key, existing === undefined || existing === chatName ? chatName : null);
  }

/** Reserve the tool_search adapter ahead of the definitions it carries. */
  private addToolSearchForLoadedInput(input: ResponsesRequest['input']): void {
    if (!Array.isArray(input)) return;
    const boundary = indexOfCurrentTurnInlineTools(input);
    for (let index = 0; index < input.length; index += 1) {
      const item = input[index];
      if (!isPlainObject(item)) continue;
      if (item.type !== 'tool_search_call') continue;
      if (boundary >= 0 && index < boundary) continue;
      this.addToolSearch();
      return;
    }
  }
  private addLoadedToolSearchTools(input: ResponsesRequest['input']): void {
    if (!Array.isArray(input)) return;
    const boundary = indexOfCurrentTurnInlineTools(input);
    for (let index = 0; index < input.length; index += 1) {
      const item = input[index];
      if (!isPlainObject(item)) continue;
      if (item.type !== 'tool_search_output' && item.type !== 'tool_search_call_output') continue;
      const loaded = item.tools;
      if (!Array.isArray(loaded)) continue;
      if (boundary >= 0 && index < boundary) continue;
      for (const tool of loaded) this.addResponseTool(tool as ResponseTool);
    }
  }
  private addCurrentInlineTools(input: ResponsesRequest['input']): void {
    if (!Array.isArray(input)) return;
    const index = indexOfCurrentTurnInlineTools(input);
    if (index < 0) return;
    const declared = (input[index] as { tools?: unknown }).tools;
    if (!Array.isArray(declared)) return;
    for (const tool of declared) this.addResponseTool(tool as ResponseTool);
  }

  private collectHistoryTools(input: ResponsesRequest['input']): void {
    if (!Array.isArray(input)) return;
    const currentBoundary = indexOfCurrentTurnInlineTools(input);
    for (let index = 0; index < input.length; index += 1) {
      const item = input[index];
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
        // Current-turn outputs were registered before the snapshot; only replay reaches here.
        if (currentBoundary >= 0 && index < currentBoundary) {
          for (const tool of item.tools) this.addResponseTool(tool as ResponseTool);
        }
      }
    }
  }

}

