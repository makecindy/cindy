import type { WsLike } from '@cindy/device-link';
import { recordDeviceLinkWireFrame } from '@/debug/deviceLinkTraffic';

type EventName = 'open' | 'message' | 'close' | 'error';

export function createRnWebSocket(url: string, headers: Record<string, string>): WsLike {
  return new RnWsLike(url, headers);
}

function readErrorMessage(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null;
  const message = (event as { message?: unknown }).message;
  return typeof message === 'string' && message.length > 0 ? message : null;
}

class RnWsLike implements WsLike {
  private readonly ws: WebSocket;
  private readonly listeners: Record<EventName, Set<(arg?: unknown, extra?: unknown) => void>> = {
    open: new Set(),
    message: new Set(),
    close: new Set(),
    error: new Set(),
  };

  constructor(url: string, headers: Record<string, string>) {
    const WebSocketCtor = globalThis.WebSocket as unknown as new (
      url: string,
      protocols?: string | string[] | null,
      options?: { headers?: Record<string, string> },
    ) => WebSocket;
    this.ws = new WebSocketCtor(url, undefined, { headers });
    this.ws.onopen = () => this.emit('open');
    this.ws.onmessage = (event) => {
      recordDeviceLinkWireFrame('in', event.data);
      this.emit('message', { toString: () => String(event.data ?? '') });
    };
    this.ws.onclose = (event) => this.emit('close', event.code, event.reason);
    this.ws.onerror = (event) => {
      // RN 的 error 事件带 message(如升级失败的 "Expected HTTP 101 response but
      // was '401 Unauthorized'"),是 401 等握手失败唯一可辨因的信息,必须透传——
      // client 侧 classifyConnectionIssue 靠它区分鉴权失败与普通网络断线。
      const message = readErrorMessage(event) ?? 'WebSocket error';
      this.emit('error', new Error(message));
    };
  }

  send(data: string): void {
    recordDeviceLinkWireFrame('out', data);
    this.ws.send(data);
  }

  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }

  // RN 的 WebSocket 没有 Node ws 的 terminate(硬断);client 侧半开死链回收
  // (心跳僵死 / 握手超时)依赖本方法存在,这里用 close 尽力等价实现——
  // 死链上 close 帧发不出去也无妨,RN 侧会直接释放本地资源。
  terminate(): void {
    try {
      this.ws.close();
    } catch {
      // 已断开的 socket close 可能抛,忽略
    }
  }

  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: { toString(): string }) => void): void;
  on(event: 'close', cb: (code: number, reason?: unknown) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(
    event: EventName,
    cb:
      | (() => void)
      | ((data: { toString(): string }) => void)
      | ((code: number, reason?: unknown) => void)
      | ((err: Error) => void),
  ): void {
    this.listeners[event].add(cb as (arg?: unknown, extra?: unknown) => void);
  }

  private emit(event: 'open'): void;
  private emit(event: 'message', data: { toString(): string }): void;
  private emit(event: 'close', code: number, reason?: unknown): void;
  private emit(event: 'error', err: Error): void;
  private emit(event: EventName, arg?: unknown, extra?: unknown): void {
    for (const cb of this.listeners[event]) cb(arg, extra);
  }
}
