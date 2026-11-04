/**
 * Browser shim for the renderer's `window.electronAPI`.
 *
 * The renderer is reused unchanged: this module publishes the same shape and
 * forwards the channels the host implements to the loopback HTTP API, using the
 * HttpOnly cookie the server sets when it serves the app. Unimplemented channels
 * reject with `HOST_CHANNEL_UNSUPPORTED` so the existing UI shows its own error
 * state instead of a fake success.
 */

(function installCindyHostShim() {
  const pending = new Map();

  async function rpc(path, args) {
    const response = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args ?? null),
      credentials: 'same-origin',
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw Object.assign(new Error(detail || `host ${path} failed`), { code: `HTTP_${response.status}` });
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  // Channel table: electronAPI paths the host actually implements.
  const routes = {
    // Host-side telemetry sink: the browser already logs to its console.
    'logToMain': () => undefined,
    // Boot-time snapshot; the host has no microphone permission surface.
    'voiceInput.getDataSnapshot': () => ({
      available: false, globalShortcut: null, settings: null, locale: 'en', shortcutRegistered: false,
    }),
    'auth.getState': () => rpc('/me'),
    'localDb.sessions.list': () => rpc('/sessions/list'),
    'localDb.sessions.messages': async (args) => rpc('/sessions/messages', args),
    'pluginMarket.listInstalled': () => rpc('/plugins/list'),
    'logToMain': () => undefined,
  };

  function unsupported(path) {
    const error = new Error(`host channel not implemented: ${path}`);
    error.code = 'HOST_CHANNEL_UNSUPPORTED';
    return Promise.reject(error);
  }

  function makeNode(path) {
    const node = function shimCall(...args) {
      window.__cindyCalls?.push(path);
      const handler = routes[path];
      return handler ? handler(args) : unsupported(path);
    };
    return new Proxy(node, {
      get(_target, prop) {
        if (prop === 'then') return undefined;
        if (typeof prop === 'symbol') return undefined;
        // Keep Function.prototype members intact: callers legitimately use
        // `fn.call(...)` on the preload functions.
        if (prop === 'call' || prop === 'apply' || prop === 'bind' || prop === 'name' || prop === 'length') {
          return Reflect.get(_target, prop, _target);
        }
        // Event registrations return an unsubscribe function, like the preload.
        if (prop.startsWith('on') && prop.length > 2 && prop[2] === prop[2].toUpperCase()) {
          return () => () => {};
        }
        return makeNode(path ? `${path}.${String(prop)}` : String(prop));
      },
    });
  }

  window.electronAPI = makeNode('');
  window.__cindyShim = true;
  window.__cindyCalls = [];
  window.__cindyErrors = [];
  window.addEventListener('error', (event) => {
    window.__cindyErrors.push(String(event.message ?? event.error ?? 'error'));
  });
  window.addEventListener('unhandledrejection', (event) => {
    window.__cindyErrors.push('rejection: ' + String(event.reason));
  });

  // Renderer diagnostics land in the browser console; the host never sees them.
  window.addEventListener('error', (event) => {
    console.error('[cindy-web] renderer error', event.error ?? event.message);
  });
  void pending;
})();
