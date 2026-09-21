import { isValidPluginNamespace } from '@cindy/plugin-protocol';
import { isValidGhostId } from './ghost.js';

/**
 * A missing namespace is an old wire protocol state, not the root namespace.
 * Once an installation is committed, callers must use a known identity with
 * namespace === null for root or a non-empty namespace for an organization.
 */
export type PluginNamespaceState =
  | { kind: 'legacy' }
  | { kind: 'known'; namespace: string | null };

export interface PluginLogicalIdentity {
  namespace: string | null;
  ghostId: string;
}

const ID_SEPARATOR = '\u0000';
const ROOT_NAMESPACE_TOKEN = '@root';

export function resolvePluginNamespaceState(raw: unknown): PluginNamespaceState {
  if (!Object.prototype.hasOwnProperty.call(Object(raw), 'namespace')) {
    return { kind: 'legacy' };
  }
  const namespace = (raw as { namespace?: unknown }).namespace;
  if (namespace === null) return { kind: 'known', namespace: null };
  if (!isValidPluginNamespace(namespace)) {
    throw new Error('插件 namespace 不合法');
  }
  return { kind: 'known', namespace };
}

export function createPluginLogicalIdentity(
  namespace: string | null,
  ghostId: string,
): PluginLogicalIdentity {
  if (namespace !== null && !isValidPluginNamespace(namespace)) {
    throw new Error('插件 namespace 不合法');
  }
  if (!isValidGhostId(ghostId)) throw new Error('插件 ghostId 不合法');
  return { namespace, ghostId };
}

/**
 * Internal opaque key for ledgers, locks and storage maps.
 * Length/framing is explicit so namespace and ghostId cannot collide.
 */
export function pluginLogicalIdentityKey(identity: PluginLogicalIdentity): string {
  const namespace = identity.namespace ?? ROOT_NAMESPACE_TOKEN;
  return `${encodeURIComponent(namespace)}${ID_SEPARATOR}${encodeURIComponent(identity.ghostId)}`;
}

export function parsePluginLogicalIdentityKey(value: string): PluginLogicalIdentity {
  const separator = value.indexOf(ID_SEPARATOR);
  if (separator <= 0 || separator === value.length - 1 || value.indexOf(ID_SEPARATOR, separator + 1) !== -1) {
    throw new Error('插件复合身份键格式不合法');
  }
  let namespace: string;
  let ghostId: string;
  try {
    namespace = decodeURIComponent(value.slice(0, separator));
    ghostId = decodeURIComponent(value.slice(separator + 1));
  } catch {
    throw new Error('插件复合身份键编码不合法');
  }
  return createPluginLogicalIdentity(
    namespace === ROOT_NAMESPACE_TOKEN ? null : namespace,
    ghostId,
  );
}
