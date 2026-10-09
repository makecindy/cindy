/**
 * Process-local wiring for the namespace census: market evidence, offline
 * resident retries, and unconfirmed confirmation facts. GhostManager stays
 * unaware of auth, the market ledger, and runtime slots.
 */
import path from 'node:path';

import { GHOST_INSTALL_MANIFEST_MAX_BYTES } from '../../shared/ghost.js';
import { installedGhostPhysicalRelId, installedGhostStoragePart } from '../../shared/pluginIdentity.js';
import type { GhostManifest, InstalledGhost } from '../../shared/ghost.js';
import {
  classifyNamespaceMigration,
  readNamespaceMigrationInstallOrigin,
  readNamespaceMigrationMarketRecord,
  type NamespaceClassification,
} from './pluginNamespaceMigration.js';
import { buildUnconfirmedConfirmationEvidence } from './pluginInstanceConfirmation.js';
import type { InstanceConfirmationEvidence, PluginInstanceRecord } from './pluginInstanceRegistry.js';
import {
  hasVerifiedDisconnectedOrganizationInstallation,
  installedMarketManifestIdentity,
} from '../plugin-market/installedManifestIdentity.js';
import type { PluginMarketInstallationRecord } from '../plugin-market/ledger.js';

export interface NamespaceMigrationGhostView {
  manifest: { id: string };
  builtin?: boolean;
  namespaceState?: string;
}

export interface NamespaceMigrationManager {
  list(): readonly NamespaceMigrationGhostView[];
  approvedInstallEvidence(id: string): { packageSha256: string | null; approvedManifest: GhostManifest; legacyMigrated: boolean } | null;
  readApprovedInstallOriginStrict(id: string): 'manual' | 'agent-forge';
  reconcilePendingRootNamespaces(marketSyncCompleted: boolean): Promise<void>;
}

export interface NamespaceMigrationHostDeps {
  activeOwnerScopeKey(): string;
  isAppSessionBoundaryPending(): boolean;
  getGhostManager(): NamespaceMigrationManager;
  getPluginMarketLedger(): {
    lookupInstallationsForNamespaceMigration(ghostId: string): {
      kind: string;
      records?: readonly PluginMarketInstallationRecord[];
    };
  };
  getAuthState(): {
    isAuthenticated: boolean;
    user: {
      membershipKind?: string;
      orgId?: string | null;
      orgSlug?: string | null;
    } | null;
  };
  createOrganizationPrefixStore(filePath: string): {
    lookup(orgId: string): { kind: string; pluginPrefix?: string | null };
  };
  ownerScopedUserDataPath(...parts: string[]): string;
  brainRootDir(): string;
  readInstalledGhostManifestSnapshot(dir: string, maxBytes: number): {
    ok: boolean;
    snapshot?: Parameters<typeof installedMarketManifestIdentity>[0];
  };
  oauthLockExists(ghostId: string): boolean;
  hasPendingWork(ghostId: string): boolean;
  runtimeState(instanceKey: string): string | null | undefined;
  nodeRuntimeRunning(instanceKey: string): boolean;
  stopRuntime(instanceKey: string): void;
  stopNodeRuntime(instanceKey: string): Promise<void>;
  captureGhostMutationOwner(): unknown;
  beginGhostMutation(owner: unknown): () => void;
  log: { warn(message: string, meta?: Record<string, unknown>): void };
  /** Test seam. Production uses the host's own set. */
  offlineResidentIdsForActiveScope?: () => Set<string>;
  pendingResidentMigrationRetryTimers?: Map<string, { unref?: () => void }>;
  pendingResidentMigrationRetryAttempts?: Map<string, number>;
  setTimeout?: (handler: () => void, timeoutMs: number) => { unref?: () => void };
}

export interface NamespaceMigrationHost {
  classifyPendingNamespaceForGhost(ghostId: string, marketSyncCompleted?: boolean): NamespaceClassification;
  canResumePendingResidentOffline(ghostId: string): boolean;
  schedulePendingResidentMigrationRetry(ghostId: string): void;
  isNamespaceMigrationBusy(ghostId: string): boolean;
  preparePendingResidentForMigration(ghostId: string): Promise<boolean>;
  readUnconfirmedConfirmationEvidence(record: PluginInstanceRecord): InstanceConfirmationEvidence;
  rememberOfflineResident(ghostId: string): void;
  forgetOfflineResident(ghostId: string): void;
  clearPendingResidentMigrationRetry(ghostId: string): void;
}

export function createNamespaceMigrationHost(deps: NamespaceMigrationHostDeps): NamespaceMigrationHost {
  let offlineResidentScopeKey: string | null = null;
  const ownedResidentIds = new Set<string>();
  const retryTimers = deps.pendingResidentMigrationRetryTimers ?? new Map<string, { unref?: () => void }>();
  const retryAttempts = deps.pendingResidentMigrationRetryAttempts ?? new Map<string, number>();
  const scheduleTimeout = deps.setTimeout ?? ((handler, timeoutMs) => setTimeout(handler, timeoutMs));

  function offlineResidentIdsForActiveScope(): Set<string> {
    if (deps.offlineResidentIdsForActiveScope) return deps.offlineResidentIdsForActiveScope();
    const scopeKey = deps.activeOwnerScopeKey();
    if (offlineResidentScopeKey !== scopeKey) {
      for (const timer of retryTimers.values()) clearTimeout(timer as ReturnType<typeof setTimeout>);
      retryTimers.clear();
      retryAttempts.clear();
      ownedResidentIds.clear();
      offlineResidentScopeKey = scopeKey;
    }
    return ownedResidentIds;
  }

  function namespaceMigrationMarketRecordsForGhost(ghostId: string): PluginMarketInstallationRecord[] {
    const lookup = deps.getPluginMarketLedger().lookupInstallationsForNamespaceMigration(ghostId);
    if (lookup.kind === 'invalid') throw new Error('Plugin namespace migration market evidence is invalid');
    const records = lookup.kind === 'found' ? [...(lookup.records ?? [])] : [];
    if (!records.some((record) => record.installed) &&
        records.some((record) => !record.installed && record.scope === 'organization' &&
        (record.source === 'market' || record.source === 'legacy-adopted'))) {
      const snapshot = deps.readInstalledGhostManifestSnapshot(
        path.join(deps.brainRootDir(), ghostId), GHOST_INSTALL_MANIFEST_MAX_BYTES);
      const evidence = deps.getGhostManager().approvedInstallEvidence(ghostId);
      if (!snapshot.ok || !snapshot.snapshot || !evidence) {
        throw new Error('Plugin namespace migration approved installation evidence is unavailable');
      }
      if (hasVerifiedDisconnectedOrganizationInstallation({
        records, evidence, identity: installedMarketManifestIdentity(snapshot.snapshot),
      })) {
        throw new Error('Plugin namespace migration awaits disconnected organization installation recovery');
      }
    }
    return records;
  }

  function schedulePendingResidentMigrationRetry(ghostId: string): void {
    if (!offlineResidentIdsForActiveScope().has(ghostId) || retryTimers.has(ghostId)) return;
    const ownerScopeKey = deps.activeOwnerScopeKey();
    const attempts = retryAttempts.get(ghostId) ?? 0;
    retryAttempts.set(ghostId, attempts + 1);
    const timer = scheduleTimeout(() => {
      if (retryTimers.get(ghostId) !== timer) return;
      retryTimers.delete(ghostId);
      if (deps.activeOwnerScopeKey() !== ownerScopeKey ||
          !offlineResidentIdsForActiveScope().has(ghostId)) return;
      void (async () => {
        let releaseMutation: (() => void) | null = null;
        try {
          const owner = deps.captureGhostMutationOwner();
          releaseMutation = deps.beginGhostMutation(owner);
          await deps.getGhostManager().reconcilePendingRootNamespaces(true);
        } catch (error) {
          deps.log.warn('offline resident namespace migration retry failed', {
            ghostId,
            error: error instanceof Error ? error.message : String(error),
          });
          schedulePendingResidentMigrationRetry(ghostId);
        } finally {
          releaseMutation?.();
        }
      })();
    }, Math.min(1000 * 2 ** Math.min(attempts, 6), 60_000));
    timer.unref?.();
    retryTimers.set(ghostId, timer);
  }

  return {
    schedulePendingResidentMigrationRetry,
    rememberOfflineResident(ghostId: string): void {
      offlineResidentIdsForActiveScope().add(ghostId);
    },
    forgetOfflineResident(ghostId: string): void {
      offlineResidentIdsForActiveScope().delete(ghostId);
    },
    clearPendingResidentMigrationRetry(ghostId: string): void {
      const retryTimer = retryTimers.get(ghostId);
      if (retryTimer) clearTimeout(retryTimer as ReturnType<typeof setTimeout>);
      retryTimers.delete(ghostId);
      retryAttempts.delete(ghostId);
    },
    isNamespaceMigrationBusy(ghostId: string): boolean {
      if (deps.isAppSessionBoundaryPending()) return true;
      try {
        if (deps.oauthLockExists(ghostId)) return true;
      } catch {
        return true;
      }
      if (deps.hasPendingWork(ghostId)) return true;
      const ghost = deps.getGhostManager()
        .list()
        .find((candidate) => installedGhostPhysicalRelId(candidate as InstalledGhost) === ghostId);
      if (!ghost) return false;
      const runtimeId = installedGhostStoragePart(ghost as InstalledGhost);
      const state = deps.runtimeState(runtimeId);
      return state === 'starting' || state === 'running' || state === 'stopping' ||
        deps.nodeRuntimeRunning(runtimeId);
    },
    canResumePendingResidentOffline(ghostId: string): boolean {
      if (deps.isAppSessionBoundaryPending()) return false;
      const record = readNamespaceMigrationMarketRecord(() =>
        namespaceMigrationMarketRecordsForGhost(ghostId));
      return record === null && readNamespaceMigrationInstallOrigin(() =>
        deps.getGhostManager().readApprovedInstallOriginStrict(ghostId)) === 'manual';
    },
    async preparePendingResidentForMigration(ghostId: string): Promise<boolean> {
      if (deps.isAppSessionBoundaryPending()) return false;
      if (!offlineResidentIdsForActiveScope().has(ghostId)) return true;
      const ownerScopeKey = deps.activeOwnerScopeKey();
      if (deps.hasPendingWork(ghostId)) return false;
      try {
        if (deps.oauthLockExists(ghostId)) return false;
      } catch {
        return false;
      }
      const ghost = deps.getGhostManager().list().find((candidate) =>
        candidate.namespaceState === 'pending' &&
        installedGhostPhysicalRelId(candidate as InstalledGhost) === ghostId);
      if (!ghost) return false;
      const runtimeId = installedGhostStoragePart(ghost as InstalledGhost);
      deps.stopRuntime(runtimeId);
      await deps.stopNodeRuntime(runtimeId);
      if (deps.activeOwnerScopeKey() !== ownerScopeKey || deps.isAppSessionBoundaryPending()) {
        throw new Error('ghost owner changed while stopping an offline resident');
      }
      return true;
    },
    classifyPendingNamespaceForGhost(ghostId: string, marketSyncCompleted = false): NamespaceClassification {
      const builtin = deps.getGhostManager()
        .list()
        .some((ghost) => ghost.manifest.id === ghostId && ghost.builtin === true);
      const marketRecord = readNamespaceMigrationMarketRecord(() =>
        namespaceMigrationMarketRecordsForGhost(ghostId));
      const state = deps.getAuthState();
      const user = state.isAuthenticated ? state.user : null;
      let currentOrganization: {
        organizationId: string;
        orgSlug: string | null;
        pluginPrefix: string | null;
      } | null = null;
      if (user?.membershipKind === 'org' && user.orgId) {
        const prefix = deps.createOrganizationPrefixStore(
          deps.ownerScopedUserDataPath('plugin-market', 'organization.v1.json'),
        ).lookup(user.orgId);
        currentOrganization = {
          organizationId: user.orgId,
          orgSlug: user.orgSlug ?? null,
          pluginPrefix: prefix.kind === 'known' ? prefix.pluginPrefix ?? null : null,
        };
      }
      const installOrigin = readNamespaceMigrationInstallOrigin(() =>
        deps.getGhostManager().readApprovedInstallOriginStrict(ghostId));
      return classifyNamespaceMigration({
        ghostId,
        builtin,
        installOrigin,
        marketSyncCompleted,
        marketRecord,
        currentOrganization,
      });
    },
    readUnconfirmedConfirmationEvidence(record: PluginInstanceRecord): InstanceConfirmationEvidence {
      const state = deps.getAuthState();
      const user = state.isAuthenticated ? state.user : null;
      const currentOrganization = user?.membershipKind === 'org' && user.orgId
        ? { organizationId: user.orgId, orgSlug: user.orgSlug ?? null }
        : null;
      let packageSha256: string | null = null;
      let forgeSelfTest = false;
      try {
        packageSha256 = deps.getGhostManager().approvedInstallEvidence(record.contentRelId)?.packageSha256 ?? null;
      } catch {
        packageSha256 = null;
      }
      try {
        forgeSelfTest = deps.getGhostManager().readApprovedInstallOriginStrict(record.contentRelId) === 'agent-forge';
      } catch {
        forgeSelfTest = false;
      }
      let rows: Parameters<typeof buildUnconfirmedConfirmationEvidence>[0]['rows'];
      try {
        rows = namespaceMigrationMarketRecordsForGhost(record.ghostId);
      } catch {
        rows = undefined;
      }
      return buildUnconfirmedConfirmationEvidence({
        rows, record, currentOrganization, packageSha256, forgeSelfTest,
      });
    },
  };
}
