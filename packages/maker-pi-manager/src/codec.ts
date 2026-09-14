/**
 * NDJSON line codec: parses a stream of chunks into RpcMessage[], one per line.
 *
 * Chunk boundaries do NOT align with line boundaries — we buffer the partial
 * tail across pushes. JSON.parse failures on individual lines are reported via
 * onCorruptLine (caller can log + ignore) without breaking the stream.
 *
 * UTF-8 safety: SSH / TCP chunks can split a multi-byte UTF-8 character across
 * buffer boundaries. Per-chunk `chunk.toString('utf8')` decodes the partial
 * byte sequence into U+FFFD replacement char + garbage, corrupting non-ASCII
 * content. Node's `StringDecoder` holds incomplete multi-byte sequences until
 * the continuation bytes arrive on the next push.
 *
 * This mirrors packages/maker-cc-manager/src/codec.ts deliberately — the
 * NDJSON codec is protocol-agnostic and the implementation is copied (not
 * shared) to keep cc-mgr byte-identical and untouched.
 */

import { StringDecoder } from 'node:string_decoder';

import { isRpcMessage, type RpcMessage } from './protocol.js';

export interface NDJSONDecoderOptions {
  /** Called when a non-empty line fails JSON.parse OR fails isRpcMessage check. */
  onCorruptLine?: (line: string, error: Error) => void;
}

export class NDJSONDecoder {
  /**
   * Hard cap on the unparsed buffer (chars). A stream that never sends a '\n'
   * (corrupt peer, truncated giant frame, hostile traffic) would otherwise grow
   * `buffer` without bound and OOM the daemon. 64M chars comfortably exceeds
   * any legitimate single NDJSON frame; hitting the cap means the stream is
   * junk — discard the buffer + report, don't accumulate.
   */
  private static readonly MAX_BUFFER_CHARS = 64 * 1024 * 1024;

  private buffer = '';
  // 非 readonly:reset() 需要重建 StringDecoder(自审轮 7 M-4)。
  private decoder = new StringDecoder('utf8');
  private readonly onCorruptLine?: (line: string, error: Error) => void;

  constructor(opts: NDJSONDecoderOptions = {}) {
    this.onCorruptLine = opts.onCorruptLine;
  }

  /**
   * Feed a chunk of incoming bytes/string. Returns any complete RpcMessages
   * extracted. The trailing partial line (if any) is buffered for the next push.
   */
  push(chunk: string | Buffer): RpcMessage[] {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    // 首块剥离 UTF-8 BOM(轮 3 #8):BOM 不在 JSON 空白定义内, 会让首条
    // 合法消息被判 corrupt。用 charCodeAt 判断避免源码内字面 BOM 字符歧义。
    if (this.buffer === '' && text.charCodeAt(0) === 0xfeff) {
      this.buffer = text.slice(1);
    } else {
      this.buffer += text;
    }
    // 恰好等于 MAX 不丢弃(edge-cases 7b 契约:恰好 64M 有 1 字节 margin 是
    // 有意设计 —— 轮 3 #9 建议 >= 与契约冲突, 已回滚)。超过才视为垃圾流。
    if (this.buffer.length > NDJSONDecoder.MAX_BUFFER_CHARS) {
      const sample = this.buffer.slice(0, 256);
      this.buffer = '';
      this.onCorruptLine?.(
        sample,
        new Error(
          `NDJSON buffer exceeded ${NDJSONDecoder.MAX_BUFFER_CHARS} chars without a complete line; discarded to prevent OOM`,
        ),
      );
      return [];
    }
    if (!this.buffer.includes('\n')) {
      return [];
    }
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    const out: RpcMessage[] = [];
    for (const raw of lines) {
      // 容忍 CRLF / 多 CR(轮 3 #6):单个 endsWith 剥不净 \r\r\n。
      const line = raw.replace(/\r+$/, '');
      if (line.trim().length === 0) continue; // 空行/纯空白行跳过(轮 3 #7)
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        this.onCorruptLine?.(line, err as Error);
        continue;
      }
      if (!isRpcMessage(parsed)) {
        this.onCorruptLine?.(line, new Error('not a valid RpcMessage shape'));
        continue;
      }
      out.push(parsed);
    }
    return out;
  }

  /**
   * Reset internal buffer. Use after socket disconnect to avoid stale partial
   * lines bleeding into a reconnect.
   * 重新初始化 StringDecoder(而非 end()):end() 使 decoder 进入终态, 之后
   * push() 会静默损坏 —— reset 后应可复用(自审轮 7 M-4)。
   */
  reset(): void {
    this.buffer = '';
    this.decoder.end();
    this.decoder = new StringDecoder('utf8');
  }
}

/**
 * Encode an RpcMessage as a single NDJSON line (with trailing '\n').
 * Caller writes the returned string verbatim to the underlying stream.
 */
export function encodeMessage(msg: RpcMessage): string {
  return JSON.stringify(msg) + '\n';
}
