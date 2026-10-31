import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { MAX_TRACE_FILE_BYTES, MAX_TRACE_TOTAL_BYTES, TRACE_ARTIFACT_NAMES } from './artifacts';

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function object(value: unknown): Record<string, unknown> {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'Invalid record');
  return value as Record<string, unknown>;
}

/** Accept SLS JSON/JSONL export rows (scope/msg). Only one complete attempt is restored.
 * Duplicate identical rows are harmless; missing, conflicting or corrupt rows fail closed. */
export function restorePerformanceFiles(rows: unknown[], reportId: string, attemptId?: string) {
  requireValue(rows.length <= 100_000, 'Too many records');
  const attempts = new Map<string, Map<number, Record<string, unknown>>>();
  for (const raw of rows) {
    const row = object(raw);
    if (row.scope !== 'performance-trace-files' || typeof row.msg !== 'string') continue;
    const item = object(JSON.parse(row.msg));
    if (item.protocol !== 'cindy-performance-files' || item.reportId !== reportId) continue;
    requireValue(
      item.version === 1 && typeof item.attemptId === 'string',
      'Unsupported file protocol',
    );
    if (attemptId && item.attemptId !== attemptId) continue;
    requireValue(
      Number.isInteger(item.sequence) &&
        Number(item.sequence) >= 0 &&
        Number(item.sequence) < 100_000,
      'Invalid record sequence',
    );
    const records = attempts.get(item.attemptId) ?? new Map();
    const old = records.get(Number(item.sequence));
    requireValue(
      !old || JSON.stringify(old) === JSON.stringify(item),
      'Conflicting duplicate record',
    );
    records.set(Number(item.sequence), item);
    attempts.set(item.attemptId, records);
  }
  let failure: unknown = new Error('No complete performance report found');
  for (const [id, bySequence] of [...attempts].reverse()) {
    try {
      const records = [...bySequence.values()].sort(
        (a, b) => Number(a.sequence) - Number(b.sequence),
      );
      requireValue(
        records.length >= 3 && records.every((row, i) => row.sequence === i),
        'Missing report records',
      );
      const manifest = object(records[0].data);
      const end = object(records.at(-1)!.data);
      requireValue(
        manifest.kind === 'manifest' &&
          manifest.encoding === 'gzip+base64' &&
          end.kind === 'complete' &&
          end.records === records.length,
        'Missing completion marker',
      );
      requireValue(
        Array.isArray(manifest.files) &&
          manifest.files.length >= 1 &&
          manifest.files.length <= TRACE_ARTIFACT_NAMES.length &&
          end.files === manifest.files.length,
        'Invalid file manifest',
      );
      const chunks = records.slice(1, -1).map((row) => object(row.data));
      const files = new Map<string, Buffer>();
      let consumed = 0,
        total = 0;
      for (const rawFile of manifest.files) {
        const file = object(rawFile);
        requireValue(
          typeof file.name === 'string' &&
            TRACE_ARTIFACT_NAMES.includes(file.name as never) &&
            !files.has(file.name),
          'Invalid or duplicate filename',
        );
        requireValue(
          Number.isInteger(file.bytes) &&
            Number(file.bytes) > 0 &&
            Number(file.bytes) <= MAX_TRACE_FILE_BYTES &&
            Number.isInteger(file.compressedBytes) &&
            Number(file.compressedBytes) > 0 &&
            Number(file.compressedBytes) <= MAX_TRACE_FILE_BYTES &&
            Number.isInteger(file.chunks) &&
            Number(file.chunks) > 0 &&
            Number(file.chunks) <= 6000 &&
            typeof file.sha256 === 'string' &&
            /^[a-f0-9]{64}$/.test(file.sha256),
          'Invalid file bounds',
        );
        total += Number(file.bytes);
        requireValue(total <= MAX_TRACE_TOTAL_BYTES, 'Report exceeds restore limit');
        const parts = chunks
          .filter((chunk) => chunk.name === file.name)
          .sort((a, b) => Number(a.index) - Number(b.index));
        requireValue(
          parts.length === file.chunks &&
            parts.every(
              (part, i) =>
                part.kind === 'chunk' &&
                part.index === i &&
                typeof part.content === 'string' &&
                part.content.length <= 16 * 1024 &&
                /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
                  part.content,
                ),
            ),
          'Missing or invalid file chunks',
        );
        consumed += parts.length;
        const compressed = Buffer.concat(
          parts.map((part) => Buffer.from(String(part.content), 'base64')),
        );
        requireValue(compressed.length === file.compressedBytes, 'Compressed file size mismatch');
        const bytes = gunzipSync(compressed, { maxOutputLength: Number(file.bytes) });
        requireValue(
          bytes.length === file.bytes &&
            createHash('sha256').update(bytes).digest('hex') === file.sha256,
          'File checksum mismatch',
        );
        JSON.parse(bytes.toString('utf8'));
        files.set(file.name, bytes);
      }
      requireValue(
        files.has('report.json') && consumed === chunks.length,
        'Unexpected or missing files',
      );
      requireValue(
        object(JSON.parse(files.get('report.json')!.toString())).reportId === reportId,
        'Report identity mismatch',
      );
      return { reportId, attemptId: id, files, manifest };
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}
