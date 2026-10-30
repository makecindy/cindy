import type { ClientRequest } from 'node:http';
import type { TLSSocket } from 'node:tls';

/** Times are milestones from dial start, not durations to add together.
 * A proxy agent may return an already-connected tunnel: unavailable TCP/TLS
 * events stay absent rather than being misreported as zero-cost handshakes.
 * Never collect request URLs, headers, addresses, tokens or response bodies.
 */
export function createWebSocketHandshakeTiming(now: () => number = () => performance.now()) {
  const startedAt = now();
  const elapsed = () => Math.max(0, Math.round(now() - startedAt));
  const timing: {
    socketAssignedMs?: number;
    dnsResolvedMs?: number;
    tcpConnectedMs?: number;
    tlsConnectedMs?: number;
    upgradeResponseMs?: number;
    responseWaitMs?: number;
    reusedSocket?: boolean;
    tlsResumed?: boolean;
  } = {};
  let request: ClientRequest | undefined;

  return {
    finishRequest(req: ClientRequest): void {
      request = req;
      req.once('socket', (socket) => {
        timing.socketAssignedMs = elapsed();
        const tls = socket as TLSSocket;
        if (tls.encrypted) timing.tlsResumed = tls.isSessionReused();
        socket.once('lookup', (error) => {
          if (!error) timing.dnsResolvedMs = elapsed();
        });
        socket.once('connect', () => {
          timing.tcpConnectedMs = elapsed();
        });
        socket.once('secureConnect', () => {
          timing.tlsConnectedMs = elapsed();
          timing.tlsResumed = tls.isSessionReused();
        });
      });
      const responded = () => {
        timing.upgradeResponseMs = elapsed();
        timing.reusedSocket = req.reusedSocket;
        const ready = timing.tlsConnectedMs ?? timing.tcpConnectedMs ?? timing.socketAssignedMs;
        if (ready !== undefined) timing.responseWaitMs = timing.upgradeResponseMs - ready;
      };
      // Capture before ws emits open synchronously from its upgrade handler.
      req.prependOnceListener('upgrade', responded);
      req.prependOnceListener('response', responded);
      // ws delegates end() to finishRequest. Never add an await here.
      req.end();
    },
    snapshot() {
      return { ...timing, reusedSocket: request?.reusedSocket };
    },
  };
}
