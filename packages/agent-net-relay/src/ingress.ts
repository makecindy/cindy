import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

/** Fixed local ingress only: no user-controlled destination, auth translation or body reserialization. */
export function createLoopbackIngress(base: string, matchesPath: (path: string) => boolean = () => true, protocol: 'http' | 'https' = 'http') {
  const target = new URL(base);
  if (target.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(target.hostname)
    || target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
    throw new Error('AGENT_NET_INGRESS_REQUIRES_LOOPBACK');
  }
  const sockets = new Set<Duplex>();
  const requests = new Set<ReturnType<typeof request>>();
  const matches = (req: IncomingMessage) => matchesPath(req.url ?? '');
  const forward = (req: IncomingMessage) => {
    const outgoing = request({ hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port,
      path: req.url, method: req.method, headers: { ...req.headers,
        'x-forwarded-for': req.socket.remoteAddress ?? '', 'x-forwarded-proto': protocol, 'x-forwarded-host': req.headers.host ?? '' } });
    requests.add(outgoing); outgoing.once('close', () => requests.delete(outgoing));
    return outgoing;
  };
  return {
    http(req: IncomingMessage, res: ServerResponse): boolean {
      if (!matches(req)) return false;
      const outgoing = forward(req);
      outgoing.on('response', (response) => {
        response.on('error', () => res.destroy());
        res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
      });
      outgoing.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.on('aborted', () => outgoing.destroy()); req.on('error', () => outgoing.destroy());
      res.on('close', () => { if (!res.writableFinished) outgoing.destroy(); });
      req.pipe(outgoing); return true;
    },
    upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
      if (!matches(req)) return false;
      const outgoing = forward(req);
      sockets.add(socket); socket.once('close', () => { sockets.delete(socket); outgoing.destroy(); });
      socket.on('error', () => outgoing.destroy()); outgoing.on('error', () => socket.destroy());
      outgoing.on('response', (response) => {
        socket.end('HTTP/1.1 ' + (response.statusCode ?? 502) + ' Upgrade Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); response.resume();
      });
      outgoing.on('upgrade', (response, backend, buffered) => {
        sockets.add(backend); backend.once('close', () => sockets.delete(backend));
        if (socket.destroyed) { backend.destroy(); return; }
        backend.on('error', () => socket.destroy()); socket.on('error', () => backend.destroy());
        backend.once('close', () => socket.destroy());
        let handshake = 'HTTP/1.1 101 Switching Protocols\r\n';
        for (let i = 0; i < response.rawHeaders.length; i += 2) handshake += response.rawHeaders[i] + ': ' + response.rawHeaders[i + 1] + '\r\n';
        socket.write(handshake + '\r\n');
        if (buffered.length) socket.write(buffered); if (head.length) backend.write(head);
        socket.pipe(backend); backend.pipe(socket);
      });
      outgoing.end(); return true;
    },
    close() { for (const pending of requests) pending.destroy(); for (const socket of sockets) socket.destroy(); },
  };
}
