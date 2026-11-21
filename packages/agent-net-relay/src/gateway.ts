import { createServer } from 'node:http';
import { createServer as createSecureServer, type Server as SecureServer } from 'node:https';
import type { Duplex } from 'node:stream';
import { createLoopbackIngress } from './ingress.js';
import { createTurnIngress } from '@cindy/device-link-relay/turn-ingress';

/** Shared external port only; the V1 and V2 kernels retain their own processes, state and authentication. */
export async function startRelayGateway(options: {
  host: string; port: number; legacyUrl: string; agentNetUrl: string;
  tls?: { cert: string | Buffer; key: string | Buffer };
  turnSocket?: string;
}): Promise<{ port: number; updateTls(value: { cert: string | Buffer; key: string | Buffer }): void; close(): Promise<void> }> {
  const protocol = options.tls ? 'https' : 'http';
  const modern = createLoopbackIngress(options.agentNetUrl, (p) => /^\/api\/agent-net(?:\/|\?|$)/.test(p), protocol);
  const legacy = createLoopbackIngress(options.legacyUrl, () => true, protocol);
  const listener = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    if (!modern.http(req, res)) legacy.http(req, res);
  };
  const server = options.tls && !options.turnSocket ? createSecureServer(options.tls, listener) : createServer(listener);
  const ingress = options.tls && options.turnSocket ? createTurnIngress(options.tls, server, options.turnSocket) : null;
  const external = ingress?.server ?? server;
  const sockets = new Set<Duplex>();
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => { if (!modern.upgrade(req, socket, head)) legacy.upgrade(req, socket, head); });
  try {
    await new Promise<void>((resolve, reject) => {
      external.once('error', reject); external.listen(options.port, options.host, () => { external.off('error', reject); resolve(); });
    });
  } catch (error) { modern.close(); legacy.close(); for (const socket of sockets) socket.destroy(); throw error; }
  let closing: Promise<void> | undefined;
  return { port: (external.address() as { port: number }).port,
    updateTls(value) {
      if (!options.tls) throw new Error('GATEWAY_TLS_NOT_ENABLED');
      (external as SecureServer).setSecureContext(value);
    },
    close() {
      closing ??= new Promise<void>((resolve) => {
        modern.close(); legacy.close(); for (const socket of sockets) socket.destroy();
        ingress?.closeConnections(); server.closeAllConnections(); external.close(() => resolve());
      }); return closing;
    },
  };
}
