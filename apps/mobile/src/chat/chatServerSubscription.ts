import { chatCursor, chatHttpsUrl, chatId } from './chatServerClient';

export interface ChatSocket {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string): void;
  close(): void;
  readonly readyState: number;
}
/** One focused view owns one socket. Reconnect re-reads state, never replays a write. */
export function subscribeChatServer(options: {
  baseUrl: string; token(): Promise<string | null>; current(): boolean;
  socket(url: string): ChatSocket;
  ready(actorId: string): Promise<{ scope: string; cursor: string }>;
  changed(): void; unavailable(): void; available?(): void;
}) {
  let stopped = false;
  let socket: ChatSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let delay = 1000;
  const current = (candidate: ChatSocket) => !stopped && options.current() && socket === candidate;
  const connect = async () => {
    try {
      const token = await options.token();
      if (stopped || !options.current()) return;
      if (!token) throw new Error('UNAUTHENTICATED');
      const url = new URL(chatHttpsUrl(options.baseUrl));
      url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/ws`; url.protocol = 'wss:';
      const ws = options.socket(url.href); socket = ws;
      deadline = setTimeout(() => ws.close(), 15000);
      ws.onopen = () => { if (current(ws)) ws.send(JSON.stringify({ type: 'auth', token })); else ws.close(); };
      let scope: string | undefined;
      ws.onmessage = event => {
        if (!current(ws)) return;
        void (async () => {
          const value = JSON.parse(String(event.data));
          if (value.type === 'ready') {
            clearTimeout(deadline);
            const subscription = await options.ready(chatId(value.actorId));
            if (current(ws) && ws.readyState === 1) {
              scope = subscription.scope; delay = 1000;
              ws.send(JSON.stringify({ type: 'subscribe', scope, after: chatCursor(subscription.cursor) }));
              options.available?.();
            }
          } else if (value.type === 'changes' && scope && value.scope === scope) {
            options.changed();
            ws.send(JSON.stringify({ type: 'ack', scope: value.scope, cursor: chatCursor(value.cursor) }));
          } else if (value.type === 'scope_error' && scope && value.scope === scope) {
            // A full authenticated reload clears removed membership and resets expired cursors.
            options.changed();
            if (value.error?.code === 'RESET_REQUIRED' && value.error?.details?.head) {
              ws.send(JSON.stringify({ type: 'subscribe', scope: value.scope, after: chatCursor(value.error.details.head) }));
            } else { stopped = true; options.unavailable(); ws.close(); }
          } else if (value.type === 'error') ws.close();
        })().catch(() => { if (current(ws)) ws.close(); });
      };
      ws.onerror = () => { if (current(ws)) ws.close(); };
      ws.onclose = () => { if (current(ws)) { clearTimeout(deadline); schedule(); } };
    } catch { if (!stopped && options.current()) schedule(); }
  };
  const schedule = () => {
    options.unavailable();
    clearTimeout(retry);
    retry = setTimeout(() => { void connect(); }, delay);
    delay = Math.min(delay * 2, 15000);
  };
  void connect();
  return () => { stopped = true; clearTimeout(retry); clearTimeout(deadline); socket?.close(); };
}
