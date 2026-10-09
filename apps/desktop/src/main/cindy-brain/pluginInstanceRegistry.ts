/**
 * Per-data-owner plugin instance registry.
 *
 * instanceKey is the directory storage key (helper, _root__helper,
 * _ns__xd__helper). It is not allocated. Logical namespace still lives
 * here, because an old client can rewrite a receipt.
 *
 * Storage (KV, secrets, OAuth, library, partitions, skills) must use
 * instanceKey. Do not derive a new key from a path or namespace.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  pluginInstallStoragePart,
  parsePluginInstallRelId,
  hasDeliveryNamespace,
} from '../../shared/pluginIdentity.js';
import { isValidGhostId } from '../../shared/ghost.js';

const PLUGIN_INSTANCE_REGISTRY_V1_VERSION = 1 as const;
const PLUGIN_INSTANCE_REGISTRY_VERSION = 2 as const;
/** Live registry. v1 is read once and left on disk. */
const PLUGIN_INSTANCE_REGISTRY_FILE = 'plugin-instances.v2.json';
const PLUGIN_INSTANCE_REGISTRY_V1_FILE = 'plugin-instances.v1.json';

type PluginInstanceNamespaceState = 'confirmed' | 'unconfirmed' | 'pending';
export type PluginInstanceSource = 'legacy' | 'market' | 'manual' | 'agent-forge' | 'builtin';

export interface PluginInstanceRecord {
  instanceKey: string;
  /** Content directory relative to the plugin root. Not an identity. */
  contentRelId: string;
  ghostId: string;
  /** Last known namespace. Privileges require namespaceState === 'confirmed'. */
  namespace: string | null;
  namespaceState: PluginInstanceNamespaceState;
  pluginId: string | null;
  source: PluginInstanceSource;
  receiptRevision: string | null;
  packageSha256: string | null;
  active: boolean;
}

interface PluginInstanceCensus {
  completedAt: string;
  /** Bare directories captured once. Commit and uninstall remove ids. */
  pendingRelIds: string[];
}

export interface PluginInstanceRegistry {
  schemaVersion: typeof PLUGIN_INSTANCE_REGISTRY_VERSION;
  /** Null until the one-time upgrade census for this data owner has been stored. */
  census: PluginInstanceCensus | null;
  instances: Record<string, PluginInstanceRecord>;
}

type PluginInstanceRegistryRead =
  | { kind: 'missing' }
  | { kind: 'ok'; registry: PluginInstanceRegistry }
  | { kind: 'corrupt' }
  | { kind: 'unreadable' }
  | { kind: 'unknown-schema' };

export interface InstanceConfirmationMarketRecord {
  /** Undefined means the row has no namespace field, which is not a match. */
  namespace?: string | null;
  organizationId?: string | null;
  packageSha256?: string | null;
  scope?: 'public' | 'personal' | 'organization';
  installed?: boolean;
}

export interface InstanceConfirmationEvidence {
  /**
   * Undefined: market facts are not ready, so they cannot confirm or deny.
   * Empty: no installed market row.
   */
  marketRecords?: readonly InstanceConfirmationMarketRecord[];
  currentOrganization?: {
    organizationId: string;
    orgSlug: string | null;
  } | null;
  packageSha256?: string | null;
  /** Approved receipt is an agent-forge self-test for this install. */
  forgeSelfTest?: boolean;
}

export interface PluginInstanceReceiptFact {
  ghostId: string;
  hasNamespace: boolean;
  namespace: string | null;
  revision: string;
  packageSha256: string | null;
  installOrigin?: string;
}

export function emptyPluginInstanceRegistry(): PluginInstanceRegistry {
  return { schemaVersion: PLUGIN_INSTANCE_REGISTRY_VERSION, census: null, instances: {} };
}

export function pluginInstanceRegistryPath(stateRoot: string): string {
  return path.join(stateRoot, PLUGIN_INSTANCE_REGISTRY_FILE);
}

export function allocateArchiveInstanceKey(): string {
  return 'arch_' + crypto.randomUUID().replace(/-/g, '');
}

/** Storage key already used by an on-disk install that has no registry row yet. */
function instanceKeyForExistingContent(relId: string): string | null {
  if (!parsePluginInstallRelId(relId)) return null;
  return pluginInstallStoragePart(relId);
}

export function adoptContentInstall(input: {
  relId: string;
  ghostId: string;
  receipt: PluginInstanceReceiptFact | null;
  /** True only while the one-time upgrade census still lists this directory. */
  pendingMigration?: boolean;
}): PluginInstanceRecord | null {
  const instanceKey = instanceKeyForExistingContent(input.relId);
  if (!instanceKey || !isValidGhostId(input.ghostId)) return null;
  const origin = input.receipt?.installOrigin;
  const identity = parsePluginInstallRelId(input.relId);
  const pathNamespace = identity?.namespace ?? null;
  const confirmed = input.receipt?.hasNamespace === true;
  const pending = !confirmed && input.pendingMigration === true;
  return {
    instanceKey,
    contentRelId: input.relId,
    ghostId: input.ghostId,
    namespace: confirmed ? input.receipt!.namespace : pathNamespace,
    namespaceState: confirmed ? 'confirmed' : pending ? 'pending' : 'unconfirmed',
    pluginId: null,
    source: origin === 'agent-forge' ? 'agent-forge' : input.receipt ? 'manual' : 'legacy',
    receiptRevision: input.receipt?.revision ?? null,
    packageSha256: input.receipt?.packageSha256 ?? null,
    active: true,
  };
}

/**
 * Receipt rewrite never allocates a new instance.
 * Losing the namespace field, or disagreeing with the registry, only
 * drops confirmation. Positive confirmation is a separate call.
 */
export function reconcileInstanceReceipt(
  record: PluginInstanceRecord,
  input: { directoryPresent: boolean; receipt: PluginInstanceReceiptFact | null },
): PluginInstanceRecord {
  if (!input.directoryPresent) return record.active ? { ...record, active: false } : record;
  const next: PluginInstanceRecord = record.active ? record : { ...record, active: true };
  const receipt = input.receipt;
  if (!receipt) return next;
  if (receipt.ghostId !== record.ghostId) {
    return next.namespaceState === 'unconfirmed' ? next : { ...next, namespaceState: 'unconfirmed' };
  }
  const sameRevision = record.receiptRevision === null || receipt.revision === record.receiptRevision;
  const samePackage = record.packageSha256 === null || receipt.packageSha256 === record.packageSha256;
  if (!receipt.hasNamespace) {
    if (record.namespaceState === 'confirmed') {
      return {
        ...next,
        namespaceState: 'unconfirmed',
        receiptRevision: receipt.revision,
        packageSha256: receipt.packageSha256,
      };
    }
    if (!sameRevision || !samePackage) {
      return { ...next, receiptRevision: receipt.revision, packageSha256: receipt.packageSha256 };
    }
    return next;
  }
  if (record.namespaceState === 'confirmed' && receipt.namespace !== record.namespace) {
    return {
      ...next,
      namespaceState: 'unconfirmed',
      receiptRevision: receipt.revision,
      packageSha256: receipt.packageSha256,
    };
  }
  if (record.namespaceState === 'unconfirmed') {
    // A rewritten receipt is not positive evidence. Confirmation is separate.
    if (receipt.revision !== record.receiptRevision || receipt.packageSha256 !== record.packageSha256) {
      return { ...next, receiptRevision: receipt.revision, packageSha256: receipt.packageSha256 };
    }
    return next;
  }
  if (receipt.revision !== record.receiptRevision || receipt.packageSha256 !== record.packageSha256) {
    return { ...next, receiptRevision: receipt.revision, packageSha256: receipt.packageSha256 };
  }
  return next;
}

function shaDoesNotConflict(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return true;
  return left === right;
}

function forgeEvidenceConfirms(
  record: PluginInstanceRecord,
  evidence: InstanceConfirmationEvidence,
): boolean {
  if (evidence.forgeSelfTest !== true || !record.namespace) return false;
  if (evidence.currentOrganization?.orgSlug !== record.namespace) return false;
  return shaDoesNotConflict(evidence.packageSha256, record.packageSha256);
}

function marketEvidenceConfirms(
  record: PluginInstanceRecord,
  evidence: InstanceConfirmationEvidence,
): boolean {
  if (evidence.marketRecords === undefined) return false;
  const installed = evidence.marketRecords.filter((row) => row.installed !== false);
  if (installed.length !== 1) return false;
  const market = installed[0]!;
  if (market.namespace === undefined || market.namespace !== record.namespace) return false;
  const observed = evidence.packageSha256 ?? record.packageSha256 ?? null;
  if (!market.packageSha256 || !observed || market.packageSha256 !== observed) return false;
  if (!shaDoesNotConflict(evidence.packageSha256, record.packageSha256)) return false;
  if (!shaDoesNotConflict(evidence.packageSha256, market.packageSha256)) return false;
  if (!shaDoesNotConflict(record.packageSha256, market.packageSha256)) return false;
  if (record.namespace !== null) {
    const org = evidence.currentOrganization;
    if (!org || org.orgSlug !== record.namespace) return false;
    if (!market.organizationId || market.organizationId !== org.organizationId) return false;
    if (market.scope !== undefined && market.scope !== 'organization') return false;
    return true;
  }
  if (market.organizationId) return false;
  if (market.scope === 'organization') return false;
  return true;
}

/**
 * Move unconfirmed back to confirmed only with positive evidence.
 * The namespace must already be the one stored on the record. This does not
 * invent an organization from a prefix, a path, or a rewritten receipt.
 */

export function marketRowMatchesUnconfirmedInstance(
  row: {
    installed?: boolean;
    namespace?: string | null;
    scope?: 'public' | 'personal' | 'organization';
    organizationId?: string | null;
  },
  record: PluginInstanceRecord,
  currentOrganization: { organizationId: string; orgSlug: string | null } | null,
): boolean {
  const hasNamespace = hasDeliveryNamespace(row);
  if (hasNamespace) return (row.namespace ?? null) === record.namespace;
  if (record.namespace === null) return row.scope !== 'organization';
  return row.scope === 'organization' &&
    currentOrganization !== null &&
    row.organizationId === currentOrganization.organizationId &&
    currentOrganization.orgSlug === record.namespace;
}

export function confirmUnconfirmedInstance(
  record: PluginInstanceRecord,
  evidence: InstanceConfirmationEvidence,
): { namespace: string | null } | null {
  if (!record.active || record.namespaceState !== 'unconfirmed') return null;
  if (forgeEvidenceConfirms(record, evidence) || marketEvidenceConfirms(record, evidence)) {
    return { namespace: record.namespace };
  }
  return null;
}

export function confirmInstanceNamespace(
  registry: PluginInstanceRegistry,
  instanceKey: string,
  namespace: string | null,
  receipt: { revision: string; packageSha256: string | null },
): PluginInstanceRegistry {
  const record = registry.instances[instanceKey];
  if (!record) return registry;
  const conflict = Object.values(registry.instances).some((other) =>
    other.instanceKey !== instanceKey &&
    other.active &&
    other.namespaceState === 'confirmed' &&
    other.ghostId === record.ghostId &&
    other.namespace === namespace);
  if (conflict) return registry;
  const next: PluginInstanceRecord = {
    ...record,
    namespace,
    namespaceState: 'confirmed',
    receiptRevision: receipt.revision,
    packageSha256: receipt.packageSha256,
    active: true,
  };
  return { ...registry, instances: { ...registry.instances, [instanceKey]: next } };
}

export function upsertInstance(
  registry: PluginInstanceRegistry,
  record: PluginInstanceRecord,
): PluginInstanceRegistry {
  return { ...registry, instances: { ...registry.instances, [record.instanceKey]: record } };
}

export function findInstanceByContentRelId(
  registry: PluginInstanceRegistry,
  relId: string,
): PluginInstanceRecord | undefined {
  return Object.values(registry.instances).find((record) => record.contentRelId === relId);
}

/** Active install that must not be replaced by another copy of the same identity. */
export function findBlockingInstance(
  registry: PluginInstanceRegistry,
  ghostId: string,
  namespace: string | null,
): PluginInstanceRecord | null {
  return Object.values(registry.instances).find((record) => {
    if (!record.active || record.ghostId !== ghostId) return false;
    if (record.namespaceState === 'confirmed' && record.namespace === namespace) return true;
    return record.namespaceState === 'pending' && record.contentRelId === record.ghostId;
  }) ?? null;
}

export function findReusableInstance(
  registry: PluginInstanceRegistry,
  query: { ghostId: string; namespace: string | null; pluginId?: string | null; source?: PluginInstanceSource },
): PluginInstanceRecord | null {
  const matches = Object.values(registry.instances).filter((record) => {
    if (record.active || record.ghostId !== query.ghostId) return false;
    if (record.namespaceState === 'pending') {
      return query.namespace === null && record.namespace === null && record.contentRelId === record.ghostId;
    }
    return record.namespace === query.namespace;
  });
  const sameSource = (record: PluginInstanceRecord): boolean => {
    if (!query.source) return true;
    if (record.source === query.source) return true;
    // A pre-receipt directory is not a different product source.
    return query.source === 'manual' && record.source === 'legacy';
  };
  if (query.pluginId) {
    const exact = matches.find((record) => record.pluginId === query.pluginId && sameSource(record));
    if (exact) return exact;
    // An upgraded install has no market id yet. Reuse it only when it is the
    // single unlabeled candidate, so two markets do not take each other's data
    // and one upgraded market install can be reattached.
    const unlabeled = matches.filter((record) =>
      record.pluginId == null && (record.source === 'legacy' || record.source === 'manual'));
    return unlabeled.length === 1 ? unlabeled[0]! : null;
  }
  if (query.source) {
    const sourced = matches.filter(sameSource);
    return sourced.length === 1 ? sourced[0]! : null;
  }
  return matches.length === 1 ? matches[0]! : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseRecord(value: unknown, instanceKey: string): PluginInstanceRecord | null {
  if (!isPlainObject(value)) return null;
  if (value.instanceKey !== instanceKey || typeof value.instanceKey !== 'string') return null;
  if (typeof value.contentRelId !== 'string' || value.contentRelId.length === 0) return null;
  if (!isValidGhostId(value.ghostId)) return null;
  if (value.namespace !== null && typeof value.namespace !== 'string') return null;
  if (value.namespaceState !== 'confirmed' && value.namespaceState !== 'unconfirmed' && value.namespaceState !== 'pending') return null;
  if (value.pluginId !== null && typeof value.pluginId !== 'string') return null;
  if (value.source !== 'legacy' && value.source !== 'market' && value.source !== 'manual' &&
      value.source !== 'agent-forge' && value.source !== 'builtin') return null;
  if (value.receiptRevision !== null && typeof value.receiptRevision !== 'string') return null;
  if (value.packageSha256 !== null && typeof value.packageSha256 !== 'string') return null;
  if (typeof value.active !== 'boolean') return null;
  return {
    instanceKey,
    contentRelId: value.contentRelId,
    ghostId: value.ghostId,
    namespace: value.namespace,
    namespaceState: value.namespaceState,
    pluginId: value.pluginId,
    source: value.source,
    receiptRevision: value.receiptRevision,
    packageSha256: value.packageSha256,
    active: value.active,
  };
}


interface PendingCensusProjectionEntry {
  ghostId: string;
  relId: string;
  capturedAt: string;
  status: 'pending';
}

/** Pending namespaceState is the migration entry. Inactive rows stay until release. */
export function projectPendingCensus(
  registry: PluginInstanceRegistry,
): { censusedAt: string; entries: Record<string, PendingCensusProjectionEntry> } | null {
  if (!registry.census) return null;
  const capturedAt = registry.census.completedAt;
  const entries: Record<string, PendingCensusProjectionEntry> = {};
  for (const relId of registry.census.pendingRelIds) {
    if (!isValidGhostId(relId)) continue;
    entries[relId] = { ghostId: relId, relId, capturedAt, status: 'pending' };
  }
  return { censusedAt: capturedAt, entries };
}

/** A v1 row already on disk takes the imported pending state. Do not allocate a new row. */
export function noteImportedPending(
  registry: PluginInstanceRegistry,
  relId: string,
): PluginInstanceRegistry {
  const existing = findInstanceByContentRelId(registry, relId) ?? registry.instances[relId];
  if (!existing || existing.namespaceState !== 'unconfirmed') return registry;
  return upsertInstance(registry, { ...existing, namespaceState: 'pending' });
}

export function finishInstanceCensus(
  registry: PluginInstanceRegistry,
  completedAt: string,
  pendingRelIds: readonly string[],
): PluginInstanceRegistry {
  return { ...registry, census: { completedAt, pendingRelIds: [...new Set(pendingRelIds)] } };
}

export function clearCensusPending(
  registry: PluginInstanceRegistry,
  relId: string,
): PluginInstanceRegistry {
  if (!registry.census || !registry.census.pendingRelIds.includes(relId)) return registry;
  return {
    ...registry,
    census: {
      ...registry.census,
      pendingRelIds: registry.census.pendingRelIds.filter((id) => id !== relId),
    },
  };
}

/** Uninstall drops pending. A later root reinstall may reuse the inactive key. */
export function releaseInstalledInstance(
  registry: PluginInstanceRegistry,
  relOrKey: string,
): PluginInstanceRegistry {
  const record = registry.instances[relOrKey] ?? findInstanceByContentRelId(registry, relOrKey);
  const cleared = clearCensusPending(registry, record?.contentRelId ?? relOrKey);
  if (!record) return cleared;
  const namespaceState = record.namespaceState === 'pending' ? 'unconfirmed' : record.namespaceState;
  if (!record.active && namespaceState === record.namespaceState && cleared === registry) return registry;
  const base = cleared === registry ? registry : cleared;
  return upsertInstance(base, { ...record, active: false, namespaceState });
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function parseCensus(value: unknown): PluginInstanceCensus | null | undefined {
  if (value === null) return null;
  if (!isPlainObject(value) || !isIsoTimestamp(value.completedAt) || !Array.isArray(value.pendingRelIds)) {
    return undefined;
  }
  const pendingRelIds: string[] = [];
  for (const relId of value.pendingRelIds) {
    if (typeof relId !== 'string' || !isValidGhostId(relId)) return undefined;
    pendingRelIds.push(relId);
  }
  return { completedAt: value.completedAt, pendingRelIds };
}

function parseInstances(
  raw: Record<string, unknown>,
  census: PluginInstanceCensus | null,
): PluginInstanceRegistryParse {
  if (!isPlainObject(raw.instances)) return { kind: 'corrupt' };
  const instances: Record<string, PluginInstanceRecord> = {};
  for (const [key, value] of Object.entries(raw.instances)) {
    const record = parseRecord(value, key);
    if (!record) return { kind: 'corrupt' };
    instances[key] = record;
  }
  return {
    kind: 'ok',
    registry: { schemaVersion: PLUGIN_INSTANCE_REGISTRY_VERSION, census, instances },
  };
}

type PluginInstanceRegistryParse =
  | { kind: 'ok'; registry: PluginInstanceRegistry }
  | { kind: 'corrupt' }
  | { kind: 'unknown-schema' };

export function parsePluginInstanceRegistryDocument(raw: unknown): PluginInstanceRegistryParse {
  if (!isPlainObject(raw)) return { kind: 'corrupt' };
  if (!Number.isInteger(raw.schemaVersion)) return { kind: 'corrupt' };
  if (raw.schemaVersion === PLUGIN_INSTANCE_REGISTRY_V1_VERSION) return parseInstances(raw, null);
  if (raw.schemaVersion !== PLUGIN_INSTANCE_REGISTRY_VERSION) return { kind: 'unknown-schema' };
  if (!Object.prototype.hasOwnProperty.call(raw, 'census')) return { kind: 'corrupt' };
  const census = parseCensus(raw.census);
  if (census === undefined) return { kind: 'corrupt' };
  return parseInstances(raw, census);
}

function parsePluginInstanceRegistry(raw: unknown): PluginInstanceRegistry | null {
  const parsed = parsePluginInstanceRegistryDocument(raw);
  return parsed.kind === 'ok' ? parsed.registry : null;
}

export interface PluginInstanceRegistryStore {
  read(): PluginInstanceRegistryRead;
  write(registry: PluginInstanceRegistry): void;
  /** Move a corrupt file aside so a later write can rebuild directory keys. */
  discardCorrupt(): boolean;
}

function readPluginInstanceRegistryFile(filePath: string): PluginInstanceRegistryRead {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'unreadable' };
  }
  try {
    const parsed = parsePluginInstanceRegistryDocument(JSON.parse(text));
    if (parsed.kind === 'unknown-schema') return { kind: 'unknown-schema' };
    if (parsed.kind !== 'ok') return { kind: 'corrupt' };
    return { kind: 'ok', registry: parsed.registry };
  } catch {
    return { kind: 'corrupt' };
  }
}

export function createPluginInstanceRegistryStore(filePath: string): PluginInstanceRegistryStore {
  let corruptPath: string | null = null;
  const read = (): PluginInstanceRegistryRead => {
    const primary = readPluginInstanceRegistryFile(filePath);
    if (primary.kind !== 'missing') {
      corruptPath = primary.kind === 'corrupt' ? filePath : null;
      return primary;
    }
    if (path.basename(filePath) !== PLUGIN_INSTANCE_REGISTRY_FILE) {
      corruptPath = null;
      return { kind: 'missing' };
    }
    const legacyPath = path.join(path.dirname(filePath), PLUGIN_INSTANCE_REGISTRY_V1_FILE);
    const legacy = readPluginInstanceRegistryFile(legacyPath);
    corruptPath = legacy.kind === 'corrupt' ? legacyPath : null;
    return legacy;
  };
  return {
    read,
    discardCorrupt(): boolean {
      if (read().kind !== 'corrupt' || !corruptPath) return false;
      fs.renameSync(corruptPath, corruptPath + '.corrupt-' + crypto.randomUUID());
      return true;
    },
    write(registry) {
      const current = read();
      if (current.kind === 'unreadable' || current.kind === 'corrupt' || current.kind === 'unknown-schema') {
        throw new Error('plugin instance registry is ' + current.kind);
      }
      const document: PluginInstanceRegistry = {
        ...registry,
        schemaVersion: PLUGIN_INSTANCE_REGISTRY_VERSION,
      };
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tempPath = filePath + '.' + crypto.randomUUID() + '.tmp';
      try {
        fs.writeFileSync(tempPath, JSON.stringify(document, null, 2) + "\n", 'utf8');
        const descriptor = fs.openSync(tempPath, 'r+');
        try {
          fs.fsyncSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
        fs.renameSync(tempPath, filePath);
        const directory = process.platform === 'win32'
          ? fs.openSync(filePath, 'r+') : fs.openSync(path.dirname(filePath), 'r');
        try {
          fs.fsyncSync(directory);
        } finally {
          fs.closeSync(directory);
        }
      } catch (error) {
        try { fs.unlinkSync(tempPath); } catch { /* temp may already be gone */ }
        throw error;
      }
    },
  };
}
