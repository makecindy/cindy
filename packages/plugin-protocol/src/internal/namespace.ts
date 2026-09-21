import { PluginProtocolError } from './parse.js';

/** Permanent organization slugs and generated org-* identifiers. */
export function isValidPluginNamespace(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(value);
}

/** Missing is an old protocol, never an implicit root namespace. */
export function parseOptionalNamespace(
  raw: Record<string, unknown>,
  path: string,
): { namespace?: string | null } {
  if (!Object.prototype.hasOwnProperty.call(raw, 'namespace')) return {};
  if (raw.namespace !== null && !isValidPluginNamespace(raw.namespace)) {
    throw new PluginProtocolError(`${path}.namespace 不合法`);
  }
  return { namespace: raw.namespace as string | null };
}
