/** Compiled ahead of time: Hermes must never serialize Function#toString. No native imports. */
export interface SettingsBootstrapConfig {
  pageId: string;
  manifestId: string;
  files: string[];
  theme: { dark: boolean; colors: Record<string, string> };
}
export function settingsBootstrap(config: SettingsBootstrapConfig) {
  const scope = window as unknown as Record<string, any>;
  const nativeFetch = window.fetch.bind(window);
  const quietConsole = Object.fromEntries(
    [
      "log",
      "info",
      "debug",
      "warn",
      "error",
      "assert",
      "trace",
      "table",
      "dir",
      "group",
      "groupEnd",
      "time",
      "timeEnd",
      "clear",
      "count",
    ].map((name) => [name, () => {}]),
  );
  Object.defineProperty(window, "console", {
    value: Object.freeze(quietConsole),
  });
  window.addEventListener("error", (event) => event.preventDefault());
  window.addEventListener("unhandledrejection", (event) =>
    event.preventDefault(),
  );
  // The approved exception is transient input only. Never offer browser persistence or workers.
  const blockedStorage = Object.freeze({
    getItem: () => null,
    key: () => null,
    length: 0,
    setItem: () => {
      throw new DOMException("Settings storage disabled", "SecurityError");
    },
    removeItem: () => {},
    clear: () => {},
  });
  for (const name of ["localStorage", "sessionStorage"])
    Object.defineProperty(window, name, { value: blockedStorage });
  for (const name of [
    "indexedDB",
    "caches",
    "Worker",
    "SharedWorker",
    "RTCPeerConnection",
  ])
    Object.defineProperty(window, name, { value: undefined });
  Object.defineProperty(navigator, "serviceWorker", { value: undefined });
  Object.defineProperty(navigator, "credentials", { value: undefined });
  Object.defineProperty(navigator, "clipboard", { value: undefined });
  navigator.sendBeacon = () => false;
  const sensitiveValues = new Set<string>();
  const remember = (value: unknown) => {
    if (typeof value !== "string" || !value) return;
    sensitiveValues.add(value);
    if (sensitiveValues.size > 64)
      sensitiveValues.delete(sensitiveValues.values().next().value!);
  };
  const containsSensitiveInput = (data: unknown) => {
    // Defense against accidental reuse of a credential form value in an old BC payload.
    // Arbitrary encoded/custom BC credentials still violate the author contract and are unsupported.
    document.querySelectorAll("input,textarea").forEach((node) => {
      const input = node as HTMLInputElement;
      if (
        input.type === "password" ||
        /secret|token|api.?key|password/i.test(input.id + " " + input.name)
      )
        remember(input.value);
    });
    const json = JSON.stringify(data);
    return [...sensitiveValues].some((value) =>
      json.includes(JSON.stringify(value).slice(1, -1)),
    );
  };
  const pending = new Map<
    number,
    {
      resolve(value: any): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let sequence = 0,
    closed = false;
  const send = (command: unknown, timeout = 30_000): Promise<any> => {
    if (closed) return Promise.reject(new Error("PLUGIN_SETTINGS_CLOSED"));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("PLUGIN_SETTINGS_RESULT_UNKNOWN"));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      try {
        scope.ReactNativeWebView.postMessage(
          JSON.stringify({ settings: config.pageId, id, command }),
        );
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error("PLUGIN_SETTINGS_UNAVAILABLE"));
      }
    });
  };
  const channels = new Map<string, Set<RemoteChannel>>();
  let subscriptions = Promise.resolve();
  scope.__cindySettingsReceive = (value: any) => {
    if (closed) return;
    if (value.kind === "reply") {
      const work = pending.get(value.id);
      if (!work) return;
      clearTimeout(work.timer);
      pending.delete(value.id);
      if (value.ok) work.resolve(value.value);
      else work.reject(new Error("PLUGIN_SETTINGS_REQUEST_FAILED"));
    } else if (value.kind === "events") {
      for (const event of value.events)
        for (const channel of channels.get(event.channel) ?? [])
          channel.deliver(event.data);
    }
  };
  scope.__cindySettingsTheme = (theme: SettingsBootstrapConfig["theme"]) => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme.dark);
    root.dataset.theme = theme.dark ? "dark" : "light";
    root.style.colorScheme = theme.dark ? "dark" : "light";
    for (const [name, value] of Object.entries(theme.colors))
      root.style.setProperty("--" + name, value);
    window.dispatchEvent(new Event("cindy-theme-change"));
  };
  scope.__cindySettingsTheme(config.theme);
  const urlFor = (input: string) => {
    const url = new URL(input, location.href);
    if (url.protocol === "cindy-ghost:" && url.hostname === config.manifestId)
      return new URL(url.pathname + url.search + url.hash, location.origin);
    if (url.origin !== location.origin)
      throw new Error("PLUGIN_SETTINGS_NETWORK_BLOCKED");
    return url;
  };
  const api = (url: URL) =>
    /^\/(kv|app-context|agent-models|media-models|secrets|oauth|connections|wake)(\/|$)/.test(
      url.pathname,
    );
  window.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = urlFor(request?.url ?? String(input));
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    if (!api(url)) {
      if (
        method !== "GET" ||
        !config.files.includes(decodeURIComponent(url.pathname.slice(1)))
      )
        throw new Error("PLUGIN_SETTINGS_NETWORK_BLOCKED");
      return nativeFetch(url.href, init);
    }
    const body =
      init?.body === undefined
        ? request && method !== "GET"
          ? await request.text()
          : undefined
        : init.body;
    if (body !== undefined && body !== null && typeof body !== "string")
      throw new TypeError("String settings body required");
    if (
      typeof body === "string" &&
      /^(\/secrets\/|\/connections\/|\/oauth\/)/.test(url.pathname)
    ) {
      try {
        const values = JSON.parse(body);
        for (const [name, value] of Object.entries(values))
          if (
            url.pathname.startsWith("/secrets/") ||
            /secret|token|password|api.?key/i.test(name)
          )
            remember(value);
      } catch {
        /* The original Host executor validates malformed JSON; it is never logged. */
      }
    }
    const timeout = /^\/oauth\/[^/]+\/connect$/.test(url.pathname)
      ? 330_000
      : url.pathname.startsWith("/connections/") && method !== "GET"
        ? 120_000
        : 30_000;
    const result = await send(
      {
        kind: "fetch",
        path: url.pathname + url.search,
        method,
        ...(body == null ? {} : { body }),
      },
      timeout,
    );
    // Host settings executors return PluginPageFetchResult, including Base64 bytes.
    const bytes = Uint8Array.from(atob(result.base64), (character) =>
      character.charCodeAt(0),
    );
    return new Response(
      [204, 205, 304].includes(result.status) ? null : bytes,
      {
        status: result.status,
        headers: { "content-type": result.mime },
      },
    );
  };
  class SettingsXHR extends EventTarget {
    static readonly UNSENT = 0;
    static readonly OPENED = 1;
    static readonly HEADERS_RECEIVED = 2;
    static readonly LOADING = 3;
    static readonly DONE = 4;
    readonly UNSENT = 0;
    readonly OPENED = 1;
    readonly HEADERS_RECEIVED = 2;
    readonly LOADING = 3;
    readonly DONE = 4;
    readyState = 0;
    status = 0;
    statusText = "";
    responseURL = "";
    responseType = "";
    response: any = null;
    timeout = 0;
    withCredentials = false;
    upload = new EventTarget();
    onreadystatechange: any = null;
    onload: any = null;
    onerror: any = null;
    onabort: any = null;
    onloadend: any = null;
    onloadstart: any = null;
    onprogress: any = null;
    ontimeout: any = null;
    private text = "";
    private method = "GET";
    private url = "";
    private mime = "";
    private generation = 0;
    private sent = false;
    get responseText() {
      if (this.responseType && this.responseType !== "text")
        throw new DOMException("Invalid response type", "InvalidStateError");
      return this.text;
    }
    get responseXML() {
      return null;
    }
    private emit(name: string) {
      const event = new Event(name);
      (this as any)["on" + name]?.(event);
      this.dispatchEvent(event);
    }
    private state(value: number) {
      this.readyState = value;
      this.emit("readystatechange");
    }
    open(
      method: string,
      url: string,
      async = true,
      username?: string,
      password?: string,
    ) {
      if (!async || username || password)
        throw new DOMException(
          "Unsupported settings request",
          "NotSupportedError",
        );
      this.generation++;
      this.method = method.toUpperCase();
      this.url = urlFor(String(url)).href;
      this.status = 0;
      this.text = "";
      this.response = null;
      this.mime = "";
      this.sent = false;
      this.state(1);
    }
    setRequestHeader(name: string, _value: string) {
      if (
        this.readyState !== 1 ||
        !["content-type", "accept"].includes(name.toLowerCase())
      )
        throw new DOMException(
          "Unsupported settings header",
          "NotSupportedError",
        );
    }
    getResponseHeader(name: string) {
      return this.readyState >= 2 && name.toLowerCase() === "content-type"
        ? this.mime
        : null;
    }
    getAllResponseHeaders() {
      return this.readyState >= 2 ? "content-type: " + this.mime + "\r\n" : "";
    }
    overrideMimeType(mime: string) {
      this.mime = mime;
    }
    send(body?: string) {
      if (this.readyState !== 1 || this.sent)
        throw new DOMException("Request not opened", "InvalidStateError");
      this.sent = true;
      const generation = this.generation;
      const controller = new AbortController();
      let timedOut = false;
      const timer =
        this.timeout > 0
          ? setTimeout(() => {
              if (generation !== this.generation) return;
              timedOut = true;
              controller.abort();
              this.generation++;
              this.status = 0;
              this.state(4);
              this.emit("timeout");
              this.emit("loadend");
            }, this.timeout)
          : undefined;
      this.emit("loadstart");
      void window
        .fetch(this.url, {
          method: this.method,
          ...(body == null ? {} : { body }),
          signal: controller.signal,
        })
        .then(async (response) => {
          if (generation !== this.generation) return;
          this.status = response.status;
          this.statusText = response.statusText;
          this.responseURL = this.url;
          this.mime ||= response.headers.get("content-type") ?? "";
          this.state(2);
          this.state(3);
          const bytes = await response.arrayBuffer();
          if (generation !== this.generation) return;
          const text = new TextDecoder().decode(bytes);
          this.text = text;
          this.response =
            this.responseType === "json"
              ? (() => {
                  try {
                    return JSON.parse(text);
                  } catch {
                    return null;
                  }
                })()
              : this.responseType === "arraybuffer"
                ? bytes
                : this.responseType === "blob"
                  ? new Blob([bytes], { type: this.mime })
                  : text;
          this.state(4);
          this.emit("progress");
          this.emit("load");
          this.emit("loadend");
        })
        .catch(() => {
          if (generation !== this.generation || timedOut) return;
          this.status = 0;
          this.state(4);
          this.emit("error");
          this.emit("loadend");
        })
        .finally(() => clearTimeout(timer));
    }
    abort() {
      this.generation++;
      this.status = 0;
      this.state(0);
      this.emit("abort");
      this.emit("loadend");
    }
  }
  scope.XMLHttpRequest = SettingsXHR;
  class RemoteChannel extends EventTarget {
    readonly name: string;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onmessageerror: ((event: MessageEvent) => void) | null = null;
    private closed = false;
    constructor(name: string) {
      super();
      this.name = String(name);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(this.name))
        throw new TypeError("Invalid channel");
      const group = channels.get(this.name) ?? new Set();
      group.add(this);
      channels.set(this.name, group);
      subscriptions = subscriptions
        .catch(() => {})
        .then(() => send({ kind: "subscribe", channels: [this.name] }));
      void subscriptions.catch(() => this.error());
    }
    postMessage(data: unknown) {
      if (this.closed)
        throw new DOMException("Channel closed", "InvalidStateError");
      const copy = JSON.parse(JSON.stringify(data));
      if (containsSensitiveInput(copy))
        throw new DOMException(
          "Credential values cannot use BroadcastChannel",
          "SecurityError",
        );
      void subscriptions
        .then(() => send({ kind: "post", channel: this.name, data: copy }))
        .catch(() => this.error());
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      const group = channels.get(this.name);
      group?.delete(this);
      if (!group?.size) {
        channels.delete(this.name);
        subscriptions = subscriptions
          .catch(() => {})
          .then(() => send({ kind: "unsubscribe", channel: this.name }));
        void subscriptions.catch(() => {});
      }
    }
    deliver(data: unknown) {
      if (!this.closed) {
        const event = new MessageEvent("message", { data });
        this.onmessage?.(event);
        this.dispatchEvent(event);
      }
    }
    private error() {
      if (!this.closed) {
        const event = new MessageEvent("messageerror");
        this.onmessageerror?.(event);
        this.dispatchEvent(event);
      }
    }
  }
  scope.BroadcastChannel = RemoteChannel;
  let resizeObserver: ResizeObserver | undefined;
  let controlObserver: MutationObserver | undefined;
  const adaptControlFonts = (root: Element) => {
    const adapt = (control: Element) => {
      if (
        control instanceof HTMLInputElement &&
        ![
          "text",
          "password",
          "email",
          "number",
          "search",
          "tel",
          "url",
        ].includes(control.type)
      )
        return;
      // Small editable text triggers iOS focus zoom; preserve larger author typography.
      if (parseFloat(window.getComputedStyle(control).fontSize) < 16)
        (control as HTMLElement).style.fontSize = "16px";
    };
    if (root.matches("input,textarea,select")) adapt(root);
    root.querySelectorAll("input,textarea,select").forEach(adapt);
  };
  const adaptControls = () => {
    if (closed) return;
    adaptControlFonts(document.documentElement);
    controlObserver = new MutationObserver((records) => {
      if (closed) return;
      for (const record of records)
        for (const node of record.addedNodes)
          if (node instanceof Element) adaptControlFonts(node);
    });
    controlObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  };
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", adaptControls, {
      once: true,
    });
  else adaptControls();
  window.addEventListener(
    "pagehide",
    () => {
      closed = true;
      for (const work of pending.values()) {
        clearTimeout(work.timer);
        work.reject(new Error("PLUGIN_SETTINGS_CLOSED"));
      }
      pending.clear();
      channels.clear();
      sensitiveValues.clear();
      resizeObserver?.disconnect();
      controlObserver?.disconnect();
      document.removeEventListener("DOMContentLoaded", adaptControls);
      window.name = "";
      document.querySelectorAll("input,textarea").forEach((input) => {
        (input as HTMLInputElement).value = "";
      });
    },
    { once: true },
  );
  const resize = () => {
    if (!closed)
      scope.ReactNativeWebView.postMessage(
        JSON.stringify({
          settings: config.pageId,
          height: Math.ceil(
            document.body?.scrollHeight ??
              document.documentElement.scrollHeight,
          ),
        }),
      );
  };
  window.addEventListener("load", resize);
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(document.documentElement);
  }
}
