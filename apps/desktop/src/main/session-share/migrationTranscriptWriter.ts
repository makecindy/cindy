import { randomBytes } from 'node:crypto';
import { createWriteStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { migrationNativeContext } from './migrationNativeContext.js';

export interface TranscriptRewrite {
  context: ReturnType<typeof migrationNativeContext>;
  agent: 'cc' | 'codex';
}

const NEWLINE = Buffer.from('\n');

/**
 * Same output as `context.transcript(bytes, agent)` without holding the transcript in memory:
 * a native transcript can exceed V8's string limit. Splits on the `\n` byte, which never
 * occurs inside a multi-byte UTF-8 sequence, and decodes only lines that can change, so other
 * lines keep their exact bytes. Memory is bounded by the longest line.
 */
class TranscriptLines extends Transform {
  private carry: Buffer[] = [];

  constructor(private readonly rewrite: TranscriptRewrite) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error) => void) {
    let start = 0;
    for (let end = chunk.indexOf(0x0a); end !== -1; end = chunk.indexOf(0x0a, start)) {
      this.carry.push(chunk.subarray(start, end));
      this.push(this.takeLine());
      this.push(NEWLINE);
      start = end + 1;
    }
    // Copy: the tail outlives this chunk.
    if (start < chunk.length) this.carry.push(Buffer.from(chunk.subarray(start)));
    done();
  }

  override _flush(done: (error?: Error) => void) {
    // No trailing newline is added, matching `split('\n').join('\n')`.
    if (this.carry.length) this.push(this.takeLine());
    done();
  }

  private takeLine(): Buffer {
    const bytes = this.carry.length === 1 ? this.carry[0] : Buffer.concat(this.carry);
    this.carry = [];
    const { context, agent } = this.rewrite;
    if (!context.mayRewrite(bytes)) return bytes;
    return Buffer.from(context.line(bytes.toString('utf8'), agent));
  }
}

/**
 * Write a copied native transcript to `target` atomically: a hidden temp file in the same
 * directory (never `*.jsonl`, so vendor scanners skip leftovers), then rename. `rewrite` maps
 * native IDs; null copies the bytes unchanged.
 */
export async function writeMigratedTranscript(
  source: Readable,
  target: string,
  rewrite: TranscriptRewrite | null,
  assertStillValid?: () => void,
): Promise<void> {
  const dir = path.dirname(target);
  await fsp.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const steps = rewrite ? [new TranscriptLines(rewrite)] : [];
    await pipeline(source, ...steps, createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
    assertStillValid?.();
    try {
      await fsp.rename(temp, target);
    } catch (error) {
      // Windows cannot rename over an existing file. Only a crashed attempt of this same
      // copy can own `target` (copied native IDs are unique per copy), so replace it.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EEXIST') throw error;
      await fsp.rm(target, { force: true });
      await fsp.rename(temp, target);
    }
    // The import may have lost ownership during the rename; the caller then throws before
    // journaling `target`, so withdraw it here instead of leaving it orphaned.
    try {
      assertStillValid?.();
    } catch (error) {
      await fsp.rm(target, { force: true });
      throw error;
    }
  } finally {
    await fsp.rm(temp, { force: true });
  }
}
