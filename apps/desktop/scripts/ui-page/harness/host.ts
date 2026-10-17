// Scenario-backed replacement for the preload bridge (`window.electronAPI`).
// Unknown paths resolve to undefined, like a host without that capability, so optional
// product calls stay inert; every such read is recorded so a failing page reports which
// host data to add. Writes must be declared explicitly, normally with `forbid()`.
import type { UiPageRuntime } from './types';

type HostTree = Record<string, unknown>;

const IGNORED = new Set(['then', 'toJSON', 'constructor', '$$typeof', 'prototype', 'valueOf']);
const backing: HostTree = {};
const registry: Record<string, Set<(payload: unknown) => void>> = {};
let runtime: UiPageRuntime;

function isTree(value: unknown): value is HostTree {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function view(target: HostTree, path: string): HostTree {
  return new Proxy(target, {
    get(tree, key) {
      if (typeof key === 'symbol') return Reflect.get(tree, key);
      const name = path ? `${path}.${key}` : key;
      if (!Object.hasOwn(tree, key)) {
        if (!IGNORED.has(key) && !runtime.hostMissing.includes(name))
          runtime.hostMissing.push(name);
        return undefined;
      }
      const value = tree[key];
      return isTree(value) ? view(value, name) : value;
    },
    has: (tree, key) => Reflect.has(tree, key),
  });
}

function merge(target: HostTree, source: HostTree): void {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    if (isTree(value) && isTree(existing)) merge(existing, value);
    else target[key] = value;
  }
}

export function installHost(owner: UiPageRuntime, base: HostTree): void {
  runtime = owner;
  runtime.emit = (name, payload) => {
    const listeners = [...(registry[name] ?? [])];
    for (const listener of listeners) listener(payload);
    return listeners.length;
  };
  merge(backing, base);
  (window as unknown as { electronAPI: unknown }).electronAPI = view(backing, '');
}

/** Add scenario host APIs; nested namespaces merge with earlier registrations. */
export function registerHost(api: HostTree): void {
  merge(backing, api);
}

/** A host write the scenario must never perform: recorded and rejected. */
export function forbid(name: string) {
  return (..._args: unknown[]): never => {
    runtime.mutations.push(name);
    throw new Error(`UI page forbids host mutation: ${name}`);
  };
}

/** `onX(listener)` host subscription; a check pushes events with `ctx.emit(name, payload)`. */
export function subscription(name: string) {
  return (listener: (payload: unknown) => void) => {
    (registry[name] ??= new Set()).add(listener);
    return () => registry[name]?.delete(listener);
  };
}
