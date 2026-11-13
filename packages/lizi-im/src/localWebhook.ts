import { createServer, type Server } from 'node:http';
import { isIP } from 'node:net';

/** Local IM ingress, shared by connections using the same listener. No cloud or scheduler. */
export class LocalWebhookReceiver {
  private server: Server | null = null;
  private starting: Promise<void> | null = null;
  private readonly routes = new Map<string, { peers: Set<string>; receive: (body: unknown) => Promise<void> }>();

  constructor(readonly host: string, readonly port: number) {
    if (!isPrivateListener(host) || !Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error('LOCAL_WEBHOOK_INVALID_LISTENER');
    }
  }

  async add(token: string, peers: string[], receive: (body: unknown) => Promise<void>): Promise<{ url: string; close(): Promise<void> }> {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(token) || !peers.length || peers.some(peer => !isIP(peer))) {
      throw new Error('LOCAL_WEBHOOK_INVALID_ROUTE');
    }
    const path = `/im/events/${token}`;
    if (this.routes.has(path)) throw new Error('LOCAL_WEBHOOK_ROUTE_IN_USE');
    this.routes.set(path, { peers: new Set(peers.map(normalizeIp)), receive });
    try { await this.start(); } catch (error) { this.routes.delete(path); throw error; }
    const address = this.server!.address();
    if (!address || typeof address === 'string') throw new Error('LOCAL_WEBHOOK_NOT_LISTENING');
    return {
      url: `http://${isIP(this.host) === 6 ? `[${this.host}]` : this.host}:${address.port}${path}`,
      close: async () => {
        this.routes.delete(path);
        if (this.routes.size || !this.server) return;
        const server = this.server;
        this.server = null;
        server.closeIdleConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      },
    };
  }

  private start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.server) return Promise.resolve();
    const server = createServer(async (req, res) => {
      const route = this.routes.get(req.url ?? '');
      const peer = normalizeIp(req.socket.remoteAddress ?? '');
      if (req.method !== 'POST' || !route || !route.peers.has(peer)) { res.writeHead(404).end(); return; }
      let size = 0;
      const chunks: Buffer[] = [];
      try {
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > 1024 * 1024) { res.writeHead(413).end(); req.destroy(); return; }
          chunks.push(chunk as Buffer);
        }
        let body: unknown;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { res.writeHead(400).end(); return; }
        if (this.routes.get(req.url ?? '') !== route) { res.writeHead(410).end(); return; }
        // The route resolves only after the receipt is durable.
        await route.receive(body);
        res.writeHead(202).end();
      } catch { if (!res.headersSent) res.writeHead(503).end(); }
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.maxConnections = 16;
    this.starting = new Promise<void>((resolve, reject) => {
      const failed = () => { server.close(); reject(new Error('LOCAL_WEBHOOK_LISTEN_FAILED')); };
      server.once('error', failed);
      server.listen(this.port, this.host, () => {
        server.off('error', failed);
        this.server = server;
        resolve();
      });
    }).finally(() => { this.starting = null; });
    return this.starting;
  }
}

function normalizeIp(ip: string): string { return ip.startsWith('::ffff:') ? ip.slice(7) : ip; }

export function isPrivateListener(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
  }
  return ip === '::1' || (isIP(ip) === 6 && /^f[cd]/i.test(ip));
}
