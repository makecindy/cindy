import type { PluginPageAsset, PluginPageDocument } from "@cindy/device-link";

export interface PageConfig {
  document: PluginPageDocument;
  assets: Record<string, PluginPageAsset>;
  theme: "light" | "dark";
  colors: Record<string, string>;
}

/** This bootstrap runs only in the isolated WebView; no native credential/IPC object. */
export function bootstrap(config: PageConfig) {
  const native = (
    window as unknown as {
      ReactNativeWebView: { postMessage(value: string): void };
    }
  ).ReactNativeWebView;
  const send = (value: Record<string, unknown>) =>
    native.postMessage(
      JSON.stringify({ ...value, pageId: config.document.pageId }),
    );
  const pending = new Map<
    string,
    {
      resolve(value: Response): void;
      reject(error: Error): void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  const channels = new Map<string, Set<MobileBroadcastChannel>>();
  const localRequests = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  const backListeners = new Set<() => void>();
  const lifecycleListeners = new Set<(active: boolean) => void>();
  const unreadListeners = new Set<(version: number) => void>();
  let unreadVersion = config.document.unreadAt;
  let active = false;
  let request = 0,
    delivered = 0;
  let closed = false;
  const receivedDeliveries = new Set<number>();
  const localRequest = (type: string, key: string, value?: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = `local:${++request}`;
      const timeout = setTimeout(() => {
        localRequests.delete(id);
        reject(new Error("PLUGIN_DRAFT_UNCONFIRMED"));
      }, 5_000);
      localRequests.set(id, { resolve, reject, timeout });
      send({ type, id, key, value });
    });
  Object.defineProperty(window, "cindyMobile", {
    value: Object.freeze({
      version: 1,
      setNavigation: (canGoBack: boolean, title?: string) =>
        send({ type: "navigation", canGoBack: canGoBack === true, title }),
      onBack: (listener: () => void) => {
        backListeners.add(listener);
        return () => backListeners.delete(listener);
      },
      onLifecycle: (listener: (active: boolean) => void) => {
        lifecycleListeners.add(listener);
        return () => lifecycleListeners.delete(listener);
      },
      onUnread: (listener: (version: number) => void) => {
        unreadListeners.add(listener);
        if (Number.isSafeInteger(unreadVersion)) {
          const version = unreadVersion!;
          queueMicrotask(() => {
            if (unreadListeners.has(listener) && unreadVersion === version)
              listener(version);
          });
        }
        return () => unreadListeners.delete(listener);
      },
      contentRendered: (version: number) => {
        if (
          config.document.surface !== "panel" ||
          !Number.isSafeInteger(version) ||
          version !== unreadVersion
        )
          return;
        requestAnimationFrame(() => {
          if (!closed && active && version === unreadVersion)
            send({ type: "content-rendered", seenAt: version });
        });
      },
      openTask: (taskId: string) =>
        send({
          type: "link",
          url: `cindy://sessions/${encodeURIComponent(taskId)}`,
        }),
      readDraft: (key: string) => localRequest("draft:get", key),
      writeDraft: (key: string, value: unknown) =>
        localRequest("draft:set", key, value),
    }),
  });
  const base = `https://plugin.invalid/${config.document.entry}`;
  const pathFor = (value: string, from = base) => {
    const url = new URL(value, from);
    if (
      url.origin !== "https://plugin.invalid" &&
      !(
        url.protocol === "cindy-ghost:" && url.host === config.document.pluginId
      )
    )
      throw new Error("PLUGIN_ORIGIN_DENIED");
    return decodeURIComponent(url.pathname.slice(1));
  };
  class MobileBroadcastChannel extends EventTarget {
    name: string;
    onmessage: ((event: MessageEvent) => void) | null = null;
    constructor(name: string) {
      super();
      if (!config.document.channels.includes(name))
        throw new Error("PLUGIN_CHANNEL_UNAVAILABLE");
      this.name = name;
      const set = channels.get(name) ?? new Set();
      set.add(this);
      channels.set(name, set);
    }
    postMessage(data: unknown) {
      send({ type: "post", channel: this.name, data });
    }
    close() {
      channels.get(this.name)?.delete(this);
    }
  }
  Object.defineProperty(window, "BroadcastChannel", {
    value: MobileBroadcastChannel,
  });
  const decode = (asset: PluginPageAsset) =>
    Uint8Array.from(atob(asset.base64), (c) => c.charCodeAt(0));
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const path = pathFor(url);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    if (path === "wake")
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    const asset = config.assets[path];
    if (asset && method === "GET")
      return new Response(decode(asset), {
        headers: { "content-type": asset.mime },
      });
    if (init?.body !== undefined && typeof init.body !== "string")
      throw new Error("PLUGIN_BODY_UNSUPPORTED");
    const parts: BlobPart[] = [];
    let offset: number | undefined,
      revision: string | undefined,
      response: Response;
    do {
      const id = String(++request);
      response = await new Promise<Response>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error("PLUGIN_REQUEST_UNCONFIRMED"));
        }, 30_000);
        pending.set(id, { resolve, reject, timeout });
        send({
          type: "fetch",
          id,
          path: "/" + path + new URL(url, base).search,
          method,
          body: init?.body,
          offset,
          revision,
        });
      });
      revision = response.headers.get("x-cindy-revision") ?? undefined;
      parts.push(await response.arrayBuffer());
      const next = response.headers.get("x-cindy-next-offset");
      if (next && Number(next) <= (offset ?? 0))
        throw new Error("PLUGIN_RESPONSE_INVALID");
      offset = next ? Number(next) : undefined;
    } while (offset !== undefined);
    return new Response(
      [204, 205, 304].includes(response.status) ? null : new Blob(parts),
      {
        status: response.status,
        headers: {
          "content-type":
            response.headers.get("content-type") ?? "application/octet-stream",
        },
      },
    );
  };
  const receive = (event: MessageEvent) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (Number.isSafeInteger(message.deliveryId)) {
      if (receivedDeliveries.has(message.deliveryId)) return;
      receivedDeliveries.add(message.deliveryId);
      if (receivedDeliveries.size > 128)
        receivedDeliveries.delete(receivedDeliveries.values().next().value!);
    }
    if (message.type === "back") {
      for (const listener of backListeners) listener();
    } else if (message.type === "lifecycle") {
      active = message.active === true;
      for (const listener of lifecycleListeners) listener(active);
    } else if (message.type === "draft:reply") {
      const waiter = localRequests.get(message.id);
      if (!waiter) return;
      localRequests.delete(message.id);
      clearTimeout(waiter.timeout);
      if (message.error) waiter.reject(new Error("PLUGIN_DRAFT_UNCONFIRMED"));
      else waiter.resolve(message.value);
    } else if (message.type === "events") {
      if (message.unreadAt !== unreadVersion) {
        unreadVersion = Number.isSafeInteger(message.unreadAt)
          ? message.unreadAt
          : undefined;
        if (unreadVersion !== undefined)
          for (const listener of unreadListeners) listener(unreadVersion);
      }
      for (const item of message.events) {
        if (!Number.isSafeInteger(item.sequence) || item.sequence <= delivered)
          continue;
        for (const channel of channels.get(item.channel) ?? []) {
          const received = new MessageEvent("message", { data: item.data });
          channel.dispatchEvent(received);
          channel.onmessage?.(received);
        }
        delivered = item.sequence;
      }
      send({ type: "events-ack", sequence: delivered });
    } else if (message.type === "theme") {
      document.documentElement.dataset.theme = message.theme;
      document.documentElement.classList.toggle(
        "dark",
        message.theme === "dark",
      );
      document.documentElement.style.colorScheme = message.theme;
      for (const [key, value] of Object.entries(
        message.colors as Record<string, string>,
      ))
        document.documentElement.style.setProperty(`--${key}`, value);
    } else if (message.type === "reply") {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timeout);
      if (message.error) waiter.reject(new Error("PLUGIN_REQUEST_UNCONFIRMED"));
      else
        waiter.resolve(
          new Response(
            [204, 205, 304].includes(message.result.status)
              ? null
              : decode(message.result),
            {
              status: message.result.status,
              headers: {
                "content-type": message.result.mime,
                ...(message.result.revision
                  ? { "x-cindy-revision": message.result.revision }
                  : {}),
                ...(message.result.nextOffset === undefined
                  ? {}
                  : {
                      "x-cindy-next-offset": String(message.result.nextOffset),
                    }),
              },
            },
          ),
        );
    }
  };
  const urls = new Map<string, string>();
  const mediaUrls = new Set<string>();
  const assetUrl = (relative: string, from = base): string => {
    if (/^(?:data:|blob:|https:)/.test(relative)) return relative;
    let key;
    try {
      key = pathFor(relative, from);
    } catch {
      return "";
    }
    if (urls.has(key)) return urls.get(key)!;
    const asset = config.assets[key];
    if (!asset) return "";
    let data: BlobPart = decode(asset);
    if (asset.mime.startsWith("text/css"))
      data = new TextDecoder()
        .decode(data as Uint8Array)
        .replace(
          /url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g,
          (_match, _quote, value) =>
            `url("${assetUrl(value, `https://plugin.invalid/${key}`)}")`,
        );
    const url = URL.createObjectURL(new Blob([data], { type: asset.mime }));
    urls.set(key, url);
    return url;
  };
  const source = config.assets[config.document.entry];
  const doc = new DOMParser().parseFromString(
    new TextDecoder().decode(decode(source)),
    "text/html",
  );
  doc.querySelectorAll("base,meta[http-equiv]").forEach((el) => el.remove());
  for (const element of Array.from(doc.querySelectorAll("[src],link[href]"))) {
    const key = element.hasAttribute("src") ? "src" : "href";
    const original = element.getAttribute(key)!;
    const resolved = assetUrl(original);
    if (resolved || element.tagName === "SCRIPT" || element.tagName === "LINK")
      element.setAttribute(key, resolved);
  }
  doc.documentElement.dataset.theme = config.theme;
  doc.documentElement.dataset.mobile = "true";
  const viewport = doc.createElement("meta");
  viewport.name = "viewport";
  viewport.content = "width=device-width,initial-scale=1,viewport-fit=cover";
  doc
    .querySelectorAll('meta[name="viewport"]')
    .forEach((element) => element.remove());
  doc.head.prepend(viewport);
  doc.documentElement.classList.toggle("dark", config.theme === "dark");
  const theme = doc.createElement("style");
  theme.textContent = `:root{color-scheme:${config.theme};${Object.entries(
    config.colors,
  )
    .map(([key, value]) => `--${key}:${value}`)
    .join(
      ";",
    )}}html,body{max-width:100%;overscroll-behavior:none}body{margin:0}input,textarea,select{font-size:max(16px,1em)}button,a,input,select{touch-action:manipulation}`;
  doc.head.append(theme);
  const csp = doc.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content =
    "default-src 'none'; script-src blob: 'unsafe-inline'; style-src blob: 'unsafe-inline'; img-src data: blob: https:; font-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
  doc.head.prepend(csp);
  document.open();
  document.write("<!doctype html>" + doc.documentElement.outerHTML);
  document.close();
  window.addEventListener("message", receive);
  document.addEventListener("message", receive as EventListener);
  document.addEventListener(
    "click",
    (event) => {
      const link = (event.target as Element)?.closest?.("a[href]");
      if (link) {
        event.preventDefault();
        send({ type: "link", url: link.getAttribute("href") });
      }
    },
    true,
  );
  const resources = new WeakMap<Element, string>();
  const resolveImages = () => {
    if (!window.document) return;
    for (const element of Array.from(
      document.querySelectorAll("img[src],video[src],audio[src],source[src]"),
    )) {
      const src = element.getAttribute("src")!;
      if (/^(?:data:|blob:|https:)/.test(src) || resources.get(element) === src)
        continue;
      resources.set(element, src);
      const local = assetUrl(src);
      if (local) {
        element.setAttribute("src", local);
        continue;
      }
      void window
        .fetch(src)
        .then((response) => {
          if (!response.ok) throw new Error("PLUGIN_RESOURCE_UNAVAILABLE");
          return response.blob();
        })
        .then((blob) => {
          if (
            !closed &&
            element.isConnected &&
            element.getAttribute("src") === src
          ) {
            const url = URL.createObjectURL(blob);
            mediaUrls.add(url);
            element.setAttribute("src", url);
          }
        })
        .catch(() => send({ type: "resource-error" }));
    }
  };
  const observer = new MutationObserver(resolveImages);
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["src"],
  });
  window.addEventListener("pagehide", () => {
    closed = true;
    observer.disconnect();
    for (const url of [...urls.values(), ...mediaUrls])
      URL.revokeObjectURL(url);
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("PLUGIN_PAGE_CLOSED"));
    }
    pending.clear();
    for (const waiter of localRequests.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("PLUGIN_PAGE_CLOSED"));
    }
    localRequests.clear();
    backListeners.clear();
    lifecycleListeners.clear();
    unreadListeners.clear();
    receivedDeliveries.clear();
    channels.clear();
  });
  resolveImages();
  // Read acknowledgement belongs to the native focused page, after it has rendered.
  const ready = () => requestAnimationFrame(() => send({ type: "ready" }));
  if (document.readyState === "complete") ready();
  else window.addEventListener("load", ready, { once: true });
}
