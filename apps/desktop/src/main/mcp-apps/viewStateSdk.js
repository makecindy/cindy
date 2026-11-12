/// <reference path="../../../resources/system-skills/cindy-plugin-creator/references/examples/interactive-pages/cindy-ext-apps.d.ts" />
import { McpUiResourceTeardownResultSchema } from '@modelcontextprotocol/ext-apps';

const key = 'cindy/view-state';
const controllers = new WeakMap();
const failure = code => Object.assign(new Error(code), { code });
const channel = app => {
  const caps = app?.getHostCapabilities();
  return caps?.viewState ? { key: 'viewState', method: 'ui/set-view-state' }
    : caps?.experimental?.[key] ? { key, method: 'cindy/view-state/set' } : undefined;
};

// Reject values JSON.stringify would silently change; never invoke state accessors.
function snapshot(value) {
  const invalid = () => { throw failure(-32602); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  let nodes = 0;
  const seen = new Set();
  function visit(item, depth) {
    if (++nodes > 8192) invalid();
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (!item || typeof item !== 'object' || depth > 16 || seen.has(item)) invalid();
    const array = Array.isArray(item);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Reflect.ownKeys(item).some(k => typeof k !== 'string') ||
        Object.values(descriptors).some(d => !('value' in d))) invalid();
    if (item.type === 'resource_link' && typeof item.uri === 'string' && /^(cindy-media:|library:|handoff:)/i.test(item.uri)) invalid();
    if (array && (Object.keys(item).length !== item.length || Object.keys(item).some((k, i) => k !== String(i)))) invalid();
    seen.add(item);
    for (const [k, d] of Object.entries(descriptors)) {
      if (array && k === 'length') continue;
      if (!d.enumerable) invalid();
      visit(d.value, depth + 1);
    }
    seen.delete(item);
  }
  visit(value, 1);
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).length > 65536) invalid();
  return json;
}

/**
 * @template {Record<string, unknown>} T
 * @param {import('@cindy/ext-apps').ConnectedApp} app
 * @param {T} initial
 * @param {import('@cindy/ext-apps').ViewStateOptions} [options]
 * @returns {import('@cindy/ext-apps').ViewState<T>}
 */
export function createViewState(app, initial, { debounceMs = 500 } = {}) {
  // Initialization is only the first snapshot. Component remounts share the
  // App's current draft, acknowledgements and single-flight writer.
  const existing = controllers.get(app);
  if (existing) return existing;
  const route = channel(app);
  let value = initial;
  const saved = route && app.getHostContext()?.[route.key];
  if (saved && typeof saved === 'object' && !Array.isArray(saved) &&
      Object.hasOwn(initial, 'version') && Object.hasOwn(saved, 'version') && saved.version === initial.version) {
    try { snapshot(saved); value = saved; } catch { /* Invalid history must not erase itself. */ }
  }
  function entry(next) {
    try { return { value: next, json: snapshot(next) }; }
    catch (error) { return { value: next, error }; }
  }
  let current = entry(value), timer, active, pending, disposed = false, listening = false;
  const subscribers = new Set();
  function listen() {
    if (!listening) { globalThis.addEventListener?.('pagehide', controller.dispose, { once: true }); listening = true; }
  }
  const delay = Number.isFinite(debounceMs) ? Math.max(0, debounceMs) : 500;
  function warn(item, error) {
    if (item.warned) return;
    item.warned = true;
    // Never print the state, server error message or any other plugin-controlled text.
    console.warn(error?.code === -32602 ? 'VIEW_STATE_INVALID' : 'VIEW_STATE_SAVE_FAILED');
  }
  function pump() {
    if (disposed || active || !pending) return;
    const batch = active = pending;
    pending = undefined;
    const item = batch.item;
    Promise.resolve().then(() => {
      if (disposed) throw failure('VIEW_STATE_DISPOSED');
      if (item.error) throw item.error;
      return app.request({ method: route.method, params: { state: JSON.parse(item.json) } }, McpUiResourceTeardownResultSchema);
    }).then(() => {
      item.saved = true;
      batch.resolve();
    }, error => {
      item.error = error;
      if (error?.code !== 'VIEW_STATE_DISPOSED') warn(item, error);
      batch.reject(error);
    }).finally(() => { active = undefined; pump(); });
  }
  function enqueue() {
    if (disposed) return Promise.reject(failure('VIEW_STATE_DISPOSED'));
    if (!route) return Promise.reject(failure('VIEW_STATE_UNSUPPORTED'));
    if (current.saved) return Promise.resolve();
    if (current.error) { warn(current, current.error); return Promise.reject(current.error); }
    if (active?.item === current) return active.promise;
    if (pending) { pending.item = current; return pending.promise; }
    listen();
    const batch = { item: current };
    batch.promise = new Promise((resolve, reject) => { batch.resolve = resolve; batch.reject = reject; });
    pending = batch;
    pump();
    return batch.promise;
  }
  const controller = {
    get: () => current.value,
    subscribe(listener) {
      if (!disposed) subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    set(next) {
      if (disposed) return;
      const value = typeof next === 'function' ? next(current.value) : next;
      if (Object.is(value, current.value)) return;
      const item = entry(value);
      if (item.json !== undefined && item.json === current.json) return;
      current = item;
      if (route) {
        listen();
        clearTimeout(timer);
        if (pending) pending.item = current;
        timer = setTimeout(() => { timer = undefined; void enqueue().catch(() => {}); }, delay);
      }
      for (const listener of subscribers) listener();
    },
    flush() { clearTimeout(timer); timer = undefined; return enqueue(); },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      pending?.reject(failure('VIEW_STATE_DISPOSED'));
      pending = undefined;
      subscribers.clear();
      if (controllers.get(app) === controller) controllers.delete(app);
      globalThis.removeEventListener?.('pagehide', controller.dispose);
    },
  };
  controllers.set(app, controller);
  return controller;
}

export function flushViewState(app) {
  return controllers.get(app)?.flush() ?? Promise.reject(failure('VIEW_STATE_UNSUPPORTED'));
}
