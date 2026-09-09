/**
 * Self-contained text/path helpers for the browser runtime shim.
 *
 * Upstream's text-utility-runtime pulls the OpenClaw config-dir + home-dir
 * machinery. The browser core only needs: regex escaping, home-relative path
 * expansion, home shortening for display, and a scratch CONFIG_DIR. We keep
 * these faithful but standalone (node builtins only). CONFIG_DIR defaults to a
 * neutral per-user scratch dir and is overridable via env.
 */
import os from 'node:os';
import path from 'node:path';

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Expand a leading `~` / `~/...` to the user home directory. */
export function resolveUserPath(
  input: string,
  _env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  if (!input) return '';
  if (input === '~') return homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(homedir(), input.slice(2));
  }
  return input;
}

/** Replace a leading home dir in a path with `~` for display. */
export function shortenHomePath(input: string): string {
  if (!input) return input;
  const home = os.homedir();
  if (input === home) return '~';
  if (input.startsWith(`${home}/`) || input.startsWith(`${home}\\`)) {
    return `~${input.slice(home.length)}`;
  }
  return input;
}

function defaultBrowserRuntimeConfigDir(): string {
  return path.join(os.homedir(), '.xdt-maker', 'browser-runtime');
}

/**
 * Scratch/config directory for browser runtime state. Neutral, overridable.
 * Not tied to any product config layout.
 *
 * Vendored Chrome launch joins this with `browser/<profile>/user-data` at call
 * time. Vite's main bundle `require()`s this module before `index.ts` can pin
 * `XDT_BROWSER_RUNTIME_DIR`, so the value must be refreshable after that pin.
 */
export function resolveBrowserRuntimeConfigDir(): string {
  return process.env.XDT_BROWSER_RUNTIME_DIR?.trim() || defaultBrowserRuntimeConfigDir();
}

export let CONFIG_DIR: string = resolveBrowserRuntimeConfigDir();

export function refreshBrowserRuntimeConfigDir(): void {
  CONFIG_DIR = resolveBrowserRuntimeConfigDir();
}
