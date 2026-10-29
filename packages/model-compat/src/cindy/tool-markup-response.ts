import { Transform, type TransformCallback } from 'node:stream';
import type { RoutedNamespaceToolAliases } from '../upstream/responses/namespace-tool-compat.js';
import { SerializedToolCallEcho, reconcileToolCallMarkup, scanToolCallMarkup,
  UNEXECUTED_TOOL_MARKUP_MESSAGE, UNEXECUTED_TOOL_MARKUP_REASON,
  type StructuredToolCall } from './tool-call-markup.js';
type Obj = Record<string, unknown>;
function obj(value: unknown): value is Obj { return !!value && typeof value === 'object' && !Array.isArray(value); }
/** Request-scoped Responses SSE projection. IDs, tools, usage and opaque reasoning stay intact. */
export class ToolMarkupResponseTransform extends Transform {
  constructor(private readonly toolAliases?: RoutedNamespaceToolAliases) { super(); }
  private decoder = new TextDecoder();
  private pending = '';
  private streams = new Map<string, { buffer: SerializedToolCallEcho; event: Obj }>();
  private calls = new Map<string, StructuredToolCall>();
  private deferred: Obj[] = [];
  private deferredBytes = 0;
  private sequence = 0;
  private unexecuted = false;
  private terminal = false;
  private passthrough = false;
  private annotatedStreams = new Set<string>();
  private itemIds = new Map<unknown, string>();
  private streamKey(event: Obj): string {
    const reasoning = String(event.type).includes('reasoning_summary');
    return JSON.stringify([reasoning ? 'reasoning' : 'text',
      event.item_id ?? this.itemIds.get(event.output_index) ?? event.output_index,
      event.content_index ?? event.summary_index ?? 0]);
  }
  private noteAnnotations(event: Obj): void {
    if (obj(event.item) && typeof event.item.id === 'string' && event.output_index !== undefined && this.itemIds.size < 128) {
      this.itemIds.set(event.output_index, event.item.id);
    }
    const mark = (part: unknown, key: string): void => {
      if (obj(part) && Array.isArray(part.annotations) && part.annotations.length > 0) this.annotatedStreams.add(key);
    };
    if (event.type === 'response.output_text.annotation.added') this.annotatedStreams.add(this.streamKey(event));
    mark(event.part, this.streamKey(event));
    const items = obj(event.response) && Array.isArray(event.response.output) ? event.response.output : [event.item];
    items.forEach((item, outputIndex) => {
      if (!obj(item) || !Array.isArray(item.content)) return;
      item.content.forEach((part, contentIndex) => mark(part, this.streamKey({ type: 'response.output_text.done',
        item_id: item.id, output_index: event.output_index ?? outputIndex, content_index: contentIndex })));
    });
    if (this.annotatedStreams.size > 128) { this.finishHeld(true); this.passthrough = true; }
  }
  private collect(item: unknown): void {
    if (!obj(item) || this.calls.size >= 128 || typeof item.name !== 'string') return;
    // Only request-authorized aliases for this exact restored identity/kind may
    // validate text. A declared alias alone is never execution evidence.
    const aliases: string[] = [];
    for (const [alias, identity] of this.toolAliases ?? []) {
      if (identity.name === item.name && identity.namespace === item.namespace
        && identity.kind === (item.type === 'custom_tool_call' ? 'custom' : 'function')) aliases.push(alias);
    }
    if (item.type === 'custom_tool_call' && typeof item.input === 'string') {
      this.calls.set(String(item.call_id ?? item.id), { name: item.name, input: item.input, aliases });
    } else if (item.type === 'function_call' && typeof item.arguments === 'string') {
      this.calls.set(String(item.call_id ?? item.id), { name: item.name, arguments: item.arguments, aliases });
    }
  }
  private cleanText(text: unknown, key: string): unknown {
    if (typeof text !== 'string' || this.annotatedStreams.has(key)) return text;
    const result = reconcileToolCallMarkup(text, [...this.calls.values()], true);
    this.unexecuted ||= result.unexecuted;
    return result.text;
  }
  private cleanItem(item: unknown, outputIndex?: number): unknown {
    if (!obj(item)) return item;
    if (item.type === 'message' && Array.isArray(item.content)) return { ...item, content: item.content.map((part, content_index) =>
      obj(part) && part.type === 'output_text' ? { ...part, text: this.cleanText(part.text, this.streamKey({ type: 'response.output_text.done', item_id: item.id, output_index: outputIndex, content_index })) } : part) };
    if (item.type === 'reasoning' && Array.isArray(item.summary)) return { ...item, summary: item.summary.map((part, summary_index) =>
      obj(part) && part.type === 'summary_text' ? { ...part, text: this.cleanText(part.text, this.streamKey({ type: 'response.reasoning_summary_text.done', item_id: item.id, output_index: outputIndex, summary_index })) } : part) };
    return item;
  }
  private cleanEvent(event: Obj): Obj {
    if (event.type === 'response.output_item.done') return { ...event, item: this.cleanItem(event.item, typeof event.output_index === 'number' ? event.output_index : undefined) };
    if ((event.type === 'response.output_text.done' || event.type === 'response.reasoning_summary_text.done') && typeof event.text === 'string') {
      return { ...event, text: this.cleanText(event.text, this.streamKey(event)) };
    }
    if ((event.type === 'response.content_part.done' || event.type === 'response.reasoning_summary_part.done') && obj(event.part)) {
      return { ...event, part: { ...event.part, text: this.cleanText(event.part.text, this.streamKey(event)) } };
    }
    return event;
  }
  private writeEvent(event: Obj): void {
    const wire = typeof event.sequence_number === 'number' ? { ...event, sequence_number: this.sequence++ } : event;
    this.push('event: ' + String(wire.type) + '\ndata: ' + JSON.stringify(wire) + '\n\n');
  }
  private finishHeld(preserve = false): void {
    for (const stream of this.streams.values()) {
      const result = preserve || this.annotatedStreams.has(this.streamKey(stream.event)) ? { text: stream.buffer.drain(), unexecuted: false }
        : stream.buffer.resolveReport([...this.calls.values()], true);
      this.unexecuted ||= result.unexecuted;
      if (result.text) this.writeEvent({ ...stream.event, delta: result.text });
    }
    this.streams.clear();
    for (const event of this.deferred) this.writeEvent(preserve ? event : this.cleanEvent(event));
    this.deferred = []; this.deferredBytes = 0;
  }
  private frame(frame: string): void {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    let event: unknown;
    try { event = JSON.parse(data); } catch { this.push(frame + '\n\n'); return; }
    if (!obj(event) || this.terminal || this.passthrough) { this.push(frame + '\n\n'); return; }
    if (event.type === 'response.output_item.done') this.collect(event.item);
    if (obj(event.response) && Array.isArray(event.response.output)) for (const item of event.response.output) this.collect(item);
    // Citation offsets require only their own content part to remain unchanged.
    this.noteAnnotations(event);
    if (this.passthrough) { this.writeEvent(event); return; }
    if (event.type === 'error') {
      this.finishHeld(true);
      this.writeEvent(event);
      this.terminal = true;
      return;
    }
    if (event.type === 'response.output_text.delta' || event.type === 'response.reasoning_summary_text.delta') {
      if (typeof event.delta !== 'string') { this.writeEvent(event); return; }
      const key = this.streamKey(event);
      let stream = this.streams.get(key);
      if (!stream && this.streams.size >= 128) { this.finishHeld(true); this.passthrough = true; this.writeEvent(event); return; }
      if (!stream) { stream = { buffer: new SerializedToolCallEcho(), event }; this.streams.set(key, stream); }
      stream.event = event;
      const visible = stream.buffer.push(event.delta);
      if (visible) this.writeEvent({ ...event, delta: visible });
      return;
    }
    if (event.type === 'response.completed' || event.type === 'response.failed' || event.type === 'response.incomplete') {
      const preserve = event.type !== 'response.completed';
      this.finishHeld(preserve);
      const response = obj(event.response) ? event.response : {};
      const output = !preserve && Array.isArray(response.output) ? response.output.map((item, index) => this.cleanItem(item, index)) : response.output;
      const failed = !preserve && this.unexecuted;
      this.writeEvent({ ...event, type: failed ? 'response.failed' : event.type,
        response: { ...response, ...(output ? { output } : {}), ...(failed ? { status: 'failed',
          error: { code: UNEXECUTED_TOOL_MARKUP_REASON, message: UNEXECUTED_TOOL_MARKUP_MESSAGE } } : {}) } });
      this.terminal = true;
      return;
    }
    const serialized = JSON.stringify(event);
    const item = obj(event.item) ? event.item : {};
    const parts = Array.isArray(item.content) ? item.content : Array.isArray(item.summary) ? item.summary : [];
    const texts = [event.text, obj(event.part) ? event.part.text : undefined, ...parts.map(part => obj(part) ? part.text : undefined)];
    const done = String(event.type).endsWith('.done');
    const pending = [...this.streams.values()].some(stream => stream.buffer.hasPending);
    if (done && (pending || texts.some(text => typeof text === 'string' && scanToolCallMarkup(text).length > 0))) {
      this.deferred.push(event); this.deferredBytes += serialized.length;
      if (this.deferredBytes > 256 * 1024) { this.finishHeld(true); this.passthrough = true; }
      return;
    }
    this.writeEvent(event);
  }
  private drainFrames(): void {
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.pending);
      if (!match) break;
      const frame = this.pending.slice(0, match.index);
      this.pending = this.pending.slice(match.index + match[0].length);
      this.frame(frame);
    }
  }
  override _transform(chunk: Buffer, _encoding: string, callback: TransformCallback): void {
    this.pending += this.decoder.decode(chunk, { stream: true });
    this.drainFrames();
    if (this.pending.length > 1024 * 1024) { this.finishHeld(true); this.push(this.pending); this.pending = ''; this.passthrough = true; }
    callback();
  }
  override _flush(callback: TransformCallback): void {
    this.pending += this.decoder.decode(); this.drainFrames();
    this.finishHeld(true);
    if (this.pending) this.push(this.pending);
    callback();
  }
}
export function createToolMarkupResponseTransform(response: { contentType: string; contentEncoding: string }, toolAliases?: RoutedNamespaceToolAliases): Transform | null {
  return response.contentType.toLowerCase().startsWith('text/event-stream') && (!response.contentEncoding || response.contentEncoding === 'identity')
    ? new ToolMarkupResponseTransform(toolAliases) : null;
}
