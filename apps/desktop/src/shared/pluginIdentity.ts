import { isValidPluginNamespace } from '@cindy/plugin-protocol';
import { ghostInstallApprovalToken, isValidGhostId, type GhostInstallApproval } from './ghost.js';

interface InstalledGhostIdentitySource {
  manifest: { id: string };
  dir?: string;
  namespace?: string | null;
}

function isGhostIdValue(value: string): boolean {
  return isValidGhostId(value);
}

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
  if (hasDeliveryNamespace(left) !== hasDeliveryNamespace(right)) return false;
  if (!hasDeliveryNamespace(left) || !hasDeliveryNamespace(right)) return true;
  return left.namespace === right.namespace;
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
    Object.prototype.hasOwnProperty.call(download, 'namespace');
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
export const PLUGIN_ROOT_INSTALL_ROOT = '_root';

/** Posix-style relative id: `helper` or `_ns/acme/helper`. Safe for directories. */
export function pluginInstallRelId(identity: PluginLogicalIdentity): string {
  if (identity.namespace === null) return identity.ghostId;
  return `${PLUGIN_NS_INSTALL_ROOT}/${identity.namespace}/${identity.ghostId}`;
}

export function pluginNewInstallRelId(identity: PluginLogicalIdentity): string {
  return identity.namespace === null
    ? `${PLUGIN_ROOT_INSTALL_ROOT}/${identity.ghostId}`
    : pluginInstallRelId(identity);
}

export function pluginInstallStoragePart(relId: string): string {
  const identity = parsePluginInstallRelId(relId);
  if (!identity) throw new Error('插件安装目录不合法');
  return relId.startsWith(`${PLUGIN_ROOT_INSTALL_ROOT}/`)
    ? `${PLUGIN_ROOT_INSTALL_ROOT}__${identity.ghostId}`
    : pluginStoragePart(identity);
}

export function parsePluginInstallRelId(value: string): PluginLogicalIdentity | null {
  if (isGhostIdValue(value)) return { namespace: null, ghostId: value };
  const parts = value.split('/');
  if (parts.length === 2 && parts[0] === PLUGIN_ROOT_INSTALL_ROOT && isValidGhostId(parts[1])) {
    return { namespace: null, ghostId: parts[1] };
  }
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
 * Do not persist pluginInstallRelId (`/`) as a vault or file name.
 */
export function pluginStoragePart(identity: PluginLogicalIdentity): string {
  if (identity.namespace === null) return identity.ghostId;
  return `${PLUGIN_NS_INSTALL_ROOT}__${identity.namespace}__${identity.ghostId}`;
}

export function parsePluginStoragePart(value: string): PluginLogicalIdentity | null {
  if (isGhostIdValue(value)) return { namespace: null, ghostId: value };
  const rootPrefix = `${PLUGIN_ROOT_INSTALL_ROOT}__`;
  if (value.startsWith(rootPrefix) && isValidGhostId(value.slice(rootPrefix.length))) {
    return { namespace: null, ghostId: value.slice(rootPrefix.length) };
  }
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

/** Runtime / UI instance id: helper, _ns/acme/helper, or _ns__acme__helper. */
export function parsePluginInstanceId(value: string): PluginLogicalIdentity | null {
  return parsePluginInstallRelId(value) ?? parsePluginStoragePart(value);
}

export function pluginInstanceInstallRelId(value: string): string | null {
  if (parsePluginInstallRelId(value)) return value;
  const identity = parsePluginStoragePart(value);
  if (!identity) return null;
  return value.startsWith(PLUGIN_ROOT_INSTALL_ROOT + '__')
    ? pluginNewInstallRelId(identity) : pluginInstallRelId(identity);
}

/** Runtime / UI instance id: storage part or install rel id. */
export function isGhostInstanceId(value: unknown): value is string {
  return typeof value === 'string' && parsePluginInstanceId(value) !== null;
}

export function installedGhostPhysicalRelId(ghost: InstalledGhostIdentitySource): string {
  if (typeof ghost.dir === 'string') {
    const fromDir = parseInstallRelIdFromDir(ghost.dir, ghost.manifest.id);
    if (fromDir) return fromDir;
  }
  return pluginInstallRelId(installedGhostLogicalIdentity(ghost));
}

function parseInstallRelIdFromDir(dir: string, ghostId: string): string | null {
  const normalized = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalized.endsWith(`/${PLUGIN_ROOT_INSTALL_ROOT}/${ghostId}`)) {
    return `${PLUGIN_ROOT_INSTALL_ROOT}/${ghostId}`;
  }
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

export function installedGhostStoragePart(ghost: InstalledGhostIdentitySource): string {
  return installedGhostPhysicalKeys(ghost).storagePart;
}

/**
 * Library / vault keys are storage parts. Prefer the installed ghost so an
 * in-place stamp keeps the original directory; otherwise canonicalize an IPC
 * instance id (`helper`, `_ns/acme/helper`, `_ns__acme__helper`).
 */
export function resolvePluginLibraryStorageKey(
  instanceId: string,
  ghost?: InstalledGhostIdentitySource | null,
): string | null {
  if (ghost) return installedGhostStoragePart(ghost);
  const relId = pluginInstanceInstallRelId(instanceId);
  return relId ? pluginInstallStoragePart(relId) : null;
}

/**
 * Directory and vault/runtime keys for an already-installed ghost.
 *
 * After an in-place namespace stamp the logical identity is namespaced, but the
 * plugin still lives at the original root directory. Deriving keys from
 * `installedGhostLogicalIdentity` stops/uninstalls `_ns/<ns>/<id>` while OAuth,
 * KV and the runtime stay on `<id>`.
 */
export function installedGhostPhysicalKeys(
  ghost: InstalledGhostIdentitySource,
): { relId: string; storagePart: string } {
  const relId = installedGhostPhysicalRelId(ghost);
  return { relId, storagePart: pluginInstallStoragePart(relId) };
}

export function installedGhostMutationTargetToken(
  ghost: InstalledGhostIdentitySource & { dir: string; approval: GhostInstallApproval },
  ownerScopeKey: string,
): string | null {
  if (ghost.approval.state !== 'approved') return null;
  return JSON.stringify([
    ownerScopeKey,
    ghost.dir,
    installedGhostStoragePart(ghost),
    ghostInstallApprovalToken(ghost.approval),
    deliveryNamespaceFields(ghost),
  ]);
}

export function installedGhostLogicalIdentity(
  ghost: InstalledGhostIdentitySource,
): PluginLogicalIdentity {
  return createPluginLogicalIdentity(
    hasDeliveryNamespace(ghost) ? ghost.namespace : null,
    ghost.manifest.id,
  );
}

export function findInstalledGhostByIdentity<T extends {
  manifest: { id: string };
  namespace?: string | null;
  namespaceMigration?: 'pending';
}>(ghosts: readonly T[], identity: PluginLogicalIdentity): T | undefined {
  const rel = pluginInstallRelId(identity);
  return ghosts.find(
    (ghost) => ghost.namespaceMigration !== 'pending' &&
      pluginInstallRelId(installedGhostLogicalIdentity(ghost)) === rel,
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
  const byDirectory = ghosts.find((ghost) => installedGhostPhysicalRelId(ghost) === instanceId);
  if (byDirectory) return byDirectory;
  if (instanceId.startsWith(PLUGIN_ROOT_INSTALL_ROOT + '/') ||
      instanceId.startsWith(PLUGIN_ROOT_INSTALL_ROOT + '__')) return undefined;
  const identity = parsePluginInstanceId(instanceId);
  return identity ? findInstalledGhostByIdentity(ghosts, identity) : undefined;
}

export function findInstalledGhostForLocalUpdate<T extends {
  manifest: { id: string };
  dir?: string;
  namespace?: string | null;
  approval: GhostInstallApproval;
}>(ghosts: readonly T[], ghostId: string, instanceId: string, approvalToken: string): T | undefined {
  if (!isValidPluginStoragePart(instanceId)) return undefined;
  const ghost = findInstalledGhostByInstanceId(ghosts, instanceId);
  return ghost?.manifest.id === ghostId && installedGhostStoragePart(ghost) === instanceId &&
    ghostInstallApprovalToken(ghost.approval) === approvalToken ? ghost : undefined;
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

/**
 * Pick the installed instance a delivery/install target should update.
 * Known namespace (including root null) matches that identity only.
 * Omitted namespace is allowed only when ghostId is unique; two same-name
 * instances must not silently share consent or an update.
 */
export function findInstalledGhostForDeliveryTarget<
  T extends { manifest: { id: string }; namespace?: string | null },
>(ghosts: readonly T[], target: { ghostId: string; namespace?: string | null }): T | undefined {
  if (hasDeliveryNamespace(target)) {
    return findInstalledGhostByIdentity(
      ghosts,
      createPluginLogicalIdentity(target.namespace, target.ghostId),
    );
  }
  const resolved = resolveInstalledGhost(ghosts, target.ghostId);
  return resolved.status === 'unique' ? resolved.ghost : undefined;
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

/** JSON-safe ledger / map key. Root and legacy stay `ghostId`; org uses storage part. */
export function pluginLedgerRecordKey(plugin: {
  ghostId: string;
  namespace?: string | null;
}): string {
  if (hasDeliveryNamespace(plugin) && plugin.namespace !== null) {
    return pluginStoragePart(createPluginLogicalIdentity(plugin.namespace, plugin.ghostId));
  }
  return plugin.ghostId;
}

/**
 * Same slash-command in a different known namespace may coexist.
 * A legacy (unstamped) holder still conflicts with everyone.
 */
export function findConflictingGhostCommand<
  T extends {
    manifest: { id: string; command?: string };
    dir?: string;
    namespace?: string | null;
  },
>(
  ghosts: readonly T[],
  command: string,
  opts: {
    incomingNamespace: string | null;
    exemptPhysicalRelId?: string;
  },
): T | undefined {
  const fold = command.toLowerCase();
  return ghosts.find((ghost) => {
    if (ghost.manifest.command === undefined) return false;
    if (ghost.manifest.command.toLowerCase() !== fold) return false;
    if (opts.exemptPhysicalRelId !== undefined) {
      const rel = installedGhostPhysicalRelId(ghost);
      if (rel === opts.exemptPhysicalRelId) return false;
    }
    if (!hasDeliveryNamespace(ghost)) return true;
    return ghost.namespace === opts.incomingNamespace;
  });
}

export function listGhostsByCommand<
  T extends { enabled?: boolean; manifest: { command?: string } },
>(ghosts: readonly T[], word: string, enabledOnly = true): T[] {
  const fold = word.toLowerCase();
  return ghosts.filter((ghost) => {
    if (enabledOnly && ghost.enabled === false) return false;
    return ghost.manifest.command !== undefined && ghost.manifest.command.toLowerCase() === fold;
  });
}
