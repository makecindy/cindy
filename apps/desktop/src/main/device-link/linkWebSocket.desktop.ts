import WebSocket from 'ws';
import type { LinkTrafficTotals } from '../../shared/deviceLinkIpc';
import { createOutboundHttpAgent } from '../maker-host/outbound-fetch.desktop';
import { currentLinkTraffic } from './linkTraffic.desktop';

/** Measure the relay socket after frame encoding and compression. Pin its owner before the proxy lookup. */
export async function openLinkWebSocket(protocol: keyof LinkTrafficTotals, url: string, options: WebSocket.ClientOptions): Promise<WebSocket> {
  const meter = currentLinkTraffic();
  return new WebSocket(url, {
    ...options,
    agent: await createOutboundHttpAgent(url),
    finishRequest(request, ws) {
      request.once('socket', socket => {
        // An HTTP agent can reuse a socket. Only its bytes since this handshake belong to the link.
        const sent = socket.bytesWritten, received = socket.bytesRead;
        const stop = meter.track(protocol, () => ({ sent: socket.bytesWritten - sent, received: socket.bytesRead - received }));
        let upgraded = false;
        request.once('upgrade', () => { upgraded = true; });
        ws.once('close', stop);
        request.once('close', () => {
          // A failed upgrade or redirect relinquishes its socket before the WebSocket itself closes.
          if (upgraded) return;
          ws.off('close', stop);
          stop();
        });
      });
      if (options.finishRequest) options.finishRequest(request, ws);
      else request.end();
    },
  });
}
