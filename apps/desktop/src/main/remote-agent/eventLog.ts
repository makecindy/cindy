/**
 * 远程 Agent 事件流的有界字节日志(被控端)。
 *
 * 每条记录是一行 JSON。控制端按游标(字节偏移)拉取：一次 poll 带的游标就是它已经完整收到的位置，
 * 之前的字节随即丢弃；回包丢失时控制端用同一游标重读，拿到的是同一段数据(幂等)。
 * 未读字节超过上限说明控制端已经跟不上或离开，由调用方结束任务。
 */
export interface EventLogRead {
  /** 数据的起始偏移(游标早于已丢弃的位置时，从仍保留的最早位置开始)。 */
  from: number;
  cursor: number;
  data?: Buffer;
  done?: true;
}

export class EventLog {
  private chunks: Buffer[] = [];
  /** chunks[0] 的起始偏移。 */
  private baseOffset = 0;
  private endOffset = 0;
  private ended = false;
  private readonly waiters = new Set<() => void>();

  constructor(private readonly maxUnreadBytes: number) {}

  get unreadBytes(): number {
    return this.endOffset - this.baseOffset;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /** 追加一条记录；超出未读上限返回 false(记录不追加)。 */
  append(item: unknown): boolean {
    if (this.ended) return false;
    const line = Buffer.from(`${JSON.stringify(item)}\n`, 'utf8');
    if (this.unreadBytes + line.length > this.maxUnreadBytes) return false;
    this.chunks.push(line);
    this.endOffset += line.length;
    this.wake();
    return true;
  }

  /** 结束日志：已有数据仍可读完。 */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.wake();
  }

  /** cursor 超出已写范围时为 false(调用方按无效处理)。 */
  isValidCursor(cursor: number): boolean {
    return cursor >= 0 && cursor <= this.endOffset;
  }

  /** cursor 之后有新数据，或日志已结束。 */
  isReady(cursor: number): boolean {
    return cursor < this.endOffset || this.ended;
  }

  /** 订阅「有新数据或结束」。 */
  onChange(listener: () => void): () => void {
    this.waiters.add(listener);
    return () => this.waiters.delete(listener);
  }

  /**
   * 立即从 cursor 读取最多 maxBytes。cursor 之前的数据视为已确认并丢弃；cursor 早于已丢弃的
   * 位置(并发 poll 中较旧的那个)时从仍保留的最早位置开始，起点由 from 标明。
   */
  readNow(cursor: number, maxBytes: number): EventLogRead {
    if (!this.isValidCursor(cursor)) throw new Error('REMOTE_AGENT_INVALID');
    this.acknowledge(cursor);
    const from = Math.max(cursor, this.baseOffset);
    if (from === this.endOffset || maxBytes <= 0) {
      return this.ended && from === this.endOffset ? { from, cursor: from, done: true } : { from, cursor: from };
    }
    const parts: Buffer[] = [];
    let size = 0;
    for (const chunk of this.chunks) {
      if (size >= maxBytes) break;
      const take = Math.min(chunk.length, maxBytes - size);
      parts.push(take === chunk.length ? chunk : chunk.subarray(0, take));
      size += take;
    }
    const next = from + size;
    return {
      from,
      cursor: next,
      data: Buffer.concat(parts, size),
      ...(this.ended && next === this.endOffset ? { done: true as const } : {}),
    };
  }

  /** 读取；没有新数据时最多等 waitMs。 */
  async read(cursor: number, maxBytes: number, waitMs: number, signal?: AbortSignal): Promise<EventLogRead> {
    if (!this.isValidCursor(cursor)) throw new Error('REMOTE_AGENT_INVALID');
    if (!this.isReady(cursor) && waitMs > 0) await waitForAny([this], waitMs, signal);
    return this.readNow(cursor, maxBytes);
  }

  private acknowledge(cursor: number): void {
    if (cursor <= this.baseOffset) return;
    let drop = cursor - this.baseOffset;
    while (drop > 0 && this.chunks.length > 0) {
      const first = this.chunks[0];
      if (first.length <= drop) {
        this.chunks.shift();
        drop -= first.length;
        this.baseOffset += first.length;
      } else {
        this.chunks[0] = first.subarray(drop);
        this.baseOffset += drop;
        drop = 0;
      }
    }
  }

  private wake(): void {
    for (const wake of [...this.waiters]) wake();
  }
}

/** 等任意一个日志有新数据(或结束)，最多 waitMs。 */
export function waitForAny(logs: readonly EventLog[], waitMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const unsubscribes: Array<() => void> = [];
    const done = () => {
      clearTimeout(timer);
      for (const unsubscribe of unsubscribes) unsubscribe();
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, waitMs);
    for (const log of logs) unsubscribes.push(log.onChange(done));
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** 控制端：把按字节到达的事件流切成行(行可能被截在两次 read 之间)。 */
export class LineSplitter {
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  constructor(private readonly maxLineBytes: number) {}

  push(data: Buffer): string[] {
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const index = data.indexOf(0x0a, start);
      if (index < 0) break;
      const piece = data.subarray(start, index);
      const line = this.pending.length ? Buffer.concat([...this.pending, piece]) : piece;
      this.pending = [];
      this.pendingBytes = 0;
      lines.push(line.toString('utf8'));
      start = index + 1;
    }
    if (start < data.length) {
      const rest = data.subarray(start);
      this.pendingBytes += rest.length;
      if (this.pendingBytes > this.maxLineBytes) throw new Error('REMOTE_AGENT_INVALID');
      this.pending.push(Buffer.from(rest));
    }
    return lines;
  }
}
