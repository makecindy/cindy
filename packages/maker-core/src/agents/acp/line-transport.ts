/**
 * Line transport between Cindy's ACP client and one agent endpoint.
 *
 * ACP v1 frames JSON-RPC messages as newline-delimited JSON on the agent's
 * stdin/stdout. maker-core never spawns the endpoint itself: the host owns the
 * process (for plugins, a declared Node entry started by the plugin runtime) and
 * adapts it to this interface. That keeps process ownership, sandboxing and
 * platform differences out of the engine.
 */

export interface AcpTransportClosed {
  /**
   * `peer-exited`: the endpoint ended on its own (crash, EOF, killed elsewhere).
   * `closed-by-client`: Cindy closed it on purpose.
   * `protocol-error`: the stream could not be used anymore (write failure, oversized line).
   */
  reason: 'peer-exited' | 'closed-by-client' | 'protocol-error';
  /** Short host-provided diagnostic (exit code, signal). Never contains stdout payloads. */
  detail?: string;
}

export interface AcpLineTransport {
  /** Writes one JSON-RPC message. The transport appends the newline. Throws once closed. */
  write(line: string): void;
  onLine(listener: (line: string) => void): () => void;
  /** Fires at most once. */
  onClose(listener: (info: AcpTransportClosed) => void): () => void;
  /**
   * Ends the endpoint. Resolves only after the host has confirmed the endpoint
   * process is gone, so callers can treat resolution as an exit proof.
   */
  close(): Promise<void>;
}

/** Large tool outputs (diffs, file reads) arrive as single lines; this only stops runaway streams. */
export const ACP_DEFAULT_MAX_LINE_CHARS = 32 * 1024 * 1024;

export class AcpLineTooLongError extends Error {
  constructor(readonly limit: number) {
    super(`ACP message exceeded ${limit} characters`);
    this.name = 'AcpLineTooLongError';
  }
}

/**
 * Incremental newline splitter for host transports that receive stdout in
 * arbitrary chunks. Handles `\r\n`, multi-byte UTF-8 split across chunks, and a
 * trailing line without a newline on flush.
 */
export class AcpLineDecoder {
  private buffer = '';
  private readonly decoder = new TextDecoder('utf-8');

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly maxLineChars = ACP_DEFAULT_MAX_LINE_CHARS,
  ) {}

  /** Throws `AcpLineTooLongError` when a single line grows past the limit. */
  push(chunk: string | Uint8Array): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.emit(line);
      newline = this.buffer.indexOf('\n');
    }
    if (this.buffer.length > this.maxLineChars) {
      this.buffer = '';
      throw new AcpLineTooLongError(this.maxLineChars);
    }
  }

  flush(): void {
    this.buffer += this.decoder.decode();
    const rest = this.buffer;
    this.buffer = '';
    this.emit(rest);
  }

  private emit(raw: string): void {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim().length > 0) this.onLine(line);
  }
}
