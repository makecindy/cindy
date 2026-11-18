import { redactSensitiveText, redactSensitiveTextDeep } from '@cindy/maker-shared/error-redaction';
import type { GhostToolExecutionData } from '../../shared/ghost.js';

/** Only the tool events already produced by the shared translators; no fabricated native progress. */
export function isToolExecutionEvent(type: string): boolean {
  return type === 'tool_use' || type === 'tool_result' || type === 'tool_result_full'
    || type === 'agent_task_update' || type === 'error';
}

/** Copy a bounded snapshot without serializing an unbounded tool result or invoking accessors. */
export function projectToolExecutionEvent(sessionId: string, event: {
  type: string; data?: unknown; source?: string;
}): GhostToolExecutionData {
  let bytes = 60_000, nodes = 512, truncated = false;
  let seen = new WeakSet<object>();
  const text = (value: string): string => {
    const clipped = value.slice(0, Math.max(0, Math.min(10_000, Math.floor((bytes - 2) / 6))));
    if (clipped.length !== value.length) truncated = true;
    bytes -= Buffer.byteLength(JSON.stringify(clipped));
    return clipped;
  };
  const copy = (value: unknown, depth = 0): unknown => {
    if (--nodes < 0 || bytes < 32 || depth > 8) { truncated = true; return null; }
    bytes -= 16; // Punctuation and scalar overhead, conservatively charged per node.
    if (typeof value === 'string') {
      if (/^data:(?:image|audio|video)\//i.test(value)) { truncated = true; return null; }
      return text(value);
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (!value || typeof value !== 'object') { truncated = value !== undefined || truncated; return null; }
    if (seen.has(value) || value instanceof Uint8Array) { truncated = true; return null; }
    seen.add(value);
    const ownText = (key: string): string => {
      const property = Object.getOwnPropertyDescriptor(value, key);
      return property && 'value' in property && typeof property.value === 'string' ? property.value : '';
    };
    if (['image', 'image_url', 'inputImage', 'input_image', 'input_audio', 'audio', 'video'].includes(ownText('type'))
      || ['image', 'audio', 'video'].includes(ownText('kind'))
      || /^(?:image|audio|video)\//i.test(ownText('mimeType') || ownText('media_type'))) {
      truncated = true; return null;
    }
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index++) {
        if (nodes <= 0 || bytes < 32) { truncated = true; break; }
        const property = Object.getOwnPropertyDescriptor(value, `${index}`);
        if (property && !('value' in property)) truncated = true;
        result.push(property && 'value' in property ? copy(property.value, depth + 1) : null);
      }
      return result;
    }
    const result: Record<string, unknown> = Object.create(null);
    let visited = 0;
    for (const key in value) {
      if (++visited > 512 || nodes <= 0 || bytes < 1024) { truncated = true; break; }
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !('value' in property)) { truncated = true; continue; }
      if (key.length > 128 || key === '__proto__') { truncated = true; continue; }
      if (key === 'processMedia') { truncated = true; continue; }
      bytes -= Buffer.byteLength(JSON.stringify(key)) + 2;
      // Reuse the canonical credential-field rules without serializing the value.
      const probe = `${key}: cindy_observer_probe`;
      result[key] = copy(redactSensitiveText(probe) !== probe ? '[REDACTED]' : property.value, depth + 1);
    }
    return result;
  };
  const sanitized = redactSensitiveTextDeep(copy(event.data));
  // Redaction can expand short matches. Bound the resulting snapshot as well.
  bytes = 60_000; nodes = 512; seen = new WeakSet<object>();
  const payload = copy(sanitized);
  return { sessionId, eventType: event.type, ...(event.source ? { source: event.source.slice(0, 64) } : {}),
    payload, ...(truncated ? { truncated: true } : {}) };
}
