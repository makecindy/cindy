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
// Owner work hints only wake companions on a computer; the phone runs none. Refreshing
// for them would re-download every visible room, so acknowledge without a reload.
const onlyWorkHints = (changes: unknown) => Array.isArray(changes) && changes.length > 0
  && changes.every(change => (change as { type?: unknown } | null)?.type === 'work.available');
/** One focused view owns one socket. Reconnect re-reads state, never replays a write. */
export function subscribeChatServer(options: {
  baseUrl: string; token(): Promise<string | null>; current(): boolean;
  socket(url: string): ChatSocket;
  ready(actorId: string): Promise<{ scope: string; cursor: string } | Array<{ scope: string; cursor: string }>>;
  changed(changes?: Array<{ type: string; entityId?: string; data: unknown }>): void | Promise<void>; unavailable(): void; available?(): void;
  reset?(): Promise<void>;
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
      const scopes = new Set<string>();
      let frames = Promise.resolve();
      ws.onmessage = event => {
        if (!current(ws)) return;
        frames = frames.then(async () => {
          if (!current(ws)) return;
          const value = JSON.parse(String(event.data));
          if (value.type === 'ready') {
            clearTimeout(deadline);
            const subscription = await options.ready(chatId(value.actorId));
            if (current(ws) && ws.readyState === 1) {
              delay = 1000;
              for (const entry of Array.isArray(subscription) ? subscription : [subscription]) {
                scopes.add(entry.scope);
                ws.send(JSON.stringify({ type: 'subscribe', scope: entry.scope, after: chatCursor(entry.cursor) }));
              }
              options.available?.();
            }
          } else if (value.type === 'changes' && scopes.has(value.scope)) {
            if (!onlyWorkHints(value.changes)) await options.changed(value.changes);
            if (current(ws) && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ack', scope: value.scope, cursor: chatCursor(value.cursor) }));
          } else if (value.type === 'scope_error' && scopes.has(value.scope)) {
            // A full authenticated reload clears removed membership and resets expired cursors.
            if (value.error?.code === 'RESET_REQUIRED' && value.error?.details?.head) {
              await options.changed(value.changes);
              const head = chatCursor(value.error.details.head);
              await options.reset?.();
              if (current(ws) && ws.readyState === 1) ws.send(JSON.stringify({ type: 'subscribe', scope: value.scope, after: head }));
            } else {
              try { await options.changed(value.changes); }
              finally { stopped = true; options.unavailable(); ws.close(); }
            }
          } else if (value.type === 'error') ws.close();
        }).catch(() => { if (current(ws)) ws.close(); });
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
