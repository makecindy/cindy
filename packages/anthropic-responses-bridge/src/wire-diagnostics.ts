import { createHash } from 'node:crypto';

import type {
  AnthropicMessagesRequest,
  AnthropicTool,
  BridgeLogger,
  ResponsesRequest,
} from './types.js';
import type { AnthropicSseEvent } from './translate-sse.js';

const MAX_ARGUMENT_BYTES = 256 * 1024;
const MAX_HISTORY_TOOL_USES = 24;
const MAX_SCHEMA_TOOLS = 128;

type JsonShape = 'undefined' | 'null' | 'string' | 'number' | 'boolean' | 'array' | 'object';

interface JsonTextSummary extends Record<string, unknown> {
  bytes: number;
  sha256: string;
  parsed: 'empty' | 'truncated' | 'invalid-json' | 'scalar' | 'array' | 'object';
  keys?: string[];
  types?: Record<string, JsonShape>;
  missingRequired?: string[];
  extraKeyCount?: number;
  extraKeysSha256?: string;
}

type ToolFieldSchema = Pick<ToolSchemaSummary, 'propertyKeys' | 'required'>;

interface ToolSchemaSummary {
  name: string;
  strict?: boolean;
  schemaSha256: string;
  propertyKeys: string[];
  required: string[];
  additionalProperties?: boolean;
}

interface ToolUseSummary {
  name: string;
  idSha256: string;
  input: Record<string, unknown>;
}

interface WireDiagnosticMeta {
  /** compat-proxy reqId; available on the local-handler context and shared across the wire. */
  requestId: number;
  /** bridge-local sequence, useful when reading logs from a handler without the proxy. */
  bridgeReqId: number;
  wireModel: string;
  realModel: string;
  providerPrefix: string;
  downstreamStreaming: boolean;
}

interface UpstreamCallState {
  outputIndex: number;
  name?: string;
  callIdSha256?: string;
  deltaArguments: string;
  deltaOverflow: boolean;
  argumentsDone?: string;
  itemArguments?: string;
  emitted: boolean;
}

interface DownstreamCallState {
  blockIndex: number;
  name?: string;
  idSha256?: string;
  arguments: string;
  overflow: boolean;
  emitted: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashJson(value: unknown): string {
  let serialized = '';
  try {
    serialized = JSON.stringify(value) ?? '';
  } catch {
    serialized = '<unserializable>';
  }
  return hashText(serialized);
}

function safeToolName(name: string | undefined, declaredTools: ReadonlyMap<string, unknown>): string {
  if (name === undefined) return '(missing)';
  return declaredTools.has(name) ? name : `(unrecognized:${hashText(name)})`;
}

function jsonShape(value: unknown): JsonShape {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string': return 'string';
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'object': return 'object';
    default: return 'undefined';
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').sort()
    : [];
}

function schemaParts(schema: Record<string, unknown>): { propertyKeys: string[]; required: string[] } {
  const properties = asRecord(schema.properties);
  return {
    propertyKeys: Object.keys(properties).sort(),
    required: stringList(schema.required),
  };
}

function summarizeJsonObject(
  value: Record<string, unknown>,
  schema?: ToolFieldSchema,
): Pick<JsonTextSummary, 'keys' | 'types' | 'missingRequired' | 'extraKeyCount' | 'extraKeysSha256'> {
  const keys = Object.keys(value).sort();
  if (schema) {
    const known = new Set(schema.propertyKeys);
    const knownKeys = keys.filter((key) => known.has(key));
    const extraKeys = keys.filter((key) => !known.has(key));
    return {
      keys: knownKeys,
      types: Object.fromEntries(knownKeys.map((key) => [key, jsonShape(value[key])])),
      missingRequired: schema.required.filter(
        (key) => !Object.prototype.hasOwnProperty.call(value, key),
      ),
      ...(extraKeys.length > 0
        ? { extraKeyCount: extraKeys.length, extraKeysSha256: hashJson(extraKeys) }
        : {}),
    };
  }

  // No schema means no field names are safe to emit: the model controls every
  // key in the payload, so fail closed and retain only aggregate evidence.
  return {
    extraKeyCount: keys.length,
    ...(keys.length > 0 ? { extraKeysSha256: hashJson(keys) } : {}),
  };
}

function summarizeJsonText(
  raw: string,
  schema?: ToolFieldSchema,
): JsonTextSummary {
  const summary: JsonTextSummary = {
    bytes: Buffer.byteLength(raw, 'utf8'),
    sha256: hashText(raw),
    parsed: raw.length === 0 ? 'empty' : 'invalid-json',
  };
  if (summary.bytes > MAX_ARGUMENT_BYTES) {
    summary.parsed = 'truncated';
    return summary;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return summary;
  }
  if (Array.isArray(parsed)) {
    summary.parsed = 'array';
    return summary;
  }
  if (!isPlainObject(parsed)) {
    summary.parsed = 'scalar';
    return summary;
  }

  summary.parsed = 'object';
  return { ...summary, ...summarizeJsonObject(parsed, schema) };
}

function summarizeJsonValue(value: unknown, schema?: ToolFieldSchema): Record<string, unknown> {
  if (!isPlainObject(value)) return { parsed: jsonShape(value) };
  return { parsed: 'object', ...summarizeJsonObject(value, schema) };
}

function summarizeToolSchema(tool: AnthropicTool | Record<string, unknown>): ToolSchemaSummary | null {
  const rawTool = tool as Record<string, unknown>;
  const name = typeof rawTool.name === 'string' ? rawTool.name : '';
  if (!name) return null;
  const schema = isPlainObject(rawTool.input_schema)
    ? rawTool.input_schema
    : isPlainObject(rawTool.parameters)
      ? rawTool.parameters
      : {};
  const parts = schemaParts(schema);
  const additionalProperties = typeof schema.additionalProperties === 'boolean'
    ? schema.additionalProperties
    : undefined;
  return {
    name,
    ...(typeof rawTool.strict === 'boolean' ? { strict: rawTool.strict } : {}),
    schemaSha256: hashJson(schema),
    propertyKeys: parts.propertyKeys,
    required: parts.required,
    ...(additionalProperties === undefined ? {} : { additionalProperties }),
  };
}

function collectToolUses(
  req: AnthropicMessagesRequest,
  schemaByTool: ReadonlyMap<string, ToolFieldSchema>,
): { count: number; items: ToolUseSummary[] } {
  let count = 0;
  const items: ToolUseSummary[] = [];
  for (const message of req.messages ?? []) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isPlainObject(block) || block.type !== 'tool_use') continue;
      count += 1;
      if (items.length >= MAX_HISTORY_TOOL_USES) continue;
      const name = typeof block.name === 'string' ? block.name : undefined;
      items.push({
        name: safeToolName(name, schemaByTool),
        idSha256: typeof block.id === 'string' ? hashText(block.id) : hashText(''),
        input: summarizeJsonValue(
          block.input,
          schemaByTool.get(name ?? ''),
        ),
      });
    }
  }
  return { count, items };
}

function outputIndex(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : -1;
}

function appendBounded(current: string, next: string): { value: string; overflow: boolean } {
  const remaining = MAX_ARGUMENT_BYTES - Buffer.byteLength(current, 'utf8');
  if (remaining <= 0) return { value: current, overflow: true };
  const nextBytes = Buffer.byteLength(next, 'utf8');
  if (nextBytes <= remaining) return { value: current + next, overflow: false };
  return {
    value: current + Buffer.from(next, 'utf8').subarray(0, remaining).toString('utf8'),
    overflow: true,
  };
}

function summaryForCall(
  raw: string,
  schema: ToolFieldSchema | undefined,
  overflow = false,
): Record<string, unknown> {
  const summary = summarizeJsonText(raw, schema);
  return overflow ? { ...summary, parsed: 'truncated' } : summary;
}

function callKey(record: { name?: string; callIdSha256?: string; idSha256?: string }): string {
  return `${record.name ?? '(missing)'}:${record.callIdSha256 ?? record.idSha256 ?? ''}`;
}

/**
 * Opt-in, xAI/Grok-only wire probe. It deliberately logs shape and hashes rather than
 * arguments: the probe is useful for attribution without turning the agent log into a
 * second copy of prompts, paths, file contents, or credentials.
 */
export class WireDiagnosticsSession {
  private readonly requiredByTool = new Map<string, { required: string[]; propertyKeys: string[] }>();
  private readonly upstream = new Map<number, UpstreamCallState>();
  private readonly upstreamOrder: number[] = [];
  private readonly downstream = new Map<number, DownstreamCallState>();
  private readonly downstreamOrder: number[] = [];
  private finished = false;

  constructor(
    private readonly logger: BridgeLogger,
    private readonly meta: WireDiagnosticMeta,
  ) {}

  recordRequest(req: AnthropicMessagesRequest, responsesReq: ResponsesRequest): void {
    const requestTools = (req.tools ?? [])
      .map((tool) => summarizeToolSchema(tool))
      .filter((tool): tool is ToolSchemaSummary => tool !== null)
      .slice(0, MAX_SCHEMA_TOOLS);
    const responseTools = (responsesReq.tools ?? [])
      .map((tool) => summarizeToolSchema(tool as Record<string, unknown>))
      .filter((tool): tool is ToolSchemaSummary => tool !== null)
      .slice(0, MAX_SCHEMA_TOOLS);
    for (const tool of responseTools) {
      this.requiredByTool.set(tool.name, { required: tool.required, propertyKeys: tool.propertyKeys });
    }
    for (const tool of requestTools) {
      if (!this.requiredByTool.has(tool.name)) {
        this.requiredByTool.set(tool.name, { required: tool.required, propertyKeys: tool.propertyKeys });
      }
    }
    const history = collectToolUses(req, this.requiredByTool);
    this.emit('wire diagnostics: bridge request', {
      ...this.meta,
      historyToolUseCount: history.count,
      historyToolUses: history.items,
      anthropicTools: requestTools,
      responsesTools: responseTools,
      toolChoice: responsesReq.tool_choice ?? '(default)',
    });
  }

  recordUpstreamEvent(event: unknown): void {
    const record = asRecord(event);
    const type = typeof record.type === 'string' ? record.type : '';
    if (type === 'response.output_item.added') {
      const item = asRecord(record.item);
      if (item.type !== 'function_call') return;
      const state = this.getUpstream(outputIndex(record.output_index));
      state.name = typeof item.name === 'string' ? item.name : state.name;
      state.callIdSha256 = typeof item.call_id === 'string' ? hashText(item.call_id) : state.callIdSha256;
      return;
    }
    if (type === 'response.function_call_arguments.delta') {
      const delta = typeof record.delta === 'string' ? record.delta : '';
      if (!delta) return;
      const state = this.getUpstream(outputIndex(record.output_index));
      const next = appendBounded(state.deltaArguments, delta);
      state.deltaArguments = next.value;
      state.deltaOverflow ||= next.overflow;
      return;
    }
    if (type === 'response.function_call_arguments.done') {
      const state = this.getUpstream(outputIndex(record.output_index));
      if (typeof record.arguments === 'string') state.argumentsDone = record.arguments;
      return;
    }
    if (type !== 'response.output_item.done') return;
    const item = asRecord(record.item);
    if (item.type !== 'function_call') return;
    const state = this.getUpstream(outputIndex(record.output_index));
    state.name = typeof item.name === 'string' ? item.name : state.name;
    state.callIdSha256 = typeof item.call_id === 'string' ? hashText(item.call_id) : state.callIdSha256;
    if (typeof item.arguments === 'string') state.itemArguments = item.arguments;
    this.emitUpstream(state);
  }

  recordDownstreamEvent(event: AnthropicSseEvent): void {
    if (event.event === 'content_block_start') {
      const block = asRecord(event.data.content_block);
      if (block.type !== 'tool_use') return;
      const blockIndex = typeof event.data.index === 'number' ? event.data.index : -1;
      const state: DownstreamCallState = {
        blockIndex,
        name: typeof block.name === 'string' ? block.name : undefined,
        idSha256: typeof block.id === 'string' ? hashText(block.id) : undefined,
        arguments: '',
        overflow: false,
        emitted: false,
      };
      this.downstream.set(blockIndex, state);
      if (!this.downstreamOrder.includes(blockIndex)) this.downstreamOrder.push(blockIndex);
      return;
    }
    if (event.event === 'content_block_delta') {
      const delta = asRecord(event.data.delta);
      if (delta.type !== 'input_json_delta' || typeof delta.partial_json !== 'string') return;
      const blockIndex = typeof event.data.index === 'number' ? event.data.index : -1;
      const state = this.downstream.get(blockIndex);
      if (!state) return;
      const next = appendBounded(state.arguments, delta.partial_json);
      state.arguments = next.value;
      state.overflow ||= next.overflow;
      return;
    }
    if (event.event !== 'content_block_stop') return;
    const blockIndex = typeof event.data.index === 'number' ? event.data.index : -1;
    const state = this.downstream.get(blockIndex);
    if (state) this.emitDownstream(state);
  }

  finish(outcome: { status?: number; reason: string }): void {
    if (this.finished) return;
    this.finished = true;
    for (const state of this.upstream.values()) this.emitUpstream(state);
    for (const state of this.downstream.values()) this.emitDownstream(state);

    const upstream = this.upstreamOrder.map((index) => this.upstream.get(index)).filter(
      (state): state is UpstreamCallState => state !== undefined,
    );
    const downstream = this.downstreamOrder.map((index) => this.downstream.get(index)).filter(
      (state): state is DownstreamCallState => state !== undefined,
    );
    const comparisons: Array<Record<string, unknown>> = [];
    const count = Math.max(upstream.length, downstream.length);
    for (let i = 0; i < count; i += 1) {
      const source = upstream[i];
      const target = downstream[i];
      const sourceRaw = source ? this.upstreamArguments(source) : '';
      const targetRaw = target?.arguments ?? '';
      const sourceSummary = source
        ? this.upstreamArgumentSummary(source)
        : { parsed: 'missing-upstream' };
      const targetInfo = target
        ? this.downstreamArgumentSummary(target)
        : { parsed: 'missing-downstream' };
      const sameWireBytes = !!source && !!target && !source.deltaOverflow && !target.overflow
        && sourceRaw.length > 0 && sourceRaw === targetRaw;
      comparisons.push({
        ordinal: i,
        upstreamTool: safeToolName(source?.name, this.requiredByTool),
        downstreamTool: safeToolName(target?.name, this.requiredByTool),
        upstreamCallIdSha256: source?.callIdSha256,
        downstreamCallIdSha256: target?.idSha256,
        sameCallIdentity: !!source && !!target && callKey(source) === callKey(target),
        sameArgumentBytes: sameWireBytes,
        verdict: !source
          ? 'missing-upstream-call'
          : !target
            ? 'missing-downstream-tool-use'
            : sameWireBytes
              ? 'bridge-preserved'
              : 'bridge-output-differs-or-assembly-incomplete',
        upstreamArguments: sourceSummary,
        downstreamArguments: targetInfo,
      });
    }
    this.emit('wire diagnostics: bridge comparison', {
      ...this.meta,
      ...outcome,
      upstreamFunctionCallCount: upstream.length,
      downstreamToolUseCount: downstream.length,
      comparisons,
    });
  }

  private getUpstream(index: number): UpstreamCallState {
    let state = this.upstream.get(index);
    if (!state) {
      state = {
        outputIndex: index,
        deltaArguments: '',
        deltaOverflow: false,
        emitted: false,
      };
      this.upstream.set(index, state);
      this.upstreamOrder.push(index);
    }
    return state;
  }

  private emitUpstream(state: UpstreamCallState): void {
    if (state.emitted) return;
    state.emitted = true;
    const schema = this.requiredByTool.get(state.name ?? '');
    this.emit('wire diagnostics: upstream function_call', {
      ...this.meta,
      outputIndex: state.outputIndex,
      tool: safeToolName(state.name, this.requiredByTool),
      callIdSha256: state.callIdSha256,
      argumentsDelta: summaryForCall(state.deltaArguments, schema, state.deltaOverflow),
      argumentsDone: state.argumentsDone === undefined
        ? '(missing)'
        : summaryForCall(state.argumentsDone, schema),
      itemDoneArguments: state.itemArguments === undefined
        ? '(missing)'
        : summaryForCall(state.itemArguments, schema),
      deltaMatchesItem: state.itemArguments !== undefined && !state.deltaOverflow
        ? hashText(state.deltaArguments) === hashText(state.itemArguments)
        : '(not-comparable)',
    });
  }

  private emitDownstream(state: DownstreamCallState): void {
    if (state.emitted) return;
    state.emitted = true;
    const schema = this.requiredByTool.get(state.name ?? '');
    this.emit('wire diagnostics: downstream tool_use', {
      ...this.meta,
      blockIndex: state.blockIndex,
      tool: safeToolName(state.name, this.requiredByTool),
      idSha256: state.idSha256,
      arguments: summaryForCall(state.arguments, schema, state.overflow),
    });
  }

  private upstreamArguments(state: UpstreamCallState): string {
    if (state.itemArguments !== undefined) return state.itemArguments;
    if (state.argumentsDone !== undefined) return state.argumentsDone;
    return state.deltaArguments;
  }

  private upstreamArgumentSummary(state: UpstreamCallState): Record<string, unknown> {
    const schema = this.requiredByTool.get(state.name ?? '');
    return summaryForCall(
      this.upstreamArguments(state),
      schema,
      state.itemArguments === undefined && state.argumentsDone === undefined && state.deltaOverflow,
    );
  }

  private downstreamArgumentSummary(state: DownstreamCallState): Record<string, unknown> {
    const schema = this.requiredByTool.get(state.name ?? '');
    return summaryForCall(state.arguments, schema, state.overflow);
  }

  private emit(message: string, meta: Record<string, unknown>): void {
    this.logger.debug?.(message, meta);
  }
}
