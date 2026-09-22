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

export function hasDeliveryNamespace(
  value: object,
): value is { namespace: string | null } {
  return Object.prototype.hasOwnProperty.call(value, 'namespace');
}

/** Persist only a known identity. Missing stays legacy and is not written as root. */
export function deliveryNamespaceFields(
  value: object,
): { namespace: string | null } | Record<string, never> {
  return hasDeliveryNamespace(value) ? { namespace: value.namespace } : {};
}

export function knownDeliveryNamespacesDiffer(
  left: object,
  right: object,
): boolean {
  return (
    hasDeliveryNamespace(left) &&
    hasDeliveryNamespace(right) &&
    left.namespace !== right.namespace
  );
}

export function sameDeliveryNamespaceState(left: object, right: object): boolean {
  const leftHas = hasDeliveryNamespace(left);
  const rightHas = hasDeliveryNamespace(right);
  if (leftHas !== rightHas) return false;
  return !leftHas || left.namespace === right.namespace;
}

export function downloadIdentityMatchesPlugin(
  download: {
    pluginId?: string;
    releaseId?: string;
    ghostId?: string;
    namespace?: string | null;
  },
  plugin: {
    id: string;
    ghostId: string;
    namespace?: string | null;
    currentRelease: { id: string };
  },
): boolean {
  const hasDownloadIdentity =
    download.pluginId !== undefined ||
    download.releaseId !== undefined ||
    download.ghostId !== undefined ||
    hasDeliveryNamespace(download);
  if (!hasDownloadIdentity) return true;
  return (
    download.pluginId === plugin.id &&
    download.releaseId === plugin.currentRelease.id &&
    download.ghostId === plugin.ghostId &&
    sameDeliveryNamespaceState(download, plugin)
  );
}

/** Organization-scoped installs live under this reserved content/state root. */
export const PLUGIN_NS_INSTALL_ROOT = '_ns';

/** Posix-style relative id: `helper` or `_ns/acme/helper`. Safe for directories. */
export function pluginInstallRelId(identity: PluginLogicalIdentity): string {
  if (identity.namespace === null) return identity.ghostId;
  return `${PLUGIN_NS_INSTALL_ROOT}/${identity.namespace}/${identity.ghostId}`;
}

export function parsePluginInstallRelId(value: string): PluginLogicalIdentity | null {
  if (isValidGhostId(value)) return { namespace: null, ghostId: value };
  const parts = value.split('/');
  if (
    parts.length === 3 &&
    parts[0] === PLUGIN_NS_INSTALL_ROOT &&
    isValidPluginNamespace(parts[1]) &&
    isValidGhostId(parts[2])
  ) {
    return { namespace: parts[1], ghostId: parts[2] };
  }
  return null;
}

export function isValidPluginInstallRelId(value: unknown): value is string {
  return typeof value === 'string' && parsePluginInstallRelId(value) !== null;
}

/**
 * Flat filesystem/vault/session id.
 * Root stays `helper`; organization instances use `_ns__<namespace>__<ghostId>`.
 * Double underscore is unambiguous because neither namespace nor ghostId contains `_`.
 * Do not persist pluginLogicalIdentityKey (NUL) or pluginInstallRelId (`/`) as vault or file names.
 */
export function pluginStoragePart(identity: PluginLogicalIdentity): string {
  if (identity.namespace === null) return identity.ghostId;
  return `${PLUGIN_NS_INSTALL_ROOT}__${identity.namespace}__${identity.ghostId}`;
}

export function parsePluginStoragePart(value: string): PluginLogicalIdentity | null {
  if (isValidGhostId(value)) return { namespace: null, ghostId: value };
  const prefix = `${PLUGIN_NS_INSTALL_ROOT}__`;
  if (!value.startsWith(prefix)) return null;
  const rest = value.slice(prefix.length);
  const sep = rest.indexOf('__');
  if (sep <= 0 || sep + 2 >= rest.length) return null;
  if (rest.indexOf('__', sep + 2) !== -1) return null;
  const namespace = rest.slice(0, sep);
  const ghostId = rest.slice(sep + 2);
  try {
    return createPluginLogicalIdentity(namespace, ghostId);
  } catch {
    return null;
  }
}

export function isValidPluginStoragePart(value: unknown): value is string {
  return typeof value === 'string' && parsePluginStoragePart(value) !== null;
}

/** Runtime / UI instance id: storage part or install rel id. */
export function isGhostInstanceId(value: unknown): value is string {
  return isValidPluginStoragePart(value) || isValidPluginInstallRelId(value);
}

export function installedGhostPhysicalRelId(ghost: {
  manifest: { id: string };
  dir?: string;
  namespace?: string | null;
}): string {
  if (typeof ghost.dir === 'string') {
    const fromDir = parseInstallRelIdFromDir(ghost.dir, ghost.manifest.id);
    if (fromDir) return fromDir;
  }
  return pluginInstallRelId(installedGhostLogicalIdentity(ghost));
}

function parseInstallRelIdFromDir(dir: string, ghostId: string): string | null {
  const normalized = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  const marker = `/${PLUGIN_NS_INSTALL_ROOT}/`;
  const at = normalized.lastIndexOf(marker);
  if (at >= 0) {
    const rest = normalized.slice(at + marker.length);
    const slash = rest.indexOf('/');
    if (
      slash > 0 &&
      rest.slice(slash + 1) === ghostId &&
      rest.indexOf('/', slash + 1) === -1
    ) {
      try {
        return pluginInstallRelId(createPluginLogicalIdentity(rest.slice(0, slash), ghostId));
      } catch {
        return null;
      }
    }
  }
  if (normalized === ghostId || normalized.endsWith(`/${ghostId}`)) return ghostId;
  return null;
}

export function installedGhostStoragePart(ghost: {
  manifest: { id: string };
  dir?: string;
  namespace?: string | null;
}): string {
  const identity = parsePluginInstallRelId(installedGhostPhysicalRelId(ghost));
  return pluginStoragePart(identity ?? installedGhostLogicalIdentity(ghost));
}

/**
 * Directory and vault/runtime keys for an already-installed ghost.
 *
 * After an in-place namespace stamp the logical identity is namespaced, but the
 * plugin still lives at the original root directory. Deriving keys from
 * `installedGhostLogicalIdentity` stops/uninstalls `_ns/<ns>/<id>` while OAuth,
 * KV and the runtime stay on `<id>`.
 */
export function installedGhostPhysicalKeys(ghost: {
  manifest: { id: string };
  dir?: string;
  namespace?: string | null;
}): { relId: string; storagePart: string } {
  const relId = installedGhostPhysicalRelId(ghost);
  return { relId, storagePart: installedGhostStoragePart(ghost) };
}

/** In-memory runtime map key: `helper` or `_ns/acme/helper`. */
export function installedGhostRuntimeId(ghost: {
  manifest: { id: string };
  dir?: string;
  namespace?: string | null;
}): string {
  return installedGhostPhysicalRelId(ghost);
}

export function installedGhostLogicalIdentity(ghost: {
  manifest: { id: string };
  namespace?: string | null;
}): PluginLogicalIdentity {
  return createPluginLogicalIdentity(
    hasDeliveryNamespace(ghost) ? ghost.namespace : null,
    ghost.manifest.id,
  );
}

export function findInstalledGhostByIdentity<T extends {
  manifest: { id: string };
  namespace?: string | null;
}>(ghosts: readonly T[], identity: PluginLogicalIdentity): T | undefined {
  const rel = pluginInstallRelId(identity);
  return ghosts.find(
    (ghost) => pluginInstallRelId(installedGhostLogicalIdentity(ghost)) === rel,
  );
}

/**
 * Resolve a UI/IPC instance id to the installed ghost that owns that physical
 * directory. Prefer storage-part equality so in-place migrated plugins keep
 * their original directory key instead of a logical namespaced identity.
 */
export function findInstalledGhostByInstanceId<T extends {
  manifest: { id: string };
  dir?: string;
  namespace?: string | null;
}>(ghosts: readonly T[], instanceId: string): T | undefined {
  const byStorage = ghosts.find((ghost) => installedGhostStoragePart(ghost) === instanceId);
  if (byStorage) return byStorage;
  const identity = parsePluginInstallRelId(instanceId);
  return identity ? findInstalledGhostByIdentity(ghosts, identity) : undefined;
}

export type InstalledGhostIdentityResolve<T> =
  | { status: 'missing' }
  | { status: 'unique'; ghost: T }
  | { status: 'ambiguous'; candidates: T[] };

export function listInstalledGhostsByGhostId<T extends { manifest: { id: string } }>(
  ghosts: readonly T[],
  ghostId: string,
): T[] {
  return ghosts.filter((ghost) => ghost.manifest.id === ghostId);
}

/**
 * `namespace === undefined` means the caller omitted it: unique ghostId is
 * allowed, two or more same-name instances are ambiguous.
 * `null` means root; a string means that organization.
 */
export function resolveInstalledGhost<
  T extends { manifest: { id: string }; namespace?: string | null },
>(
  ghosts: readonly T[],
  ghostId: string,
  namespace?: string | null,
): InstalledGhostIdentityResolve<T> {
  if (namespace !== undefined) {
    const ghost = findInstalledGhostByIdentity(
      ghosts,
      createPluginLogicalIdentity(namespace, ghostId),
    );
    return ghost ? { status: 'unique', ghost } : { status: 'missing' };
  }
  const candidates = listInstalledGhostsByGhostId(ghosts, ghostId);
  if (candidates.length === 0) return { status: 'missing' };
  if (candidates.length === 1) return { status: 'unique', ghost: candidates[0]! };
  return { status: 'ambiguous', candidates };
}

export function installedGhostNamespaceLabel(ghost: { namespace?: string | null }): string | null {
  return hasDeliveryNamespace(ghost) ? ghost.namespace : null;
}

export function formatInstalledGhostAmbiguity(
  ghostId: string,
  candidates: readonly { namespace?: string | null }[],
): string {
  const labels = candidates.map((candidate) => {
    const namespace = installedGhostNamespaceLabel(candidate);
    return namespace === null ? `root/${ghostId}` : `${namespace}/${ghostId}`;
  });
  return `插件 ${ghostId} 存在多个实例（${labels.join('、')}）。请指定 namespace：null 表示 root，字符串表示企业 orgSlug。`;
}
