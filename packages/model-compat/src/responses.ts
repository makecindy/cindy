import { stripCanonicalOnlyToolFields } from './upstream/adapters/openai-responses';
import type { ResponsesItemIdRepairConfig } from './upstream/types/provider';
import { createResponsesItemIdPayloadRewrite, repairResponsesJsonItemIds } from './upstream/server/responses-item-id-repair';
import { createResponsesSnapshotBlockRewrite, repairResponsesSnapshotJson } from './upstream/server/responses-snapshot-repair';
import { createReasoningSummaryChannelPayloadRewrite, rewriteReasoningSummaryInJsonString } from './upstream/server/responses-reasoning-summary-rewrite';
import { collectSelfNamedNamespaceScrubAuthorization, createSelfNamedToolCallNamespaceScrubRewrite, scrubSelfNamedToolCallNamespaceInJson } from './upstream/server/responses-self-named-namespace-scrub';
import { Transform, type TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { rewriteRoutedCustomToolsForUpstream, restoreRoutedCustomCallsInJson } from './upstream/responses/custom-tool-compat';
import { rewriteRoutedNamespaceToolsForUpstream, restoreRoutedNamespaceCallsInJson, collectBareCustomToolNames } from './upstream/responses/namespace-tool-compat';
import { collectResponsesToolGroups } from './upstream/responses/tool-groups';
import { rewriteRoutedToolSearchForUpstream, restoreRoutedToolSearchCallsInJson } from './upstream/responses/tool-search-compat';
import { collectFunctionCallRepairSchemas, deriveFunctionCallRepairPlan, hasDeclaredNamespacedFunction, repairFunctionCallsInJson } from './upstream/responses/function-call-compat';
import { createRoutedCustomToolRestoreBlockRewrite } from './upstream/server/responses-custom-tool-repair';
import { createRoutedToolSearchRestoreBlockRewrite } from './upstream/server/responses-tool-search-repair';
import { createResponsesFunctionToolRepairBlockRewrite } from './upstream/server/responses-function-tool-repair';
import { createResponsesFieldBackfillBlockRewrite, backfillResponsesFieldsJson } from './upstream/server/responses/responses-field-backfill';
import { createTranslatorBudget } from './upstream/lib/translator-budget';
import { collectDeclaredWireToolNames } from './upstream/server/responses-undeclared-tool-guard';
import { composeSseBlockRewrites, payloadRewriteAsBlockRewrite, nextSseBlock, type SseBlockRewrite } from './upstream/server/sse-payload-rewrite';
import { isPlainObject } from './object';
import { collectCurrentToolSearchGroups, indexOfCurrentTurnInlineTools } from './cindy/tool-context';

/** Wire names of custom declarations that live inside a namespace group, before lowering rewrites them. */
function collectNamespaceCustomToolNames(body: unknown): Set<string> {
  const names = new Set<string>();
  if (!body || typeof body !== 'object' || Array.isArray(body)) return names;
  for (const group of collectResponsesToolGroups(body)) {
    if (!Array.isArray(group)) continue;
    for (const tool of group) {
      if (!tool || typeof tool !== 'object') continue;
      const { type, name, tools } = tool as { type?: unknown; name?: unknown; tools?: unknown };
      if (type !== 'namespace' || typeof name !== 'string' || name === 'functions' || !Array.isArray(tools)) continue;
      for (const child of tools) {
        if (!child || typeof child !== 'object') continue;
        const { type: childType, name: childName } = child as { type?: unknown; name?: unknown };
        if (childType !== 'custom' || typeof childName !== 'string') continue;
        names.add(`${name}__${childName}`);
      }
    }
  }
  return names;
}

type NativeTool = { type: string; name: string; namespace?: string };

function collectNativeToolSelectors(body: unknown) {
  const bare = new Map<string, NativeTool | null>();
  const groupedBare = new Map<string, NativeTool | null>();
  const namespaced = new Map<string, NativeTool | null>();
  const historical = new Map<string, NativeTool | null>();
  const loadedBare = new Map<string, NativeTool | null>();
  const record = (catalog: Map<string, NativeTool | null>, key: string, tool: NativeTool) => {
    const previous = catalog.get(key);
    if (previous === undefined) catalog.set(key, tool);
    else if (previous && (previous.type !== tool.type || previous.name !== tool.name || previous.namespace !== tool.namespace)) {
      catalog.set(key, null);
    }
  };
  const groups: { tools: unknown[]; live: boolean }[] = [];
  if (isPlainObject(body)) {
    if (Array.isArray(body.tools)) groups.push({ tools: body.tools, live: true });
    const inline = Array.isArray(body.input) ? body.input[indexOfCurrentTurnInlineTools(body.input)] : undefined;
    if (isPlainObject(inline) && Array.isArray(inline.tools)) groups.push({ tools: inline.tools, live: true });
    for (const tools of collectCurrentToolSearchGroups(body.input)) groups.push({ tools, live: false });
  }
  for (const { tools, live } of groups) {
    for (const tool of tools) {
      if (!isPlainObject(tool) || typeof tool.name !== 'string' || typeof tool.type !== 'string') continue;
      if (tool.type !== 'namespace') {
        record(live ? bare : loadedBare, tool.name, { type: tool.type, name: tool.name });
      } else if (Array.isArray(tool.tools)) {
        for (const child of tool.tools) {
          if (!isPlainObject(child) || typeof child.name !== 'string' || typeof child.type !== 'string') continue;
          if (tool.name === 'functions') {
            record(live ? groupedBare : loadedBare, child.name, { type: child.type, name: child.name });
          } else {
            record(live ? namespaced : historical, `${tool.name}__${child.name}`, { type: child.type, name: child.name, namespace: tool.name });
          }
        }
      }
    }
  }
  for (const [name, tool] of groupedBare) {
    if (!bare.has(name)) bare.set(name, tool);
  }
  for (const [name, tool] of loadedBare) {
    if (!bare.has(name)) bare.set(name, tool);
  }
  for (const [name, tool] of historical) {
    if (!namespaced.has(name)) namespaced.set(name, tool);
  }
  return { bare, namespaced };
}

function disambiguateNativeToolChoice(original: unknown, forwarded: unknown, loweredCustom: unknown): unknown {
  if (!isPlainObject(original) || !isPlainObject(forwarded)) return forwarded;
  const before = original.tool_choice;
  const after = forwarded.tool_choice;
  if (!isPlainObject(before) || !isPlainObject(after)) return forwarded;
  const originalTools = collectNativeToolSelectors(original);
  // Search lowering serializes discovered declarations into a tool-result string.
  const forwardedTools = collectNativeToolSelectors(loweredCustom);
  const select = (selector: unknown, lowered: unknown): unknown => {
    if (!isPlainObject(selector) || !isPlainObject(lowered) || 'namespace' in selector
      || (selector.type !== 'function' && selector.type !== 'custom') || typeof selector.name !== 'string') return lowered;
    const bare = originalTools.bare.get(selector.name);
    const child = originalTools.namespaced.get(selector.name);
    const outgoingBare = forwardedTools.bare.get(selector.name);
    const outgoingChild = forwardedTools.namespaced.get(selector.name);
    if (!bare || !child || !outgoingBare || !outgoingChild || child.type !== selector.type
      || bare.type !== (selector.type === 'function' ? 'custom' : 'function')
      || (lowered.type === selector.type && outgoingBare.type === bare.type && outgoingChild.type === child.type)) return lowered;
    return { ...lowered, ...outgoingChild };
  };
  if (before.type === 'allowed_tools' && after.type === 'allowed_tools'
    && Array.isArray(before.tools) && Array.isArray(after.tools)) {
    const originalSelectors = before.tools;
    const forwardedSelectors = after.tools;
    const tools = forwardedSelectors.map((tool, index) => select(originalSelectors[index], tool));
    return tools.some((tool, index) => tool !== forwardedSelectors[index])
      ? { ...forwarded, tool_choice: { ...after, tools } } : forwarded;
  }
  const toolChoice = select(before, after);
  return toolChoice === after ? forwarded : { ...forwarded, tool_choice: toolChoice };
}

/** Selected from the actual route; native OpenAI and non-Responses traffic do not enter this adapter. */
export interface ResponsesCompatibilityPolicy {
  customTools?: 'native' | 'functions' | 'preserve-apply-patch';
  namespaceTools?: 'native' | 'functions';
  toolSearch?: 'native' | 'function';
  repairFunctionArguments?: boolean;
  backfillResponseFields?: boolean;
  itemIdRepair?: ResponsesItemIdRepairConfig;
  snapshotRepair?: boolean;
  contentChannelReasoning?: boolean;
}

/** One request owns both forward conversion and reverse tool identities. */
export function prepareResponsesCompatibility(body: unknown, policy: ResponsesCompatibilityPolicy) {
  const input = isPlainObject(body) ? body.input : undefined;
  const currentInlineIndex = indexOfCurrentTurnInlineTools(input);
  // Keep replayed declarations on the wire, but do not use their types to classify current calls.
  const catalog = isPlainObject(body) && Array.isArray(input) && currentInlineIndex >= 0
    ? { ...body, input: input.filter((item, index) => index === currentInlineIndex || !isPlainObject(item) || item.type !== 'additional_tools') }
    : body;
  const bareCustomNames = collectBareCustomToolNames(catalog);
  const custom = policy.customTools && policy.customTools !== 'native'
    ? rewriteRoutedCustomToolsForUpstream(body, policy.customTools === 'functions' ? false : undefined, catalog)
    : { body, names: new Set<string>(), repairNames: new Set<string>() };
  const search = policy.toolSearch === 'function'
    ? rewriteRoutedToolSearchForUpstream(custom.body)
    : { body: custom.body, names: new Set<string>() };
  const namespace = policy.namespaceTools === 'functions'
    ? rewriteRoutedNamespaceToolsForUpstream(search.body, custom.names, bareCustomNames, collectNamespaceCustomToolNames(catalog),
        body && typeof body === 'object' ? (body as { tool_choice?: unknown }).tool_choice : undefined, currentInlineIndex)
    : {
        body: custom.body !== body ? disambiguateNativeToolChoice(body, search.body, custom.body) : search.body,
        aliases: new Map(), renamedWireNames: new Map<string, string>(), renamedKinds: new Map<string, 'function' | 'custom'>(),
      };
  // Native requests retain their declarations, but response restoration and schema lookup still
  // need one collision-safe identity plan, including original kinds and loaded search tools.
  const repairPlan = policy.repairFunctionArguments && policy.namespaceTools !== 'functions'
    ? deriveFunctionCallRepairPlan(catalog)
    : {
        renamedWireNames: namespace.renamedWireNames,
        renamedKinds: namespace.renamedKinds,
        loweredToolChoice: namespace.body && typeof namespace.body === 'object'
          ? (namespace.body as { tool_choice?: unknown }).tool_choice
          : undefined,
      };
  const displacedKinds = repairPlan.renamedKinds;
  const schemas = collectFunctionCallRepairSchemas(policy.repairFunctionArguments ? body : undefined, repairPlan, currentInlineIndex);
  const displacement = displacedKinds.size > 0 || (custom.names.size > 0 && schemas.namespacedFunctions.size > 0)
    ? {
        bareCustomNames, displacedKinds,
        isDeclaredNamespacedFunction: (namespace: string, name: string) => hasDeclaredNamespacedFunction(schemas, namespace, name),
      }
    : undefined;
  const declared = collectDeclaredWireToolNames(body);
  const bareFunctionNames = new Set<string>();
  for (const schema of schemas.byIdentity.values()) {
    if (!schema.namespace) bareFunctionNames.add(schema.name);
  }
  const scrubAuthorization = collectSelfNamedNamespaceScrubAuthorization(catalog, new Set([...custom.names, ...custom.repairNames]), bareFunctionNames);
  const restoreNamespace = (text: string) => restoreRoutedNamespaceCallsInJson(text, namespace.aliases);
  return {
    body: policy.namespaceTools === 'functions' ? stripCanonicalOnlyToolFields(namespace.body, false) : namespace.body,
    needsResponseTransform: Boolean(policy.itemIdRepair || policy.snapshotRepair || policy.contentChannelReasoning) || custom.names.size > 0 || custom.repairNames.size > 0 || search.names.size > 0 || namespace.aliases.size > 0 || schemas.byIdentity.size > 0 || policy.backfillResponseFields === true,
    restoreJson(text: string): string {
      let next = restoreNamespace(scrubSelfNamedToolCallNamespaceInJson(text, scrubAuthorization));
      if (policy.itemIdRepair) {
        const parsed: unknown = JSON.parse(next);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) next = JSON.stringify(repairResponsesJsonItemIds(parsed as Record<string, unknown>, policy.itemIdRepair));
      }
      if (policy.snapshotRepair) next = repairResponsesSnapshotJson(next, body);
      if (policy.contentChannelReasoning) next = rewriteReasoningSummaryInJsonString(next);
      next = restoreRoutedCustomCallsInJson(next, custom.names, custom.repairNames, declared, displacement);
      next = restoreRoutedToolSearchCallsInJson(next, search.names);
      next = repairFunctionCallsInJson(next, schemas);
      return policy.backfillResponseFields ? backfillResponsesFieldsJson(next) : next;
    },
    createStreamRewrite() {
      const budget = createTranslatorBudget();
      const stages: SseBlockRewrite[] = [
        payloadRewriteAsBlockRewrite(createSelfNamedToolCallNamespaceScrubRewrite(scrubAuthorization)),
        payloadRewriteAsBlockRewrite(restoreNamespace),
        createRoutedCustomToolRestoreBlockRewrite(custom.names, budget, custom.repairNames, declared, displacement),
        createRoutedToolSearchRestoreBlockRewrite(search.names, budget),
        createResponsesFunctionToolRepairBlockRewrite(schemas, budget),
      ];
      // Transport/id reconstruction precedes tool completion; all stages share one budget.
      const before: SseBlockRewrite[] = [];
      if (policy.itemIdRepair) before.push(payloadRewriteAsBlockRewrite(createResponsesItemIdPayloadRewrite(policy.itemIdRepair, budget)));
      if (policy.snapshotRepair) before.push(createResponsesSnapshotBlockRewrite(body, budget));
      if (policy.contentChannelReasoning) before.push(payloadRewriteAsBlockRewrite(createReasoningSummaryChannelPayloadRewrite()));
      stages.unshift(...before);
      if (policy.backfillResponseFields) stages.push(createResponsesFieldBackfillBlockRewrite());
      const rewrite = composeSseBlockRewrites(...stages);
      const dispose = rewrite.dispose;
      rewrite.dispose = () => { dispose?.(); budget.dispose(); };
      return rewrite;
    },
  };
}

type Prepared = ReturnType<typeof prepareResponsesCompatibility>;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/** Node transport shell only; the vendored upstream owns protocol rewrites and bounded collectors. */
class CompatibilityResponseTransform extends Transform {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private readonly rewrite: SseBlockRewrite | undefined;
  constructor(private readonly prepared: Prepared, private readonly sse: boolean) {
    super();
    if (sse) this.rewrite = prepared.createStreamRewrite();
  }
  private drain(final = false): void {
    if (this.sse) {
      let frame;
      while ((frame = nextSseBlock(this.buffer))) {
        if (Buffer.byteLength(frame.block) > MAX_RESPONSE_BYTES) throw new Error('model compatibility response buffer exceeded');
        this.buffer = frame.rest;
        for (const block of this.rewrite!(frame.block)) this.push(block + frame.delimiter);
      }
      if (final && this.buffer) {
        if (Buffer.byteLength(this.buffer) > MAX_RESPONSE_BYTES) throw new Error('model compatibility response buffer exceeded');
        for (const block of this.rewrite!(this.buffer)) this.push(block + '\n\n');
        this.buffer = '';
      }
    } else if (final) {
      if (Buffer.byteLength(this.buffer) > MAX_RESPONSE_BYTES) throw new Error('model compatibility response buffer exceeded');
      this.push(this.prepared.restoreJson(this.buffer));
      this.buffer = '';
    }
    if (Buffer.byteLength(this.buffer) > MAX_RESPONSE_BYTES) throw new Error('model compatibility response buffer exceeded');
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try { this.buffer += this.decoder.write(chunk); this.drain(); callback(); }
    catch (error) { callback(error as Error); }
  }
  override _flush(callback: TransformCallback): void {
    try { this.buffer += this.decoder.end(); this.drain(true); callback(); }
    catch (error) { callback(error as Error); }
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.buffer = '';
    this.rewrite?.dispose?.();
    callback(error);
  }
}

/** Retains only in-flight reverse mappings; callers release on every settled request, including errors. */
export function createResponsesCompatibilityAdapter(policy: ResponsesCompatibilityPolicy) {
  const pending = new Map<number, { prepared: Prepared; at: number }>();
  return {
    adaptRequest(body: unknown, requestId: number, overrides: ResponsesCompatibilityPolicy = {}): unknown | null {
      pending.delete(requestId);
      const now = Date.now();
      for (const [id, entry] of pending) if (now - entry.at >= 15 * 60_000) pending.delete(id);
      if (!pending.has(requestId) && pending.size >= 256) throw new Error('too many in-flight compatibility requests');
      const prepared = prepareResponsesCompatibility(body, { ...policy, ...overrides });
      if (prepared.needsResponseTransform) pending.set(requestId, { prepared, at: now });
      return prepared.body === body ? null : prepared.body;
    },
    releaseResponse(requestId: number): void { pending.delete(requestId); },
    createResponseTransform(requestId: number, response: { contentType: string; contentEncoding: string }): Transform | null {
      const entry = pending.get(requestId);
      pending.delete(requestId);
      if (!entry) return null;
      const encoding = response.contentEncoding.trim().toLowerCase();
      if (encoding && encoding !== 'identity') throw new Error('compressed compatibility response cannot be rewritten');
      const type = response.contentType.toLowerCase();
      const sse = type.startsWith('text/event-stream');
      if (!sse && !type.includes('application/json')) throw new Error('unsupported compatibility response content type');
      return new CompatibilityResponseTransform(entry.prepared, sse);
    },
  };
}
