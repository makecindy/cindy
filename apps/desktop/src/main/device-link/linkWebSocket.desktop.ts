import WebSocket from 'ws';
import type { LinkTrafficTotals } from '../../shared/deviceLinkIpc';
import { createOutboundHttpAgentWithDecision, type OutboundSocketProxyDecision } from '../maker-host/outbound-fetch.desktop';
import { currentLinkTraffic } from './linkTraffic.desktop';

export type LinkWebSocketOptions = WebSocket.ClientOptions & {
  /**
   * 这条 socket 实际用的出站判定(#9537 / #9959)。判定与建 agent 同一次解析,
   * 不会和 socket 真正走的线路分叉;调用方决定何时记账(通常挂 socket 的 open)。
   */
  onOutboundDecision?: (decision: OutboundSocketProxyDecision, ws: WebSocket) => void;
};

/** Measure the relay socket after frame encoding and compression. Pin its owner before the proxy lookup. */
export async function openLinkWebSocket(protocol: keyof LinkTrafficTotals, url: string, options: LinkWebSocketOptions): Promise<WebSocket> {
  const { onOutboundDecision, ...clientOptions } = options;
  const meter = currentLinkTraffic();
  const { agent, decision } = await createOutboundHttpAgentWithDecision(url);
  const ws = new WebSocket(url, {
    ...clientOptions,
    agent,
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
      if (clientOptions.finishRequest) clientOptions.finishRequest(request, ws);
      else request.end();
    },
  });
  onOutboundDecision?.(decision, ws);
  return ws;
}
