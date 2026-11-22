/** ACP v1 client. No OAuth, backend HTTP, credentials, or provider fallbacks live here. */
export interface AcpTransport {
  write(line: string): void;
  onLine(listener: (line: string) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): Promise<void>;
  /** Process exit confirmation, even if a previous close attempt timed out. */
  readonly whenExited?: Promise<void>;
}
export type AcpRecord = Record<string, unknown>;
export type AcpResponse = { result: AcpRecord } | { error: Error };
export function record(value: unknown): AcpRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as AcpRecord : {};
}
export class AcpError extends Error {
  constructor(readonly code: number, quota = false) {
    // Upstream error text may contain authorization URLs or credentials. Never forward it.
    super(quota ? 'Google 返回额度或速率限制，请检查订阅额度。' : code === -32000 ? 'Google 登录已失效，请在 Cindy 中重新登录。' :
      code === 429 ? 'Google 订阅额度已用尽；未切换 API 或使用额外 credits。' : `ACP 请求失败 (${code})`);
  }
}
export class AcpClient {
  private nextId = 0;
  private closed = false;
  private pending = new Map<number, {
    resolve: (v: AcpRecord) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    onResponse?: (response: AcpResponse) => void;
  }>();
  private unsub: Array<() => void>;
  onNotification: (method: string, params: AcpRecord) => void = () => {};
  onRequest: (method: string, params: AcpRecord, signal: AbortSignal) => Promise<unknown> = async () => { throw new AcpError(-32601); };
  private requests = new Set<AbortController>();
  constructor(private transport: AcpTransport, private onClose?: () => void) {
    this.unsub = [transport.onLine(line => { void this.receive(line).catch(() => this.ended()); }), transport.onClose(() => this.ended())];
  }
  request(method: string, params: AcpRecord, timeoutMs = 30_000, onSent?: () => void, onResponse?: (response: AcpResponse) => void): Promise<AcpRecord> {
    if (this.closed) return Promise.reject(new AcpError(-32001));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new AcpError(-32002)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, onResponse });
      try { this.send({ jsonrpc: '2.0', id, method, params }); onSent?.(); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new AcpError(-32001)); }
    });
  }
  notify(method: string, params: AcpRecord): void { this.send({ jsonrpc: '2.0', method, params }); }
  cancelPermissions(): void { for (const controller of this.requests) controller.abort(); }
  private send(message: AcpRecord): void {
    if (this.closed) throw new AcpError(-32001);
    this.transport.write(JSON.stringify(message) + '\n');
  }
  private async receive(line: string): Promise<void> {
    if (this.closed) return;
    let msg: AcpRecord;
    try { msg = record(JSON.parse(line)); } catch { this.ended(); return; }
    if (msg.jsonrpc !== '2.0') { this.ended(); return; }
    if (typeof msg.method === 'string') {
      const params = record(msg.params);
      if (msg.id === undefined) { this.onNotification(msg.method, params); return; }
      if (typeof msg.id !== 'string' && typeof msg.id !== 'number') return;
      const controller = new AbortController(); this.requests.add(controller);
      try {
        const result = await this.onRequest(msg.method, params, controller.signal);
        if (!this.closed) this.send({ jsonrpc: '2.0', id: msg.id, result });
      } catch {
        if (!this.closed) this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Client request failed' } });
      } finally { this.requests.delete(controller); }
      return;
    }
    if (typeof msg.id !== 'number') return;
    const pending = this.pending.get(msg.id); if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(msg.id);
    if (msg.error) {
      const error = record(msg.error);
      const quota = typeof error.message === 'string' && /quota|resource.exhausted|rate.limit/i.test(error.message);
      const failure = new AcpError(typeof error.code === 'number' ? error.code : -32603, quota);
      pending.reject(failure);
      pending.onResponse?.({ error: failure });
    }
    else {
      const result = record(msg.result);
      pending.resolve(result);
      pending.onResponse?.({ result });
    }
  }
  private ended(notify = true): void {
    if (this.closed) return;
    this.closed = true; this.cancelPermissions();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new AcpError(-32001)); }
    this.pending.clear();
    if (notify) this.onClose?.();
  }
  async close(): Promise<void> { this.ended(false); for (const unsub of this.unsub) unsub(); await this.transport.close(); }
}
