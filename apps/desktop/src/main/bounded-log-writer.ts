import type { Writable } from 'node:stream';

/** Accounts for outstanding writes, including streams already evicted by the slot LRU. */
export class BoundedLogWriter {
  private bytes = 0;
  private records = 0;

  constructor(private readonly maxBytes = 4 * 1024 * 1024, private readonly maxRecords = 4096) {}

  canAccept(line: string): boolean {
    return this.bytes + Buffer.byteLength(line) <= this.maxBytes && this.records < this.maxRecords;
  }

  /**
   * 提交一条写入;`onDone` 在这一次写入真的结束时回调,失败时带上错误。
   *
   * 调用方靠它区分「文件打开成功」与「内容写进去了」——ENOSPC 时前者照样成立,
   * 只有后者能作为退避复位的判据(#10790)。
   */
  write(stream: Writable, line: string, onDone?: (err?: Error | null) => void): boolean {
    const bytes = Buffer.byteLength(line);
    if (stream.destroyed || stream.writableEnded || stream.writableNeedDrain
      || !this.canAccept(line)) return false;
    this.bytes += bytes;
    this.records++;
    let settled = false;
    const release = (err?: Error | null): void => {
      if (settled) return;
      settled = true;
      this.bytes -= bytes;
      this.records--;
      onDone?.(err);
    };
    try {
      stream.write(line, release);
      return true; // false from Writable.write means accepted, but pause subsequent writes.
    } catch (err) {
      release(err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  }
}
