/**
 * Transport-layer user-facing copy (text the bot posts into the chat, connection
 * status reasons shown in the host's settings UI).
 *
 * The package has no locale catalogue of its own. A host injects a resolver with
 * `setTransportTextResolver`; every string is resolved at send time through `tt`,
 * so a language switch takes effect on the next message. Without a resolver — or
 * when the resolver does not know a key (returns null) — the built-in Chinese copy
 * is used, which keeps the package usable standalone.
 *
 * Keys live under `imBot.text.transport.*`; `{{name}}` placeholders are filled from
 * `vars`. A numeric `vars.count` lets the host pick plural forms.
 */

export type TransportTextVars = Record<string, string | number>;
export type TransportTextResolver = (key: string, vars?: TransportTextVars) => string | null;

let resolver: TransportTextResolver | null = null;

/** Install (or clear with `null`) the host's lookup for transport copy. */
export function setTransportTextResolver(fn: TransportTextResolver | null): void {
  resolver = fn;
}

const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;

function fill(template: string, vars?: TransportTextVars): string {
  if (!vars) return template;
  return template.replace(PLACEHOLDER, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Resolve transport copy `key`; fall back to `fallbackZh` (the original Chinese text,
 * `{{var}}` placeholders allowed) when no resolver is installed or it has no entry.
 */
export function tt(key: string, fallbackZh: string, vars?: TransportTextVars): string {
  if (resolver) {
    try {
      const resolved = resolver(key, vars);
      if (typeof resolved === 'string' && resolved.length > 0) return resolved;
    } catch {
      // A broken host lookup must never stop a message from going out.
    }
  }
  return fill(fallbackZh, vars);
}
