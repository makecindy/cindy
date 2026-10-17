import { PluginProtocolError } from './parse.js';

/** Permanent organization slugs and generated org-* identifiers. */
export function isValidPluginNamespace(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(value);
}

export const AUTHOR_DECLARED_NAMESPACE_REASON = 'ghost.json 不允许作者声明 namespace';

/** Authors cannot claim platform identity, including an explicit null. */
export function authorManifestDeclaresNamespace(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.prototype.hasOwnProperty.call(value, 'namespace'),
  );
}

export function authorDeclaredNamespaceReason(value: unknown): string | null {
  return authorManifestDeclaresNamespace(value) ? AUTHOR_DECLARED_NAMESPACE_REASON : null;
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
