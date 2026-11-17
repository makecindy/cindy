// Output projection based on zcinta0514's PR #6545 (Apache-2.0).
// Pi owns execution. Only the complete assistant response supplies call evidence;
// tool events (including concurrent child/old tools) never authorize text.
import { SerializedToolCallEcho, reconcileToolCallMarkup, scanToolCallMarkup,
  UNEXECUTED_TOOL_MARKUP_MESSAGE, UNEXECUTED_TOOL_MARKUP_REASON,
  type StructuredToolCall } from '../shared/tool-call-markup.js';
import type { AgentEvent } from '../../types/events.js';
import type { AsyncQueue } from '../shared/async-queue.js';

type Sink = Pick<AsyncQueue<AgentEvent>, 'push'>;
interface Stream { buffer: SerializedToolCallEcho; template: AgentEvent; final?: AgentEvent }
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export class PiToolMarkupProjection {
  private streams = new Map<string, Stream>();
  private calls: StructuredToolCall[] = [];
  private unexecuted = false;
  private callsComplete = false;
  private preserve = false;
  private projectedTerminals = new WeakSet<AgentEvent>();

  resetTurn(sink: Sink): void {
    this.finish(sink, true);
    this.unexecuted = false;
    this.beginSample(sink);
  }
  beginSample(sink: Sink): void {
    // A missing message_end cannot justify discarding a previous partial reply.
    this.finish(sink, true);
    this.calls = [];
    this.callsComplete = false;
    this.preserve = false;
    // Keep confirmed unresolved calls from earlier successful messages in this turn.
  }
  setMessage(content: unknown, preserve: boolean): void {
    this.preserve ||= preserve;
    this.calls = Array.isArray(content) ? content.flatMap(value => {
      const block = record(value);
      const args = block.arguments;
      const input = record(args).input;
      return block.type === 'toolCall' && typeof block.name === 'string'
        ? [{ name: block.name, arguments: args, ...(typeof input === 'string' ? { input } : {}) }] : [];
    }).slice(0, 128) : [];
    this.callsComplete = true;
  }
  private clean(text: string, isOutput = true): string {
    if (this.preserve) return text;
    const result = reconcileToolCallMarkup(text, this.calls, isOutput);
    this.unexecuted ||= isOutput && result.unexecuted;
    return result.text;
  }
  finish(sink: Sink, preserve = false): void {
    this.preserve ||= preserve;
    for (const stream of this.streams.values()) {
      // Reasoning may consider then abandon a call; only output can fail the turn.
      const isOutput = stream.template.type === 'text';
      const result = this.preserve ? { text: stream.buffer.drain(), unexecuted: false }
        : stream.buffer.resolveReport(this.calls, isOutput);
      this.unexecuted ||= isOutput && result.unexecuted;
      const finalData = record(stream.final?.data);
      // Pi full snapshots replace the streamed bubble; thinking finals also
      // replace their block, but ordinary delta-only consumers still need tails.
      if (result.text && !(this.preserve && finalData.isFullText === true
        && typeof finalData.text === 'string' && finalData.text.endsWith(result.text))) {
        sink.push({ ...stream.template, data: { ...record(stream.template.data), text: result.text } });
      }
      if (stream.final) sink.push({ ...stream.final, data: { ...finalData, text: this.clean(String(finalData.text ?? ''), isOutput) } });
    }
    this.streams.clear();
  }
  queue(sink: Sink): Sink {
    return { push: event => this.push(event, { push: projected => {
      if (projected.type === 'error' || projected.type === 'done') this.projectedTerminals.add(projected);
      return sink.push(projected);
    } }) };
  }
  attachTerminalQueue(queue: AsyncQueue<AgentEvent>): void {
    const sink = { push: queue.push.bind(queue) };
    queue.push = event => {
      if ((event.type === 'error' || event.type === 'done') && !this.projectedTerminals.has(event)
        && event.turnScope !== 'background' && !event.agentMeta?.parentUuid) this.finish(sink, true);
      return sink.push(event);
    };
    const end = queue.end.bind(queue);
    queue.end = () => { this.finish(sink, true); end(); };
  }
  private push(event: AgentEvent, sink: Sink): boolean {
    if (event.turnScope === 'background' || event.agentMeta?.parentUuid) return sink.push(event);
    const data = record(event.data);
    if (event.type === 'error') {
      this.finish(sink, true);
      return sink.push(event);
    }
    if (event.type === 'done') {
      const failed = this.preserve || data.status === 'failed' || data.status === 'cancelled' || data.cancelled === true;
      this.finish(sink, failed);
      const result = typeof data.result === 'string' && !failed ? this.clean(data.result) : data.result;
      if (!failed && this.unexecuted) {
        sink.push({ type: 'error', source: event.source, data: { reason: UNEXECUTED_TOOL_MARKUP_REASON,
          message: UNEXECUTED_TOOL_MARKUP_MESSAGE, isTerminal: true, usage: data.usage } });
        return sink.push({ ...event, data: { ...data, result: result ?? '', status: 'failed',
          is_error: true, silentStop: false, reason: UNEXECUTED_TOOL_MARKUP_REASON } });
      }
      return sink.push({ ...event, data: { ...data, result } });
    }
    const text = event.type === 'text';
    const thinking = event.type === 'thinking' && (data.stage === 'delta' || data.stage === 'final');
    if (!(text || thinking) || typeof data.text !== 'string') return sink.push(event);
    const key = text ? 'text' : 'thinking:' + String(data.blockId ?? '');
    let stream = this.streams.get(key);
    if (!stream && this.streams.size >= 128) return sink.push(event);
    if (!stream) {
      stream = { buffer: new SerializedToolCallEcho(), template: event };
      this.streams.set(key, stream);
    }
    if ((text && data.isFinal === true) || (thinking && data.stage === 'final')) {
      if (this.callsComplete) {
        stream.final = event;
        this.finish(sink);
        return true;
      }
      if (stream.buffer.hasPending || scanToolCallMarkup(data.text).length) {
        stream.final = event;
        return true;
      }
      this.streams.delete(key);
      return sink.push(event);
    }
    stream.template = event;
    const visible = stream.buffer.push(data.text);
    return visible ? sink.push({ ...event, data: { ...data, text: visible } }) : true;
  }
}
const projections = new WeakMap<object, PiToolMarkupProjection>();
export function piToolMarkupProjection(owner: object): PiToolMarkupProjection {
  let projection = projections.get(owner);
  if (!projection) { projection = new PiToolMarkupProjection(); projections.set(owner, projection); }
  return projection;
}
