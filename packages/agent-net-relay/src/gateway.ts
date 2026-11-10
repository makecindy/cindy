import { createServer } from 'node:http';
import { createServer as createSecureServer, type Server as SecureServer } from 'node:https';
import type { Duplex } from 'node:stream';
import { createLoopbackIngress } from './ingress.js';

/** Shared external port only; the V1 and V2 kernels retain their own processes, state and authentication. */
export async function startRelayGateway(options: {
  host: string; port: number; legacyUrl: string; agentNetUrl: string;
  tls?: { cert: string | Buffer; key: string | Buffer };
}): Promise<{ port: number; updateTls(value: { cert: string | Buffer; key: string | Buffer }): void; close(): Promise<void> }> {
  const protocol = options.tls ? 'https' : 'http';
  const modern = createLoopbackIngress(options.agentNetUrl, (p) => /^\/api\/agent-net(?:\/|\?|$)/.test(p), protocol);
  const legacy = createLoopbackIngress(options.legacyUrl, () => true, protocol);
  const listener = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    if (!modern.http(req, res)) legacy.http(req, res);
  };
  const server = options.tls ? createSecureServer(options.tls, listener) : createServer(listener);
  const sockets = new Set<Duplex>();
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => { if (!modern.upgrade(req, socket, head)) legacy.upgrade(req, socket, head); });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(options.port, options.host, () => { server.off('error', reject); resolve(); });
    });
  } catch (error) { modern.close(); legacy.close(); for (const socket of sockets) socket.destroy(); throw error; }
  let closing: Promise<void> | undefined;
  return { port: (server.address() as { port: number }).port,
    updateTls(value) {
      if (!options.tls) throw new Error('GATEWAY_TLS_NOT_ENABLED');
      (server as SecureServer).setSecureContext(value);
    },
    close() {
      closing ??= new Promise<void>((resolve) => {
        modern.close(); legacy.close(); for (const socket of sockets) socket.destroy();
        server.closeAllConnections(); server.close(() => resolve());
      }); return closing;
    },
  };
}
