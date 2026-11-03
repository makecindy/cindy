import { stripVTControlCharacters } from 'node:util';
import {
  parseCindyMakeBuildDiagnostic,
  type CindyMakeBuildDiagnostic,
} from '../../shared/cindyMakeBuildDiagnostic.js';

const OUTPUT_LIMIT = 32_768;
const ERROR_LINE =
  /fatal error|\berror\b|\b\w*Error:|\bERR_[A-Z0-9_]+\b|\b(?:TS|MSB)\d{4,}\b|\b(?:ENOSPC|EACCES|EPERM|ENOENT|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b|cannot find|not found/i;

/** Keep a bounded tail in memory; persist only a scrubbed error excerpt after failure. */
export function createMakeBuildOutput() {
  let tail = '';
  let discardingLine = false;
  return {
    append(chunk: string) {
      if (discardingLine) {
        const boundary = chunk.indexOf('\n');
        if (boundary < 0) return;
        chunk = chunk.slice(boundary + 1);
        discardingLine = false;
      }
      const combined = tail + chunk;
      if (combined.length <= OUTPUT_LIMIT) {
        tail = combined;
        return;
      }
      // Never keep a partial credential line after dropping its "token=" prefix.
      const boundary = combined.indexOf('\n', combined.length - OUTPUT_LIMIT);
      tail = boundary < 0 ? '' : combined.slice(boundary + 1);
      discardingLine = boundary < 0;
    },
    failure(exitCode?: number, timedOut = false): CindyMakeBuildDiagnostic {
      const text = stripVTControlCharacters(tail);
      const lines = text
        .split(/[\r\n]+/)
        .map((line) => line.trim())
        .filter(Boolean);
      const errors = lines.filter((line) => ERROR_LINE.test(line) && !/^at\s/.test(line));
      // Prefer the compiler's cause over the outer "Command failed" stack and progress redraws.
      const message = (errors.length ? [...new Set(errors)] : lines.slice(-8)).join('\n');
      return parseCindyMakeBuildDiagnostic({
        kind: timedOut
          ? 'timeout'
          : /heap out of memory|allocation failed.*heap/i.test(text)
            ? 'outOfMemory'
            : 'process',
        exitCode,
        message,
      })!;
    },
  };
}

export function makeBuildErrorDiagnostic(error: unknown): CindyMakeBuildDiagnostic | undefined {
  if (!error || typeof error !== 'object') return;
  return parseCindyMakeBuildDiagnostic((error as { diagnostic?: unknown }).diagnostic);
}
