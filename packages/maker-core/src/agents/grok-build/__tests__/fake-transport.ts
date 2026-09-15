import type { AcpTransport, AcpCloseHandler, AcpLineHandler, AcpStderrHandler } from '../stdio-transport.js';

/** In-memory ACP transport for tests. */
export class FakeAcpTransport implements AcpTransport {
  readonly written: string[] = [];
  private lineHandlers = new Set<AcpLineHandler>();
  private stderrHandlers = new Set<AcpStderrHandler>();
  private closeHandlers = new Set<AcpCloseHandler>();
  private closed = false;
  readonly pid = 4242;

  async writeLine(line: string): Promise<void> {
    if (this.closed) throw new Error('closed');
    this.written.push(line);
  }

  onLine(handler: AcpLineHandler): () => void {
    this.lineHandlers.add(handler);
    return () => { this.lineHandlers.delete(handler); };
  }

  onStderr(handler: AcpStderrHandler): () => void {
    this.stderrHandlers.add(handler);
    return () => { this.stderrHandlers.delete(handler); };
  }

  onClose(handler: AcpCloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => { this.closeHandlers.delete(handler); };
  }

  async close(reason = 'test close'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closeHandlers) handler({ reason });
  }

  pushLine(obj: unknown): void {
    const line = typeof obj === 'string' ? obj : JSON.stringify(obj);
    for (const handler of this.lineHandlers) handler(line);
  }

  lastRequest(): { id: number; method: string; params?: unknown; jsonrpc: string } {
    const raw = this.written.at(-1);
    if (!raw) throw new Error('no request written');
    return JSON.parse(raw) as { id: number; method: string; params?: unknown; jsonrpc: string };
  }
}
