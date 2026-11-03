import { randomUUID } from "node:crypto";
import { assertRecipeCommand } from "./recipe-command.js";

export interface RecipeTransport {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  subscribe(
    listener: (method: string, params: Record<string, unknown>) => void,
  ): () => void;
  onClose?(listener: () => void): () => void;
  dispose(): void;
}

interface CaptureEntry {
  kind: "cdp";
  requestId: string;
  url: string;
  method: string;
  timestamp: number;
  requestHeaders: Record<string, unknown>;
  requestBody?: string;
  responseStatus?: number;
  responseHeaders?: Record<string, unknown>;
  responsePreview?: string;
  responseBodyFullSize?: number;
  responseBodyTruncated?: boolean;
  captureComplete?: boolean;
  error?: string;
}
interface Session {
  scope: string;
  transport: RecipeTransport;
  unsubscribe: () => void;
  timer: ReturnType<typeof setTimeout>;
  capture?: { patterns: string[]; entries: Map<string, CaptureEntry>; error?: string };
}

/** Invocation-local CDP sessions preserve object/node IDs across commands.
 * Network capture is bounded, drained on read, and released in the runner's finally. */
export class RecipeBrowserSessions {
  private readonly sessions = new Map<string, Session>();

  begin(scope: string, transport: RecipeTransport): string {
    if (this.sessions.size >= 32) {
      transport.dispose();
      throw new Error("Too many active recipe browser sessions");
    }
    const id = randomUUID();
    const timer = setTimeout(() => this.end(id), 30 * 60_000);
    timer.unref?.();
    const session: Session = { scope, transport, timer, unsubscribe: () => {} };
    const unsubscribe = transport.subscribe((method, params) => {
      void this.onEvent(session, method, params);
    });
    const stopWatchingClose = transport.onClose?.(() => this.end(id));
    session.unsubscribe = () => {
      unsubscribe();
      stopWatchingClose?.();
    };
    this.sessions.set(id, session);
    return id;
  }

  async call(
    scope: string,
    id: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    const session = this.sessions.get(id);
    if (!session || session.scope !== scope)
      throw new Error("Recipe browser session is unavailable for this target");
    if (method === "Cindy.end") {
      this.end(id);
      return {};
    }
    if (method === "Cindy.captureStart") {
      session.capture = {
        patterns: String(params.pattern ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        entries: new Map(),
      };
      await session.transport.send("Network.enable", {
        maxTotalBufferSize: 16 * 1024 * 1024,
        maxResourceBufferSize: 4 * 1024 * 1024,
        maxPostDataSize: 256 * 1024,
      });
      return {};
    }
    if (method === "Cindy.captureRead") {
      if (session.capture?.error) throw new Error(session.capture.error);
      const entries = session.capture?.entries;
      const result = [...(entries?.values() ?? [])].map((entry) => ({
        ...entry,
      }));
      for (const entry of result)
        if (params.retainIncomplete === false || entry.captureComplete)
          entries?.delete(entry.requestId);
      return { entries: result };
    }
    assertRecipeCommand(method);
    return session.transport.send(method, params);
  }

  private async onEvent(
    session: Session,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const capture = session.capture;
    if (!capture || capture.error) return;
    const requestId = String(params.requestId ?? "");
    if (!requestId) return;
    if (method === "Network.requestWillBeSent") {
      const request = params.request as
        | {
            url?: string;
            method?: string;
            headers?: Record<string, unknown>;
            postData?: string;
          }
        | undefined;
      if (
        !request?.url ||
        (capture.patterns.length &&
          !capture.patterns.some((pattern) => request.url!.includes(pattern)))
      )
        return;
      if (!capture.entries.has(requestId) && capture.entries.size >= 100) {
        const completed = [...capture.entries.values()].find(entry => entry.captureComplete);
        if (!completed) {
          // Keep the existing bound; losing any unfinished request would make
          // network-idle consumers report success without complete evidence.
          capture.error = 'Network capture capacity exceeded (100 unfinished requests)';
          return;
        }
        capture.entries.delete(completed.requestId);
      }
      capture.entries.set(requestId, {
        kind: "cdp",
        requestId,
        url: request.url,
        method: request.method ?? "GET",
        timestamp: Date.now(),
        captureComplete: false,
        requestHeaders: request.headers ?? {},
        requestBody: request.postData?.slice(0, 256_000),
      });
      return;
    }
    const entry = capture.entries.get(requestId);
    if (!entry) return;
    if (method === "Network.responseReceived") {
      const response = params.response as
        { status?: number; headers?: Record<string, unknown> } | undefined;
      entry.responseStatus = response?.status;
      entry.responseHeaders = response?.headers;
    } else if (method === "Network.loadingFailed") {
      entry.captureComplete = true;
      entry.error = "Network request failed";
    } else if (method === "Network.loadingFinished") {
      try {
        const body = (await session.transport.send("Network.getResponseBody", {
          requestId,
        })) as { body?: string; base64Encoded?: boolean };
        const text = body.body ?? '';
        entry.responseBodyFullSize = text.length;
        entry.responseBodyTruncated = text.length > 1_000_000;
        entry.responsePreview = `${body.base64Encoded ? "base64:" : ""}${text.slice(0, 1_000_000)}`;
        // Keep the total retained payload bounded as well as the entry count.
        let retained = [...capture.entries.values()].reduce(
          (sum, item) => sum + (item.responsePreview?.length ?? 0),
          0,
        );
        for (const item of capture.entries.values()) {
          if (retained <= 8_000_000) break;
          if (!item.responsePreview) continue;
          retained -= item.responsePreview?.length ?? 0;
          // Payload pressure cannot erase completion tracking.
          delete item.responsePreview;
          item.responseBodyTruncated = true;
        }
      } catch {
        entry.error = "Response body unavailable";
      }
      entry.captureComplete = true;
    }
  }

  private end(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    clearTimeout(session.timer);
    session.unsubscribe();
    session.capture?.entries.clear();
    session.transport.dispose();
  }
  dispose(): void {
    for (const id of this.sessions.keys()) this.end(id);
  }
}
