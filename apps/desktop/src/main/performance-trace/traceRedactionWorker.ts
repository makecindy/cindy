// eslint-disable-next-line no-restricted-imports -- CPU-only artifact redaction worker; no database access.
import { parentPort } from 'node:worker_threads';
import { redact } from '../log-upload/redact';

/** Preserve every event/sample/field, applying the existing log redactor to
 * values rather than raw JSON. All whole-file CPU work stays in this thread. */
function redactArtifact(bytes: ArrayBuffer): ArrayBuffer {
  const root: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
  if (!root || typeof root !== 'object') throw new Error('invalid artifact');
  const stack: Array<Record<string, unknown> | unknown[]> = [root as Record<string, unknown>];
  const sensitiveKeys = new Map<string, boolean>();
  const strings = new Map<string, string>();
  while (stack.length) {
    const node = stack.pop()!;
    const array = Array.isArray(node);
    for (const key of Object.keys(node)) {
      const record = node as Record<string, unknown>;
      const value = record[key];
      let sensitive = false;
      if (!array) {
        sensitive =
          sensitiveKeys.get(key) ??
          (() => {
            const probe = JSON.stringify({ [key]: 'redaction-probe' });
            const result = redact(probe) !== probe;
            if (sensitiveKeys.size < 256) sensitiveKeys.set(key, result);
            return result;
          })();
      }
      if (sensitive) record[key] = '<redacted:sensitive-field>';
      else if (typeof value === 'string') {
        const cleaned = strings.get(value) ?? redact(value);
        if (strings.size < 1024 && value.length <= 1024) strings.set(value, cleaned);
        record[key] = cleaned;
      } else if (value && typeof value === 'object') stack.push(value as Record<string, unknown>);
    }
  }
  return Uint8Array.from(Buffer.from(JSON.stringify(root))).buffer;
}

parentPort?.once('message', (input: ArrayBuffer) => {
  try {
    const bytes = redactArtifact(input);
    parentPort!.postMessage({ bytes }, [bytes]);
  } catch {
    parentPort!.postMessage({ failed: true });
  } finally {
    parentPort!.close();
  }
});
