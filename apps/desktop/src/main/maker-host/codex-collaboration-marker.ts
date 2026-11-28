import { Transform, type TransformCallback } from 'node:stream';

const namespaces = new Set(['collaboration', 'multi_agent_v1', 'multi_agent_v2']);
const tools = new Set(['spawn_agent', 'send_message', 'followup_task']);
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function repairItem(item: unknown): unknown {
  if (!isObject(item) || item.type !== 'function_call'
    || typeof item.namespace !== 'string' || !namespaces.has(item.namespace)
    || typeof item.name !== 'string' || !tools.has(item.name)
    || Object.hasOwn(item, 'encrypted_function_args')) return item;
  // Codex treats absence as encrypted; [] explicitly selects plaintext (#9183).
  // Never replace an upstream declaration, including malformed/null markers.
  return { ...item, encrypted_function_args: [] };
}

function repairEvent(event: unknown): unknown {
  if (!isObject(event)) return event;
  if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
    const item = repairItem(event.item);
    return item === event.item ? event : { ...event, item };
  }
  if (!isObject(event.response) || !Array.isArray(event.response.output)) return event;
  const original = event.response.output;
  const output = original.map(repairItem);
  return output.some((item, index) => item !== original[index])
    ? { ...event, response: { ...event.response, output } } : event;
}

/** Codex-only SSE normalization, after the adapter restores canonical namespaces.
 * Based on Battleplus's #9220 marker repair; preserves all explicit markers.
 * No request history, payload text, credentials or routing is rewritten.
 */
class CollaborationMarkerTransform extends Transform {
  private readonly decoder = new TextDecoder();
  private pending = '';

  private frame(frame: string): string {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, '')).join('\n');
    let event: unknown;
    try { event = JSON.parse(data); } catch { return frame; }
    const repaired = repairEvent(event);
    if (repaired === event) return frame;
    let first = true;
    return frame.replace(/^data:[^\r\n]*/gm, () => {
      if (!first) return 'data:';
      first = false;
      return `data: ${JSON.stringify(repaired)}`;
    });
  }

  private drain(): void {
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.pending);
      if (!match) break;
      this.push(this.frame(this.pending.slice(0, match.index)) + match[0]);
      this.pending = this.pending.slice(match.index + match[0].length);
    }
    // Same best-effort bound as the existing null-array repair; do not retain
    // an unterminated provider frame indefinitely.
    if (Buffer.byteLength(this.pending) > 16 * 1024 * 1024) {
      this.push(this.pending);
      this.pending = '';
    }
  }

  override _transform(chunk: Buffer, _encoding: string, callback: TransformCallback): void {
    this.pending += this.decoder.decode(chunk, { stream: true });
    this.drain();
    callback();
  }

  override _flush(callback: TransformCallback): void {
    this.pending += this.decoder.decode();
    this.drain();
    if (this.pending) this.push(this.frame(this.pending));
    this.pending = '';
    callback();
  }
}

export function createCodexCollaborationMarkerTransform(response: {
  contentType: string; contentEncoding: string;
}): Transform | null {
  const encoding = response.contentEncoding.trim().toLowerCase();
  if (encoding && encoding !== 'identity') return null;
  if (response.contentType.split(';')[0]?.trim().toLowerCase() !== 'text/event-stream') return null;
  return new CollaborationMarkerTransform();
}
