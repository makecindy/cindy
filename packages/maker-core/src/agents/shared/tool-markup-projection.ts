import { SerializedToolCallEcho, reconcileToolCallMarkup, scanToolCallMarkup,
  UNEXECUTED_TOOL_MARKUP_MESSAGE, UNEXECUTED_TOOL_MARKUP_REASON,
  type StructuredToolCall } from '@cindy/model-compat/tool-call-markup';
import type { AgentEvent } from '../../types/events.js';
import type { AsyncQueue } from './async-queue.js';

type Sink = Pick<AsyncQueue<AgentEvent>, 'push'>;
interface Stream { buffer: SerializedToolCallEcho; template: AgentEvent; final?: AgentEvent }
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** Output projection only. It never turns model text into an executable tool. */
export class ToolMarkupProjection {
  constructor(private readonly options: { requireResponseOwnedCalls?: boolean } = {}) {}
  private streams = new Map<string, Stream>();
  private calls: StructuredToolCall[] = [];
  private unexecuted = false;
  active = false;
  private afterTools = false;
  private callsComplete = false;
  private preserveText = false;
  private startedId?: string;
  private projectedTerminals = new WeakSet<AgentEvent>();
  /** Translators project normal events; host-only exits must drain the same hold.
   * Mark translator terminals so a forwarded/filtered sink cannot project twice. */
  attachTerminalQueue(queue: AsyncQueue<AgentEvent>): void {
    const push = queue.push.bind(queue);
    const sink = { push };
    queue.push = event => {
      if ((event.type !== 'error' && event.type !== 'done') || this.projectedTerminals.has(event)
        || event.turnScope === 'background' || event.agentMeta?.parentUuid) return push(event);
      if (event.type === 'error' && record(event.data).isTerminal === false) return this.push(event, sink);
      // A host-only terminal has no successful SDK message to reconcile. Keep
      // its partial output and original Stop/transport-failure diagnosis.
      this.finish(sink, true);
      return this.push(event, sink);
    };
    const end = queue.end.bind(queue);
    queue.end = () => { this.finish(sink, true); end(); };
  }
  begin(sink: Sink, startedId?: string): void {
    if (startedId !== undefined && startedId === this.startedId) return;
    if (startedId !== undefined) this.startedId = startedId;
    this.finish(sink);
    this.streams.clear(); this.calls = []; this.unexecuted = false; this.active = true; this.afterTools = false; this.callsComplete = false; this.preserveText = false;
  }
  setCalls(calls: StructuredToolCall[], preserveText = false): void {
    this.calls = calls.slice(0, 128); this.callsComplete = true; this.preserveText ||= preserveText;
  }
  projectText(text: string): string {
    if (this.preserveText) return text;
    const result = reconcileToolCallMarkup(text, this.calls, true);
    this.unexecuted ||= result.unexecuted;
    return result.text;
  }
  queue<T extends Sink>(sink: T): T {
    const projectedSink = { push: (event: AgentEvent) => {
      if (event.type === 'error' || event.type === 'done') this.projectedTerminals.add(event);
      return sink.push(event);
    } };
    return { ...sink, push: (event: AgentEvent) => this.push(event, projectedSink) };
  }
  finish(sink: Sink, failed = false): void {
    this.preserveText ||= failed;
    failed = this.preserveText;
    for (const stream of this.streams.values()) {
      const data = record(stream.template.data);
      if (stream.final) {
        const held = failed ? { text: stream.buffer.drain(), unexecuted: false }
          : stream.buffer.resolveReport(this.calls, true);
        this.unexecuted ||= held.unexecuted;
        if (held.text) sink.push({ ...stream.template, data: { ...data, text: held.text } });
        const finalData = record(stream.final.data);
        const result = failed ? { text: String(finalData.text ?? ''), unexecuted: false }
          : reconcileToolCallMarkup(String(finalData.text ?? ''), this.calls, true);
        this.unexecuted ||= result.unexecuted;
        sink.push({ ...stream.final, data: { ...finalData, text: result.text } });
      } else {
        const result = failed ? { text: stream.buffer.drain(), unexecuted: false }
          : stream.buffer.resolveReport(this.calls, true);
        this.unexecuted ||= result.unexecuted;
        if (result.text) sink.push({ ...stream.template, data: { ...data, text: result.text } });
      }
    }
    this.streams.clear(); this.active = false;
  }
  push(event: AgentEvent, sink: Sink): boolean {
    const data = record(event.data);
    if (event.turnScope === 'background' || event.agentMeta?.parentUuid) return sink.push(event);
    if (event.type === 'tool_use') {
      // Plan notifications/rollout snapshots have no execution-result boundary.
      // They may arrive late and cannot prove a call in the current sample.
      if (data.runtimeActivity === 'snapshot') return sink.push(event);
      if (!this.options.requireResponseOwnedCalls && this.calls.length < 128 && typeof data.toolName === 'string') {
        const input = record(data.input);
        this.calls.push({ name: data.toolName, arguments: data.input,
          ...(typeof input.input === 'string' ? { input: input.input } : {}) });
      }
      return sink.push(event);
    }
    if (event.type === 'tool_result_full') {
      // Codex code-mode results overlap later model output and carry no sampling
      // ownership. Only a response-owned setCalls snapshot can prove a match;
      // unowned root tool events neither settle text nor supply evidence.
      if (this.options.requireResponseOwnedCalls) return sink.push(event);
      this.finish(sink);
      this.afterTools = true;
      // Tool results are an execution boundary, never model text to scan.
      return sink.push(event);
    }
    if (event.type === 'error') {
      this.finish(sink, true);
      // A failed sampling attempt is not the terminal state of its whole turn.
      // Preserve that attempt, then reconcile recovered output independently.
      if (data.isTerminal === false) this.begin(sink);
      const known = typeof data.message === 'string' && (data.message.includes(UNEXECUTED_TOOL_MARKUP_MESSAGE)
        || data.message.includes('模型把工具调用写成了文本，工具未执行，本轮未完成。')
        || data.message.includes(UNEXECUTED_TOOL_MARKUP_REASON));
      return sink.push(known ? { ...event, data: { ...data, reason: UNEXECUTED_TOOL_MARKUP_REASON, message: UNEXECUTED_TOOL_MARKUP_MESSAGE } } : event);
    }
    if (event.type === 'done') {
      const failed = this.preserveText || data.cancelled === true || data.status === 'cancelled' || data.status === 'failed' || data.is_error === true;
      this.finish(sink, failed);
      const result = typeof data.result === 'string' && !failed && !this.preserveText
        ? reconcileToolCallMarkup(data.result, this.calls, true) : undefined;
      if (!failed && (this.unexecuted || result?.unexecuted)) {
        sink.push({ type: 'error', source: event.source, data: { reason: UNEXECUTED_TOOL_MARKUP_REASON,
          message: UNEXECUTED_TOOL_MARKUP_MESSAGE, isTerminal: true } });
        return sink.push({ ...event, data: { ...data, result: result?.text ?? '', status: 'failed',
          is_error: true, silentStop: false, reason: UNEXECUTED_TOOL_MARKUP_REASON } });
      }
      return sink.push(result ? { ...event, data: { ...data, result: result.text } } : event);
    }
    const textEvent = event.type === 'text';
    const thinkingDelta = event.type === 'thinking' && data.stage === 'delta';
    const thinkingFinal = event.type === 'thinking' && data.stage === 'final';
    if (!(textEvent || thinkingDelta || thinkingFinal) || typeof data.text !== 'string') return sink.push(event);
    if (this.afterTools) this.begin(sink);
    const key = textEvent ? 'text:' + String(data.agentMessageId ?? '') : 'thinking:' + String(data.blockId ?? '');
    let stream = this.streams.get(key);
    if (this.streams.size >= 128 && !stream) return sink.push(event);
    if (!stream) {
      stream = { buffer: new SerializedToolCallEcho(), template: event };
      this.streams.set(key, stream);
    }
    const final = (textEvent && data.isFinal === true) || thinkingFinal;
    if (final) {
      // Claude/Pi supply all calls with the full message. Preserve the order of
      // separate final text blocks rather than replacing one deferred final.
      if (this.callsComplete) {
        const held = this.preserveText ? { text: stream.buffer.drain(), unexecuted: false }
          : stream.buffer.resolveReport(this.calls, true);
        this.unexecuted ||= held.unexecuted;
        // A preserved full SDK snapshot already includes the held suffix. Do
        // not enqueue it again as a late delta across the Stop boundary.
        if (held.text && !(this.preserveText && data.isFullText === true && data.text.endsWith(held.text))) {
          sink.push({ ...stream.template, data: { ...record(stream.template.data), text: held.text } });
        }
        this.streams.delete(key);
        return sink.push({ ...event, data: { ...data, text: this.projectText(data.text) } });
      }
      if (stream.buffer.hasPending || scanToolCallMarkup(data.text).length) {
        stream.final = event;
        return true;
      }
      return sink.push(event);
    }
    stream.template = event;
    const visible = stream.buffer.push(data.text);
    return visible ? sink.push({ ...event, data: { ...data, text: visible } }) : true;
  }
}
const projections = new WeakMap<object, ToolMarkupProjection>();
export function toolMarkupProjection(owner: object): ToolMarkupProjection {
  let projection = projections.get(owner);
  if (!projection) { projection = new ToolMarkupProjection(); projections.set(owner, projection); }
  return projection;
}
export function structuredCallsOf(content: unknown): StructuredToolCall[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap(value => {
    const block = record(value);
    const args = block.input ?? block.arguments;
    const input = record(args).input;
    return (block.type === 'tool_use' || block.type === 'toolCall') && typeof block.name === 'string'
      ? [{ name: block.name, arguments: args, ...(typeof input === 'string' ? { input } : {}) }] : [];
  });
}
