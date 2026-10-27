import { parsePluginAuthorizationResult, type PluginOauthCallback } from "@cindy/device-link";
export interface MobileLoopbackRequest { url: string; callbackUrl: string; state: string }
export interface MobileLoopbackNative {
  start(options: { id: string; callbackUrl: string; state: string; expiresAt: number }): Promise<void>;
  wait(id: string): Promise<unknown>;
  status(id: string): Promise<string>;
  close(id: string): Promise<void>;
}
/** The receiver owns no provider credentials, browser cookies, verifier or token exchange. */
export async function receivePluginOauthLoopback(input: {
  request: MobileLoopbackRequest; expiresAt: number; signal?: AbortSignal;
  native: MobileLoopbackNative | null; id: string; platform: string;
  assertCurrent(): void;
  openBrowser(url: string): Promise<{ type: string }>;
  dismissBrowser(): Promise<void>;
  onAppState(listener: (state: string) => void): () => void;
  now?(): number;
}): Promise<PluginOauthCallback> {
  const now = input.now ?? Date.now;
  const native = input.native;
  if (!native) throw new Error("PLUGIN_OAUTH_UPDATE_REQUIRED");
  const callback = new URL(input.request.callbackUrl);
  if (callback.hostname !== "127.0.0.1" || callback.protocol !== "http:" ||
    !callback.port || Number(callback.port) < 1024 || callback.username || callback.password ||
    callback.search || callback.hash || !/^\/[A-Za-z0-9._~/-]*$/.test(callback.pathname))
    throw new Error("PLUGIN_OAUTH_CALLBACK_UNSUPPORTED");
  let closed = false, browserOpened = false, wentAway = false;
  let returnTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectCancellation!: (error: Error) => void;
  const cancelled = new Promise<never>((_, reject) => { rejectCancellation = reject; });
  const fail = () => {
    if (closed) return;
    closed = true;
    void native.close(input.id).catch(() => {});
    rejectCancellation(new Error("PLUGIN_OAUTH_CLOSED"));
  };
  const check = () => {
    input.assertCurrent();
    if (closed || input.signal?.aborted || now() >= input.expiresAt) throw new Error("PLUGIN_OAUTH_CLOSED");
  };
  const removeAppState = input.onAppState((state) => {
    if (!browserOpened) return;
    if (state === "background") {
      if (input.platform === "android") wentAway = true;
    } else if (state === "active" && wentAway && input.platform === "android") {
      wentAway = false;
      // The browser may foreground Cindy just before the JS callback promise drains.
      // Inspect the native receiver after that drain, never treat `opened` as done.
      clearTimeout(returnTimer);
      returnTimer = setTimeout(() => {
        void native.status(input.id).then((status) => { if (status !== "received") fail(); }, fail);
      }, 500);
    }
  });
  input.signal?.addEventListener("abort", fail);
  const ticker = setInterval(() => { try { check(); } catch { fail(); } }, 200);
  try {
    check();
    const starting = native.start({ id: input.id, callbackUrl: input.request.callbackUrl, state: input.request.state, expiresAt: input.expiresAt });
    // If owner/cancellation changes before a late bind resolves, close that bind too.
    void starting.then(() => { if (closed) void native.close(input.id).catch(() => {}); }, () => {});
    await Promise.race([starting, cancelled]);
    check();
    const received = native.wait(input.id);
    browserOpened = true;
    const browser = input.openBrowser(input.request.url).then((result) => {
      if (result.type !== "opened") {
        return native.status(input.id).then((status) => {
          if (status !== "received") fail();
          return new Promise<never>(() => {});
        });
      }
      return new Promise<never>(() => {});
    });
    const raw = await Promise.race([received, browser, cancelled]);
    check();
    const parsed = parsePluginAuthorizationResult({ kind: "callback", ...(raw as object) });
    if (parsed.kind !== "callback" || parsed.state !== input.request.state) throw new Error("PLUGIN_OAUTH_CLOSED");
    const { kind: _, ...value } = parsed;
    return value;
  } finally {
    closed = true;
    clearInterval(ticker); clearTimeout(returnTimer);
    input.signal?.removeEventListener("abort", fail); removeAppState();
    await native.close(input.id).catch(() => {});
    if (browserOpened && input.platform === "ios") await input.dismissBrowser().catch(() => {});
  }
}
