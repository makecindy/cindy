import { isUtf8 } from 'node:buffer';
import type { ImportFile } from './types.js';
import { sniffMediaMime } from '../cindy-media/sniffMediaMime.js';

/** Memory trees also contain JSON, backups and extensionless notes. Classify
 * their bytes, not their suffix; empty delivery/lock markers are archived without creating searchable memory text. */
export function memoryFileContent(file: ImportFile): { kind: 'empty' } | { kind: 'text'; text: string } | { kind: 'attachment' } {
  if (!file.bytes.length) return { kind: 'empty' };
  if (sniffMediaMime(file.bytes)) return { kind: 'attachment' };
  // Native text logs may contain terminal/control characters. Preserve them
  // verbatim; NUL bytes or non-UTF-8 still require attachment handling.
  const textDocument = /\.(?:md|txt|json|jsonl|yaml|yml|toml|csv|log)$/i.test(file.name);
  if (isUtf8(file.bytes) && !file.bytes.includes(0) && (textDocument || !file.bytes.some(byte => byte < 32 && ![9, 10, 13].includes(byte)))) {
    const text = file.bytes.toString('utf8');
    return text.trim() ? { kind: 'text', text } : { kind: 'empty' };
  }
  return { kind: 'attachment' };
}
