import { openCdpWebSocket } from "./_generated/extension/src/browser/cdp.helpers.js";
import type { RecipeTransport } from "./recipe-sessions.js";

/** Use the runtime's authenticated/proxy-aware socket opener. Never replay writes. */
export async function openRecipeSocket(
  wsUrl: string,
): Promise<RecipeTransport> {
  const socket = openCdpWebSocket(wsUrl, { handshakeTimeoutMs: 10_000 });
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const listeners = new Set<
    (method: string, params: Record<string, unknown>) => void
  >();
  let next = 0;
  const dispose = () => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("Recipe browser connection closed"));
    }
    pending.clear();
    listeners.clear();
    socket.close();
  };
  socket.on("close", dispose);
  socket.on("error", dispose);
  socket.on("message", (bytes) => {
    let message: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { message?: string };
    };
    try {
      message = JSON.parse(String(bytes));
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error)
        item.reject(
          new Error(message.error.message ?? "Recipe CDP command failed"),
        );
      else item.resolve(message.result);
    } else if (message.method) {
      for (const listener of listeners)
        listener(message.method, message.params ?? {});
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
    socket.once("close", () =>
      reject(new Error("Recipe browser connection closed")),
    );
  });
  return {
    send(method, params) {
      if (socket.readyState !== 1)
        return Promise.reject(new Error("Recipe browser connection closed"));
      const id = ++next;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(dispose, 30_000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onClose(listener) {
      socket.on("close", listener);
      return () => {
        socket.off("close", listener);
      };
    },
    dispose,
  };
}
