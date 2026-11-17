import WebSocket from 'ws';
import type { LinkTrafficTotals } from '../../shared/deviceLinkIpc';
import { createOutboundHttpAgentWithDecision, type OutboundSocketProxyDecision } from '../maker-host/outbound-fetch.desktop';
import { currentLinkTraffic } from './linkTraffic.desktop';

/**
 * 建连选项 = ws 的 ClientOptions + 一条「这条 socket 选定的出站判定」的回调。
 *
 * 诊断(#9537)要报的是**活着的 socket**走没走代理,而不是「现在这份系统 / PAC 配置
 * 重新解析出来是什么」:socket 建立之后改了系统代理,重新解析可能与这条 socket 的结论
 * 正好相反。回调在建连那一刻(agent 已经选好出口)同步触发,调用方据此钉住判定。
 */
export type LinkWebSocketOptions = WebSocket.ClientOptions & {
  /** 建连后回报这条 socket 选定的出站判定(脱敏地址 / 直连原因)。 */
  onOutboundDecision?: (decision: OutboundSocketProxyDecision, ws: WebSocket) => void;
};

/** Measure the relay socket after frame encoding and compression. Pin its owner before the proxy lookup. */
export async function openLinkWebSocket(protocol: keyof LinkTrafficTotals, url: string, options: LinkWebSocketOptions): Promise<WebSocket> {
  const meter = currentLinkTraffic();
  const { agent, decision } = await createOutboundHttpAgentWithDecision(url);
  const { onOutboundDecision, ...clientOptions } = options;
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
      if (options.finishRequest) options.finishRequest(request, ws);
      else request.end();
    },
  });
  // 出口判定在建连那一刻就是定论:同步回报,调用方不会错过(socket 还没开始收发)。
  onOutboundDecision?.(decision, ws);
  return ws;
}
