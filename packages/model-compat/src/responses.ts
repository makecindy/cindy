import { stripCanonicalOnlyToolFields } from './upstream/adapters/openai-responses';
import type { ResponsesItemIdRepairConfig } from './upstream/types/provider';
import { createResponsesItemIdPayloadRewrite, repairResponsesJsonItemIds } from './upstream/server/responses-item-id-repair';
import { createResponsesSnapshotBlockRewrite, repairResponsesSnapshotJson } from './upstream/server/responses-snapshot-repair';
import { createReasoningSummaryChannelPayloadRewrite, rewriteReasoningSummaryInJsonString } from './upstream/server/responses-reasoning-summary-rewrite';
import { collectSelfNamedNamespaceScrubAuthorization, createSelfNamedToolCallNamespaceScrubRewrite, scrubSelfNamedToolCallNamespaceInJson } from './upstream/server/responses-self-named-namespace-scrub';
import { Transform, type TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { rewriteRoutedCustomToolsForUpstream, restoreRoutedCustomCallsInJson } from './upstream/responses/custom-tool-compat';
import { rewriteRoutedNamespaceToolsForUpstream, restoreRoutedNamespaceCallsInJson } from './upstream/responses/namespace-tool-compat';
import { rewriteRoutedToolSearchForUpstream, restoreRoutedToolSearchCallsInJson } from './upstream/responses/tool-search-compat';
import { collectFunctionCallRepairSchemas, repairFunctionCallsInJson } from './upstream/responses/function-call-compat';
import { createRoutedCustomToolRestoreBlockRewrite } from './upstream/server/responses-custom-tool-repair';
import { createRoutedToolSearchRestoreBlockRewrite } from './upstream/server/responses-tool-search-repair';
import { createResponsesFunctionToolRepairBlockRewrite } from './upstream/server/responses-function-tool-repair';
import { createResponsesFieldBackfillBlockRewrite, backfillResponsesFieldsJson } from './upstream/server/responses/responses-field-backfill';
import { createTranslatorBudget } from './upstream/lib/translator-budget';
import { collectDeclaredWireToolNames } from './upstream/server/responses-undeclared-tool-guard';
import { composeSseBlockRewrites, payloadRewriteAsBlockRewrite, nextSseBlock, type SseBlockRewrite } from './upstream/server/sse-payload-rewrite';

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
  const custom = policy.customTools && policy.customTools !== 'native'
    ? rewriteRoutedCustomToolsForUpstream(body, policy.customTools === 'functions' ? false : undefined)
    : { body, names: new Set<string>(), repairNames: new Set<string>() };
  const search = policy.toolSearch === 'function'
    ? rewriteRoutedToolSearchForUpstream(custom.body)
    : { body: custom.body, names: new Set<string>() };
  const namespace = policy.namespaceTools === 'functions'
    ? rewriteRoutedNamespaceToolsForUpstream(search.body, custom.names)
    : { body: search.body, aliases: new Map() };
  const schemas = policy.repairFunctionArguments ? collectFunctionCallRepairSchemas(body) : new Map();
  const declared = collectDeclaredWireToolNames(body);
  const scrubAuthorization = collectSelfNamedNamespaceScrubAuthorization(body, new Set([...custom.names, ...custom.repairNames]), new Set(schemas.keys()));
  const restoreNamespace = (text: string) => restoreRoutedNamespaceCallsInJson(text, namespace.aliases);
  return {
    body: policy.namespaceTools === 'functions' ? stripCanonicalOnlyToolFields(namespace.body, false) : namespace.body,
    needsResponseTransform: Boolean(policy.itemIdRepair || policy.snapshotRepair || policy.contentChannelReasoning) || custom.names.size > 0 || custom.repairNames.size > 0 || search.names.size > 0 || namespace.aliases.size > 0 || schemas.size > 0 || policy.backfillResponseFields === true,
    restoreJson(text: string): string {
      let next = restoreNamespace(scrubSelfNamedToolCallNamespaceInJson(text, scrubAuthorization));
      if (policy.itemIdRepair) {
        const parsed: unknown = JSON.parse(next);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) next = JSON.stringify(repairResponsesJsonItemIds(parsed as Record<string, unknown>, policy.itemIdRepair));
      }
      if (policy.snapshotRepair) next = repairResponsesSnapshotJson(next, body);
      if (policy.contentChannelReasoning) next = rewriteReasoningSummaryInJsonString(next);
      next = restoreRoutedCustomCallsInJson(next, custom.names, custom.repairNames, declared);
      next = restoreRoutedToolSearchCallsInJson(next, search.names);
      next = repairFunctionCallsInJson(next, schemas);
      return policy.backfillResponseFields ? backfillResponsesFieldsJson(next) : next;
    },
    createStreamRewrite() {
      const budget = createTranslatorBudget();
      const stages: SseBlockRewrite[] = [
        payloadRewriteAsBlockRewrite(createSelfNamedToolCallNamespaceScrubRewrite(scrubAuthorization)),
        payloadRewriteAsBlockRewrite(restoreNamespace),
        createRoutedCustomToolRestoreBlockRewrite(custom.names, budget, custom.repairNames, declared),
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
