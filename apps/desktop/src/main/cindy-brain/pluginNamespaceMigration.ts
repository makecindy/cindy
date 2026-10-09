/**
 * Upgrade census stored on the instance registry.
 * The legacy namespace-migration.v1.json ledger is imported once and never written.
 */
import { isValidPluginNamespace } from '@cindy/plugin-protocol';
import { isValidGhostId } from '../../shared/ghost.js';
import { hasDeliveryNamespace } from '../../shared/pluginIdentity.js';
import { captureLegacyFirstPartyEligibility } from './ghostFirstPartyPrivilege.js';
import {
  type GhostInstallReceipt,
  type GhostInstallReceiptReadResult,
} from './ghostInstallReceipt.js';
import {
  isCensusCandidate,
  planNamespaceCommit,
  NAMESPACE_MIGRATION_SCHEMA_VERSION,
  type NamespaceCensusCandidate,
  type NamespaceClassification,
  type NamespaceMigrationBasis,
  type NamespaceMigrationLedger,
  type NamespaceMigrationLedgerRead,
} from './ghostNamespaceMigration.js';
import {
  emptyPluginInstanceRegistry,
  finishInstanceCensus,
  noteImportedPending,
  projectPendingCensus,
  type PluginInstanceRegistry,
} from './pluginInstanceRegistry.js';

export function projectNamespaceMigrationLedger(
  registry: PluginInstanceRegistry,
): NamespaceMigrationLedger | null {
  const projected = projectPendingCensus(registry);
  if (!projected) return null;
  return {
    schemaVersion: NAMESPACE_MIGRATION_SCHEMA_VERSION,
    censusedAt: projected.censusedAt,
    entries: projected.entries,
  };
}

export interface CensusApproval {
  state: string;
  receipt?: {
    packageSha256?: string;
    revision: string;
    trust: { level: string };
  };
}

/**
 * One-shot census. An ok legacy ledger contributes only its still-present
 * pending rows. Any other readable ledger takes the directories that are
 * still legacy. Callers refuse unreadable and unknown schemas before this.
 */
export function stampInstanceCensus(input: {
  registry: PluginInstanceRegistry;
  legacy: NamespaceMigrationLedgerRead;
  candidates: readonly NamespaceCensusCandidate[];
  now: string;
  readApproval: (relId: string) => CensusApproval;
  captureInstalledLegacy?: (ghostId: string, packageSha256: string) => boolean;
  recordLegacyEligibility: (relId: string, revision: string) => void;
}): PluginInstanceRegistry | null {
  if (input.registry.census) return input.registry;
  const present = new Set(input.candidates.map((candidate) => candidate.relId));
  if (input.legacy.kind === 'ok') {
    let next = input.registry;
    const pendingRelIds: string[] = [];
    for (const entry of Object.values(input.legacy.ledger.entries)) {
      if (entry.status !== 'pending' || !present.has(entry.relId)) continue;
      pendingRelIds.push(entry.relId);
      next = noteImportedPending(next, entry.relId);
    }
    return finishInstanceCensus(next, input.legacy.ledger.censusedAt, pendingRelIds);
  }
  const pendingEntries = input.candidates.filter((candidate) => isCensusCandidate(candidate));
  try {
    for (const entry of pendingEntries) {
      const approval = input.readApproval(entry.relId);
      const sha = approval.receipt?.packageSha256;
      if (approval.state !== 'approved' || !sha || !approval.receipt) continue;
      const eligible = captureLegacyFirstPartyEligibility({
        legacyExistingInstall: true,
        ghostId: entry.ghostId,
        namespace: null,
        approved: true,
        approvedPackageSha256: sha,
        marketRecord: null,
        approvedOfficialTrust: approval.receipt.trust.level === 'cindy-official',
      }) || input.captureInstalledLegacy?.(entry.ghostId, sha) === true;
      if (eligible) input.recordLegacyEligibility(entry.relId, approval.receipt.revision);
    }
  } catch {
    return null;
  }
  return finishInstanceCensus(input.registry, input.now, pendingEntries.map((entry) => entry.relId));
}

export type NamespaceCommitReceiptSnapshot = {
  state: GhostInstallReceiptReadResult['state'];
  hasNamespace?: boolean;
  namespace?: string | null;
  revision?: string;
  packageSha256?: string;
  installOrigin?: string;
};

export function namespaceCommitReceiptSnapshot(
  approval: GhostInstallReceiptReadResult,
): NamespaceCommitReceiptSnapshot {
  if (approval.state !== 'approved') return { state: approval.state };
  return {
    state: approval.state,
    hasNamespace: hasDeliveryNamespace(approval.receipt),
    ...(hasDeliveryNamespace(approval.receipt)
      ? { namespace: approval.receipt.namespace }
      : {}),
    revision: approval.receipt.revision,
    ...(approval.receipt.packageSha256 !== undefined
      ? { packageSha256: approval.receipt.packageSha256 }
      : {}),
    ...(approval.receipt.installOrigin !== undefined
      ? { installOrigin: approval.receipt.installOrigin }
      : {}),
  };
}

export function sameNamespaceCommitReceiptSnapshot(
  left: NamespaceCommitReceiptSnapshot,
  right: NamespaceCommitReceiptSnapshot,
): boolean {
  return left.state === right.state &&
    (left.state !== 'approved' || (
      left.hasNamespace === right.hasNamespace &&
      left.namespace === right.namespace &&
      left.revision === right.revision &&
      left.packageSha256 === right.packageSha256 &&
      left.installOrigin === right.installOrigin
    ));
}

export interface PendingNamespaceCommitHost {
  ownerContextKey(): string;
  ensureCensus(): NamespaceMigrationLedger | null;
  readApproval(ghostId: string): GhostInstallReceiptReadResult;
  hasPendingMutationJournal(ghostId: string): boolean;
  isNamespaceMigrationBusy(ghostId: string): boolean;
  beforeNamespaceCommit(ghostId: string, namespace: string | null): void;
  writeReceiptNamespace(ghostId: string, receipt: GhostInstallReceipt, namespace: string | null): Promise<void>;
  onNamespaceCommitted(ghostId: string, namespace: string | null): void;
  confirmRecordedNamespace(
    ghostId: string,
    namespace: string | null,
    revision: string,
    packageSha256: string | null,
  ): boolean;
  notifyChanged(): void;
}

/** Stamp one pending bare install. Receipt and registry census update stay in this call. */
export async function commitPendingNamespaceMigration(
  host: PendingNamespaceCommitHost,
  ghostId: string,
  namespace: string | null,
  basis: NamespaceMigrationBasis,
  expectedReceipt?: NamespaceCommitReceiptSnapshot,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const ownerContextKey = host.ownerContextKey();
  if (!isValidGhostId(ghostId)) return { ok: false, reason: 'invalid ghost id' };
  if (namespace !== null && !isValidPluginNamespace(namespace)) {
    return { ok: false, reason: 'invalid namespace' };
  }
  const census = host.ensureCensus();
  if (!census?.entries[ghostId]) return { ok: false, reason: 'not pending' };
  const approval = host.readApproval(ghostId);
  if (expectedReceipt && !sameNamespaceCommitReceiptSnapshot(
    expectedReceipt, namespaceCommitReceiptSnapshot(approval),
  )) {
    return { ok: false, reason: 'state-changed' };
  }
  if (approval.state !== 'approved') return { ok: false, reason: 'busy' };
  const receiptNamespace =
    hasDeliveryNamespace(approval.receipt)
      ? approval.receipt.namespace ?? null
      : undefined;
  const plan = planNamespaceCommit({
    pending: true,
    busy: host.hasPendingMutationJournal(ghostId) || host.isNamespaceMigrationBusy(ghostId),
    ...(receiptNamespace !== undefined ? { receiptNamespace } : {}),
    requested: { namespace, basis },
  });
  if (plan.kind === 'skip') return { ok: false, reason: plan.reason };
  host.beforeNamespaceCommit(ghostId, plan.namespace);
  if (plan.kind === 'write-receipt-and-ledger') {
    await host.writeReceiptNamespace(ghostId, approval.receipt, plan.namespace);
    if (host.ownerContextKey() !== ownerContextKey) {
      throw new Error('ghost owner changed while committing a namespace migration');
    }
    const committedApproval = host.readApproval(ghostId);
    if (committedApproval.state !== 'approved' ||
        committedApproval.receipt.revision !== approval.receipt.revision ||
        committedApproval.receipt.packageSha256 !== approval.receipt.packageSha256 ||
        committedApproval.receipt.installOrigin !== approval.receipt.installOrigin ||
        !hasDeliveryNamespace(committedApproval.receipt) ||
        committedApproval.receipt.namespace !== plan.namespace) {
      return { ok: false, reason: 'state-changed' };
    }
  }
  if (host.ownerContextKey() !== ownerContextKey) {
    throw new Error('ghost owner changed while committing a namespace migration');
  }
  host.onNamespaceCommitted(ghostId, plan.namespace);
  const confirmed = host.confirmRecordedNamespace(
    ghostId,
    plan.namespace,
    approval.receipt.revision,
    approval.receipt.packageSha256 ?? null,
  );
  if (!confirmed) return { ok: false, reason: 'namespace-conflict' };
  host.notifyChanged();
  return { ok: true };
}

export interface PendingNamespaceReconcileHost {
  ensureCensus(): NamespaceMigrationLedger | null;
  ownerContextKey(): string;
  preparePendingResident?(ghostId: string): Promise<boolean>;
  onPendingResidentDeferred?(ghostId: string): void;
  readApproval(ghostId: string): GhostInstallReceiptReadResult;
  classify?(ghostId: string, marketSyncCompleted: boolean): NamespaceClassification;
  commit(
    ghostId: string,
    namespace: string | null,
    basis: NamespaceMigrationBasis,
    expectedReceipt: NamespaceCommitReceiptSnapshot,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  confirmUnconfirmed(): Promise<void>;
  log?: { warn(message: string, meta?: Record<string, unknown>): void };
}

/** Walk the stored census. One entry failing does not stop the rest. */
export async function reconcilePendingNamespaceMigrations(
  host: PendingNamespaceReconcileHost,
  marketSyncCompleted: boolean,
): Promise<void> {
  const ledger = host.ensureCensus();
  if (!ledger) return;
  const ownerContextKey = host.ownerContextKey();
  for (const ghostId of Object.keys(ledger.entries)) {
    if (host.ownerContextKey() !== ownerContextKey) return;
    try {
      if (marketSyncCompleted) {
        const ready = await host.preparePendingResident?.(ghostId);
        if (host.ownerContextKey() !== ownerContextKey) return;
        if (ready === false) {
          host.onPendingResidentDeferred?.(ghostId);
          continue;
        }
      }
      const expectedReceipt = namespaceCommitReceiptSnapshot(host.readApproval(ghostId));
      const classification = host.classify?.(ghostId, marketSyncCompleted) ?? {
        kind: 'pending' as const,
        reason: 'awaiting-market-facts',
      };
      if (classification.kind === 'commit') {
        const result = await host.commit(
          ghostId, classification.namespace, classification.basis, expectedReceipt,
        );
        if (!result.ok && result.reason === 'busy' && marketSyncCompleted) {
          host.onPendingResidentDeferred?.(ghostId);
        }
        if (!result.ok && result.reason === 'state-changed' && marketSyncCompleted) {
          host.onPendingResidentDeferred?.(ghostId);
        }
      }
    } catch (error) {
      if (marketSyncCompleted && host.ownerContextKey() === ownerContextKey) {
        host.onPendingResidentDeferred?.(ghostId);
      }
      host.log?.warn('pending namespace migration entry failed; continuing with remaining entries', {
        ghostId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (marketSyncCompleted && host.ownerContextKey() === ownerContextKey) {
    await host.confirmUnconfirmed();
  }
}
