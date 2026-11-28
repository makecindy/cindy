import { connect } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { createServer, type SecureContextOptions } from 'node:tls';

/** HTTP/WSS and TURN-over-TLS on one certificate and port. Browsers don't
 * consistently advertise TURN ALPN. Inspect only the first decrypted octet:
 * STUN requests begin with zero, HTTP methods with an ASCII letter. */
export function createTurnIngress(tls: SecureContextOptions, http: HttpServer, turnSocket: string) {
  const pending = new Set<import('node:net').Socket>();
  let mediaStreams = 0;
  const server = createServer({ ...tls, handshakeTimeout: 10_000 }, socket => {
    socket.setTimeout(10_000, abandon);
    socket.once('readable', () => {
      const first: Buffer | null = socket.read(1);
      if (!first) return socket.destroy();
      socket.off('timeout', abandon);
      socket.setTimeout(0);
      socket.unshift(first);
      if (first[0] !== 0) {
        http.emit('connection', socket);
        socket.resume();
        return;
      }
      if (mediaStreams >= 96) return socket.destroy();
      mediaStreams++;
      const backend = connect(turnSocket);
      backend.on('error', () => socket.destroy());
      backend.once('close', () => socket.destroy());
      socket.once('close', () => { mediaStreams--; backend.destroy(); });
      socket.pipe(backend).pipe(socket);
    });
    function abandon() { socket.destroy(); }
    socket.on('error', abandon);
  });
  server.on('connection', socket => {
    pending.add(socket);
    socket.once('close', () => pending.delete(socket));
  });
  // The TLS listener owns the port. Mirror the HTTP server lifecycle so Node
  // initializes its connection list and enforces headers/request deadlines.
  server.once('listening', () => http.emit('listening'));
  server.once('close', () => http.close());
  return { server, closeConnections() { for (const socket of pending) socket.destroy(); } };
}
