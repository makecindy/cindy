/**
 * Host web: usage statistics stay in the signed-in account's region (release table, 甲-1).
 *
 * The renderer this page runs is a prebuilt Desktop renderer, so its TapDB project and collector
 * were fixed when that renderer was built. The Host serves one account, whose region may differ;
 * the page must not add a cross-region upload. The renderer is reused unchanged, so the guard sits
 * on the egress itself: a request to a TapDB collector leaves only when that collector is the
 * signed-in account's own (`eventUrlByRegion[realm]`). An unknown realm (not signed in, or a value
 * outside the table) blocks every TapDB collector. Other requests are untouched.
 *
 * Covered: the vendored SDK's three transports (XMLHttpRequest, navigator.sendBeacon, an image
 * pixel through the `src` property) and fetch. Other ways to load a URL (`setAttribute('src')`,
 * iframes, scripts) are not covered; an SDK update that adopts one must extend this guard, and the
 * web-shim test drives the real SDK so a new transport shows up there. A blocked XHR send is a
 * silent no-op: firing an error would only make the SDK retry against the same collector.
 */

function originOf(url, base) {
  try { return new URL(String(url), base).origin; } catch { return null; }
}

/**
 * @param {{
 *   target: any,
 *   eventUrlByRegion: Readonly<Record<string, string>>,
 *   readRealm: () => string | null | undefined,
 * }} options
 * @returns {(url: unknown) => boolean} whether a request to `url` may leave
 */
export function installAnalyticsRegionGuard({ target, eventUrlByRegion, readRealm }) {
  const base = target.location?.href;
  const collectors = new Set(Object.values(eventUrlByRegion).map((url) => originOf(url)).filter(Boolean));
  const allowed = (url) => {
    const origin = originOf(url, base);
    if (!origin || !collectors.has(origin)) return true;
    const realm = readRealm();
    const own = realm === 'cn' || realm === 'global' ? originOf(eventUrlByRegion[realm]) : null;
    return own !== null && origin === own;
  };

  const XHR = target.XMLHttpRequest;
  if (typeof XHR === 'function' && XHR.prototype) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    XHR.prototype.open = function guardedOpen(method, url, ...rest) {
      this.__cindyAnalyticsBlocked = !allowed(url);
      return open.call(this, method, url, ...rest);
    };
    XHR.prototype.send = function guardedSend(...args) {
      if (this.__cindyAnalyticsBlocked) return undefined;
      return send.apply(this, args);
    };
  }

  const navigator = target.navigator;
  if (navigator && typeof navigator.sendBeacon === 'function') {
    const sendBeacon = navigator.sendBeacon.bind(navigator);
    try {
      Object.defineProperty(navigator, 'sendBeacon', {
        configurable: true, writable: true,
        value: (url, data) => (allowed(url) ? sendBeacon(url, data) : false),
      });
    } catch {
      navigator.sendBeacon = (url, data) => (allowed(url) ? sendBeacon(url, data) : false);
    }
  }

  const Image = target.HTMLImageElement;
  const srcDescriptor = Image?.prototype && Object.getOwnPropertyDescriptor(Image.prototype, 'src');
  if (srcDescriptor?.set && srcDescriptor.configurable) {
    Object.defineProperty(Image.prototype, 'src', {
      ...srcDescriptor,
      set(value) { if (allowed(value)) srcDescriptor.set.call(this, value); },
    });
  }

  if (typeof target.fetch === 'function') {
    const fetch = target.fetch;
    target.fetch = function guardedFetch(input, init) {
      const url = typeof input === 'string' || input instanceof URL ? input : input?.url;
      if (!allowed(url)) return Promise.reject(new TypeError('Usage statistics stay in the account region'));
      return fetch.call(this, input, init);
    };
  }
  return allowed;
}
