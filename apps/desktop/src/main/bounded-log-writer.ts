import type { Writable } from 'node:stream';

/** Accounts for outstanding writes, including streams already evicted by the slot LRU. */
export class BoundedLogWriter {
  private bytes = 0;
  private records = 0;

  constructor(private readonly maxBytes = 4 * 1024 * 1024, private readonly maxRecords = 4096) {}

  canAccept(line: string): boolean {
    return this.bytes + Buffer.byteLength(line) <= this.maxBytes && this.records < this.maxRecords;
  }

  write(stream: Writable, line: string): boolean {
    const bytes = Buffer.byteLength(line);
    if (stream.destroyed || stream.writableEnded || stream.writableNeedDrain
      || !this.canAccept(line)) return false;
    this.bytes += bytes;
    this.records++;
    let settled = false;
    const release = (): void => {
      if (settled) return;
      settled = true;
      this.bytes -= bytes;
      this.records--;
    };
    try {
      stream.write(line, release);
      return true; // false from Writable.write means accepted, but pause subsequent writes.
    } catch {
      release();
      return false;
    }
  }
}
