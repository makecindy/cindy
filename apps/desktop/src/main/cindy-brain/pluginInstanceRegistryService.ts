/**
 * Instance registry load, owner cache, directory sync, and the one-time census.
 * Pending privileges follow namespaceState. pendingRelIds is only the adoption
 * allowlist captured by that census.
 */
import fs from 'node:fs';
import path from 'node:path';

import { isValidGhostId } from '../../shared/ghost.js';
import { parsePluginInstallRelId, PLUGIN_NS_INSTALL_ROOT } from '../../shared/pluginIdentity.js';
import { classifyGhostDirEntrySync } from './ghostContentTree.js';
import {
  type NamespaceCensusCandidate,
  stampInstanceCensus,
  type CensusApproval,
} from './pluginNamespaceMigration.js';
import {
  adoptContentInstall,
  clearCensusPending,
  confirmInstanceNamespace,
  emptyPluginInstanceRegistry,
  findInstanceByContentRelId,
  reconcileInstanceReceipt,
  releaseInstalledInstance,
  upsertInstance,
  type PluginInstanceCensus,
  type PluginInstanceReceiptFact,
  type PluginInstanceRecord,
  type PluginInstanceRegistry,
  type PluginInstanceRegistryStore,
} from './pluginInstanceRegistry.js';

interface PluginInstanceRegistryLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

interface PluginInstanceRegistryServiceDeps {
  ensureOwner(): void;
  registryStore(): PluginInstanceRegistryStore;
  listContentEntries(): Array<{ relId: string; dir: string }>;
  receiptFact(relId: string): PluginInstanceReceiptFact | null | undefined;
  censusCandidates(): NamespaceCensusCandidate[];
  readApproval(relId: string): CensusApproval;
  captureInstalledLegacy?(ghostId: string, packageSha256: string): boolean;
  recordLegacyEligibility(relId: string, revision: string): void;
  /** Exactly one installed market record, or null when the ledger cannot say. */
  marketIdentityForGhost?(ghostId: string): { pluginId: string } | null;
  log?: PluginInstanceRegistryLogger;
}

/**
 * Active pending rows must be on the census allowlist. Strict mode also
 * reports an allowlist id whose active row is no longer pending.
 */
export function pendingCensusMismatches(
  registry: PluginInstanceRegistry,
  mode: 'privileges' | 'strict' = 'privileges',
): string[] {
  if (!registry.census) return [];
  const listed = new Set(registry.census.pendingRelIds);
  const mismatches: string[] = [];
  for (const record of Object.values(registry.instances)) {
    if (!record.active) continue;
    const isListed = listed.has(record.contentRelId);
    if (record.namespaceState === 'pending' && !isListed) {
      mismatches.push(record.contentRelId + ':pending-but-not-listed');
    } else if (mode === 'strict' && isListed && record.namespaceState !== 'pending') {
      mismatches.push(record.contentRelId + ':listed-but-' + record.namespaceState);
    }
  }
  return mismatches;
}

export function collectRootInstallCensusCandidates(input: {
  contentRoot: string;
  readApproval: (relId: string) => { state: string; receipt?: object };
  listPendingMutationIds: () => { state: string; blocked?: boolean; ids?: readonly string[] };
  readPendingMutation: (id: string) => {
    state: string;
    mutation?: { kind?: string; backupDirName?: string };
  };
  readRecoveryApproval: (id: string) => { state: string; receipt?: object };
  recoveryEntryKind: (absPath: string) => string;
}): NamespaceCensusCandidate[] {
  const root = input.contentRoot;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const candidates: NamespaceCensusCandidate[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === PLUGIN_NS_INSTALL_ROOT) continue;
    if (!isValidGhostId(entry.name)) continue;
    const dir = path.join(root, entry.name);
    if (classifyGhostDirEntrySync(dir) !== 'directory') continue;
    const approval = input.readApproval(entry.name);
    candidates.push({
      ghostId: entry.name,
      relId: entry.name,
      ...(approval.state === 'approved' ? { identitySource: approval.receipt } : {}),
    });
  }
  const pending = input.listPendingMutationIds();
  if (pending.state === 'ok' && !pending.blocked) {
    const seen = new Set(candidates.map((candidate) => candidate.ghostId));
    for (const id of pending.ids ?? []) {
      if (!isValidGhostId(id) || seen.has(id)) continue;
      const marker = input.readPendingMutation(id);
      if (marker.state !== 'valid' || marker.mutation?.kind !== 'update' || !marker.mutation.backupDirName) {
        continue;
      }
      const backup = path.join(root, marker.mutation.backupDirName);
      if (input.recoveryEntryKind(backup) !== 'directory') continue;
      const approval = input.readRecoveryApproval(id);
      if (approval.state !== 'approved' || !approval.receipt) continue;
      candidates.push({ ghostId: id, relId: id, identitySource: approval.receipt });
    }
  }
  return candidates;
}

type OpenedRegistry =
  | { status: 'ready'; registry: PluginInstanceRegistry }
  | { status: 'blocked'; reason: 'unreadable' | 'unknown-schema' | 'quarantine-failed' };

export class PluginInstanceRegistryService {
  private registry: PluginInstanceRegistry | null = null;
  private blocked = false;

  constructor(private readonly deps: PluginInstanceRegistryServiceDeps) {}

  clear(): void {
    this.registry = null;
    this.blocked = false;
  }

  isBlocked(): boolean {
    return this.blocked;
  }

  current(): PluginInstanceRegistry | null {
    return this.registry;
  }

  replaceCache(registry: PluginInstanceRegistry): void {
    this.blocked = false;
    this.registry = registry;
  }

  /** One quarantine path for sync and census. Unknown schemas are never rewritten. */
  private open(store: PluginInstanceRegistryStore): OpenedRegistry {
    let read = store.read();
    if (read.kind === 'corrupt') {
      try {
        store.discardCorrupt();
        read = { kind: 'missing' };
        this.deps.log?.warn('plugin instance registry was corrupt; rebuilding directory keys');
      } catch (error) {
        this.deps.log?.warn('plugin instance registry corrupt and could not be quarantined', {
          error: error instanceof Error ? error.message : String(error),
        });
        return { status: 'blocked', reason: 'quarantine-failed' };
      }
    }
    if (read.kind === 'unreadable' || read.kind === 'unknown-schema') {
      this.deps.log?.warn('plugin instance registry unusable; privileges stay unconfirmed', { kind: read.kind });
      return { status: 'blocked', reason: read.kind };
    }
    return {
      status: 'ready',
      registry: read.kind === 'ok' ? read.registry : emptyPluginInstanceRegistry(),
    };
  }

  private block(): PluginInstanceRegistry {
    this.blocked = true;
    this.registry = emptyPluginInstanceRegistry();
    return this.registry;
  }

  /**
   * Adoption allowlist. Before the census is stored, a bare root directory is
   * pending. Afterwards only the frozen pendingRelIds list is.
   */
  isPendingMigrationRel(relId: string, registry: PluginInstanceRegistry): boolean {
    if (registry.census) return registry.census.pendingRelIds.includes(relId);
    return parsePluginInstallRelId(relId)?.ghostId === relId;
  }

  sync(): PluginInstanceRegistry {
    this.deps.ensureOwner();
    const store = this.deps.registryStore();
    const opened = this.open(store);
    if (opened.status === 'blocked') return this.block();
    this.blocked = false;
    let registry = opened.registry;
    let dirty = false;
    const present = new Set<string>();
    for (const listed of this.deps.listContentEntries()) {
      present.add(listed.relId);
      const fact = this.deps.receiptFact(listed.relId);
      if (fact === undefined) continue;
      const existing = findInstanceByContentRelId(registry, listed.relId);
      if (!existing) {
        const ghostId = parsePluginInstallRelId(listed.relId)?.ghostId ?? fact?.ghostId ?? null;
        if (!ghostId) continue;
        const adopted = adoptContentInstall({
          relId: listed.relId,
          ghostId,
          receipt: fact,
          pendingMigration: this.isPendingMigrationRel(listed.relId, registry),
          marketPluginId: this.deps.marketIdentityForGhost?.(ghostId)?.pluginId ?? null,
        });
        if (!adopted) continue;
        registry = upsertInstance(registry, adopted);
        dirty = true;
        continue;
      }
      let next = reconcileInstanceReceipt(existing, { directoryPresent: true, receipt: fact });
      const market = this.deps.marketIdentityForGhost?.(existing.ghostId) ?? null;
      if (market && next.pluginId == null && next.source !== 'agent-forge' && next.source !== 'builtin') {
        next = { ...next, pluginId: market.pluginId, source: 'market' };
      }
      if (next !== existing) {
        registry = upsertInstance(registry, next);
        dirty = true;
      }
    }
    for (const record of Object.values(registry.instances)) {
      if (record.active && !present.has(record.contentRelId)) {
        registry = upsertInstance(registry, { ...record, active: false });
        dirty = true;
      }
    }
    const mismatches = pendingCensusMismatches(registry);
    if (mismatches.length > 0) {
      this.deps.log?.warn('plugin instance census diverged from namespaceState', { mismatches });
    }
    if (dirty) {
      try {
        store.write(registry);
      } catch (error) {
        this.deps.log?.warn('plugin instance registry write failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.registry = registry;
    return registry;
  }

  recordForAddress(id: string): PluginInstanceRecord | null {
    if (this.registry && !this.blocked) return this.lookup(this.registry, id);
    const registry = this.sync();
    if (this.blocked) return null;
    return this.lookup(registry, id);
  }

  private lookup(registry: PluginInstanceRegistry | null, id: string): PluginInstanceRecord | null {
    if (!registry || this.blocked) return null;
    return findInstanceByContentRelId(registry, id)
      ?? registry.instances[id]
      ?? Object.values(registry.instances).find((record) => record.instanceKey === id)
      ?? null;
  }

  publish(record: PluginInstanceRecord): void {
    if (this.blocked) return;
    const next = upsertInstance(this.registry ?? emptyPluginInstanceRegistry(), record);
    this.deps.registryStore().write(next);
    this.registry = next;
  }

  confirmNamespace(
    relOrKey: string,
    namespace: string | null,
    revision: string,
    packageSha256: string | null,
  ): boolean {
    const registry = this.sync();
    if (this.blocked) return false;
    const record = findInstanceByContentRelId(registry, relOrKey) ?? registry.instances[relOrKey]
      ?? Object.values(registry.instances).find((item) =>
        item.active && item.ghostId === relOrKey && item.contentRelId === relOrKey);
    if (!record) return false;
    const confirmed = confirmInstanceNamespace(registry, record.instanceKey, namespace, { revision, packageSha256 });
    if (confirmed === registry && !(record.namespaceState === 'confirmed' && record.namespace === namespace)) {
      return false;
    }
    const next = clearCensusPending(confirmed, record.contentRelId);
    if (next === registry) return true;
    this.deps.registryStore().write(next);
    this.registry = next;
    return true;
  }

  release(relOrKey: string): void {
    const registry = this.sync();
    if (this.blocked) throw new Error('plugin instance registry is blocked');
    const next = releaseInstalledInstance(registry, relOrKey);
    if (next === registry) return;
    this.deps.registryStore().write(next);
    this.registry = next;
  }

  ensureCensus(): PluginInstanceCensus | null {
    this.deps.ensureOwner();
    const store = this.deps.registryStore();
    const opened = this.open(store);
    if (opened.status === 'blocked') {
      this.block();
      return null;
    }
    if (opened.registry.census) {
      this.blocked = false;
      this.registry = opened.registry;
      return opened.registry.census;
    }
    let candidates: NamespaceCensusCandidate[];
    try {
      candidates = this.deps.censusCandidates();
    } catch (error) {
      this.deps.log?.warn('namespace migration census scan failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    const stamped = stampInstanceCensus({
      registry: opened.registry,
      candidates,
      now: new Date().toISOString(),
      readApproval: (relId) => this.deps.readApproval(relId),
      captureInstalledLegacy: (ghostId, packageSha256) =>
        this.deps.captureInstalledLegacy?.(ghostId, packageSha256) === true,
      recordLegacyEligibility: (relId, revision) => {
        this.deps.recordLegacyEligibility(relId, revision);
      },
    });
    if (!stamped) return null;
    try {
      store.write(stamped);
    } catch (error) {
      this.deps.log?.warn('namespace migration census write failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    this.blocked = false;
    this.registry = stamped;
    return stamped.census;
  }
}
