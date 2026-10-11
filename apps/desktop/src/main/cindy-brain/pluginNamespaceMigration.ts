/**
 * Upgrade census stored on the instance registry.
 * The first census records the legacy root directories present at that moment.
 * Later installs are not added to pendingRelIds.
 */
import { isValidPluginNamespace, PLUGIN_PREFIX_PATTERN } from '@cindy/plugin-protocol';
import { isValidGhostId } from '../../shared/ghost.js';
import { hasDeliveryNamespace, resolvePluginNamespaceState } from '../../shared/pluginIdentity.js';
import { captureLegacyFirstPartyEligibility } from './ghostFirstPartyPrivilege.js';
import {
  type GhostInstallReceipt,
  type GhostInstallReceiptReadResult,
} from './ghostInstallReceipt.js';
import {
  finishInstanceCensus,
  type PluginInstanceCensus,
  type PluginInstanceRegistry,
} from './pluginInstanceRegistry.js';

export type NamespaceMigrationBasis =
  | 'builtin'
  | 'market-public'
  | 'market-personal'
  | 'market-custom'
  | 'manual-after-sync'
  | 'explicit-root'
  | 'market-organization'
  | 'forge-current-org'
  | 'receipt-recovered';

export type NamespaceClassification =
  | { kind: 'commit'; namespace: string | null; basis: NamespaceMigrationBasis }
  | { kind: 'pending'; reason: string };

export interface NamespaceCensusCandidate {
  ghostId: string;
  relId: string;
  /** Receipt/ledger object; missing namespace field means pre-namespace. */
  identitySource?: object;
}

export interface ClassifyNamespaceMigrationInput {
  ghostId: string;
  builtin: boolean;
  installOrigin: 'manual' | 'agent-forge' | undefined;
  marketSyncCompleted: boolean;
  marketRecord: {
    scope: 'public' | 'personal' | 'organization';
    source: 'market' | 'legacy-adopted' | 'git-market' | 'local-market';
    organizationId: string | null;
    namespace?: string | null;
    installed?: boolean;
  } | null | undefined;
  currentOrganization: {
    organizationId: string;
    orgSlug: string | null;
    pluginPrefix: string | null;
  } | null;
}

export function readNamespaceMigrationMarketRecord(
  readRecords: () => readonly NonNullable<ClassifyNamespaceMigrationInput['marketRecord']>[],
): ClassifyNamespaceMigrationInput['marketRecord'] {
  try {
    const records = readRecords().filter((record) => record.installed !== false);
    if (records.length === 0) return null;
    return records.length === 1 ? records[0] : undefined;
  } catch {
    return undefined;
  }
}

export function readNamespaceMigrationInstallOrigin(
  readApprovedOrigin: () => 'manual' | 'agent-forge',
): ClassifyNamespaceMigrationInput['installOrigin'] {
  try {
    return readApprovedOrigin();
  } catch {
    return undefined;
  }
}

function matchesOrgPrefix(ghostId: string, prefix: string | null): boolean {
  if (!prefix || !PLUGIN_PREFIX_PATTERN.test(prefix)) return false;
  return ghostId.startsWith(`${prefix}-`);
}

export function isCensusCandidate(candidate: NamespaceCensusCandidate): boolean {
  if (!isValidGhostId(candidate.ghostId)) return false;
  if (candidate.relId !== candidate.ghostId) return false;
  if (!candidate.identitySource) return true;
  return resolvePluginNamespaceState(candidate.identitySource).kind === 'legacy';
}

export function classifyNamespaceMigration(
  input: ClassifyNamespaceMigrationInput,
): NamespaceClassification {
  const record = input.marketRecord?.installed === false ? null : input.marketRecord;
  if (record === undefined) {
    return { kind: 'pending', reason: 'awaiting-market-facts' };
  }
  if (record) {
    const recordState = resolvePluginNamespaceState(record);
    if (recordState.kind === 'known') {
      if (recordState.namespace !== null) {
        return {
          kind: 'commit',
          namespace: recordState.namespace,
          basis: 'market-organization',
        };
      }
      return { kind: 'commit', namespace: null, basis: 'explicit-root' };
    }
    if (record.source === 'git-market' || record.source === 'local-market') {
      return { kind: 'commit', namespace: null, basis: 'market-custom' };
    }
    if (record.scope === 'public') {
      return { kind: 'commit', namespace: null, basis: 'market-public' };
    }
    if (record.scope === 'personal') {
      return { kind: 'commit', namespace: null, basis: 'market-personal' };
    }
    if (record.scope === 'organization') {
      const namespace = matchingOrganizationNamespace(record.organizationId, input.currentOrganization);
      if (namespace) {
        return { kind: 'commit', namespace, basis: 'market-organization' };
      }
      return { kind: 'pending', reason: 'awaiting-organization-namespace' };
    }
  }

  if (input.builtin) {
    return { kind: 'commit', namespace: null, basis: 'builtin' };
  }

  if (input.installOrigin === undefined) {
    return { kind: 'pending', reason: 'awaiting-install-origin' };
  }

  if (
    input.installOrigin === 'agent-forge' &&
    input.currentOrganization &&
    matchesOrgPrefix(input.ghostId, input.currentOrganization.pluginPrefix)
  ) {
    const namespace = input.currentOrganization.orgSlug;
    if (namespace && isValidPluginNamespace(namespace)) {
      return { kind: 'commit', namespace, basis: 'forge-current-org' };
    }
    return { kind: 'pending', reason: 'awaiting-organization-namespace' };
  }

  if (input.marketSyncCompleted && input.installOrigin === 'manual' && record === null) {
    return { kind: 'commit', namespace: null, basis: 'manual-after-sync' };
  }

  return { kind: 'pending', reason: 'awaiting-market-facts' };
}

function matchingOrganizationNamespace(
  organizationId: string | null,
  currentOrganization: ClassifyNamespaceMigrationInput['currentOrganization'],
): string | null {
  if (!organizationId || !currentOrganization) return null;
  if (currentOrganization.organizationId !== organizationId) return null;
  const namespace = currentOrganization.orgSlug;
  return namespace && isValidPluginNamespace(namespace) ? namespace : null;
}

export type NamespaceCommitPlan =
  | { kind: 'skip'; reason: 'not-pending' | 'busy' }
  | { kind: 'write-registry-only'; namespace: string | null; basis: 'receipt-recovered' }
  | {
      kind: 'write-receipt-and-registry';
      namespace: string | null;
      basis: NamespaceMigrationBasis;
    };

/**
 * Crash window: receipt may already carry namespace while the registry census
 * is still pending. Finish the registry record to match the receipt; do not reclassify.
 * Busy only blocks a first-time receipt write, not registry recovery.
 */
export function planNamespaceCommit(input: {
  pending: boolean;
  busy: boolean;
  receiptNamespace?: string | null;
  requested: { namespace: string | null; basis: NamespaceMigrationBasis };
}): NamespaceCommitPlan {
  if (!input.pending) return { kind: 'skip', reason: 'not-pending' };
  if (input.receiptNamespace !== undefined) {
    return {
      kind: 'write-registry-only',
      namespace: input.receiptNamespace,
      basis: 'receipt-recovered',
    };
  }
  if (input.busy) return { kind: 'skip', reason: 'busy' };
  return {
    kind: 'write-receipt-and-registry',
    namespace: input.requested.namespace,
    basis: input.requested.basis,
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
 * One-shot census of the legacy root directories present now.
 * Existing instance rows are not rewritten.
 */
export function stampInstanceCensus(input: {
  registry: PluginInstanceRegistry;
  candidates: readonly NamespaceCensusCandidate[];
  now: string;
  readApproval: (relId: string) => CensusApproval;
  captureInstalledLegacy?: (ghostId: string, packageSha256: string) => boolean;
  recordLegacyEligibility: (relId: string, revision: string) => void;
}): PluginInstanceRegistry | null {
  if (input.registry.census) return input.registry;
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
  ensureCensus(): PluginInstanceCensus | null;
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
  if (!census?.pendingRelIds.includes(ghostId)) return { ok: false, reason: 'not pending' };
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
  if (plan.kind === 'write-receipt-and-registry') {
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
  ensureCensus(): PluginInstanceCensus | null;
  ownerContextKey(): string;
  preparePendingResident?(ghostId: string): Promise<boolean>;
  onPendingResidentDeferred?(ghostId: string): void;
  /** committed false means a stop was not followed by a successful stamp. */
  onPendingResidentMigrationSettled?(ghostId: string, committed: boolean): void;
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
  const census = host.ensureCensus();
  if (!census) return;
  const ownerContextKey = host.ownerContextKey();
  for (const ghostId of census.pendingRelIds) {
    if (host.ownerContextKey() !== ownerContextKey) return;
    let stopAttempted = false;
    try {
      const expectedReceipt = namespaceCommitReceiptSnapshot(host.readApproval(ghostId));
      const classification = host.classify?.(ghostId, marketSyncCompleted) ?? {
        kind: 'pending' as const,
        reason: 'awaiting-market-facts',
      };
      // Stop only when this entry is about to be stamped. A pending result,
      // such as a Forge install whose organization does not match, must leave
      // the running plugin alone.
      if (marketSyncCompleted && classification.kind === 'commit') {
        const ready = await host.preparePendingResident?.(ghostId);
        if (host.ownerContextKey() !== ownerContextKey) return;
        if (ready === false) {
          host.onPendingResidentDeferred?.(ghostId);
          continue;
        }
        stopAttempted = true;
      }
      if (classification.kind === 'commit') {
        const result = await host.commit(
          ghostId, classification.namespace, classification.basis, expectedReceipt,
        );
        if (stopAttempted && host.ownerContextKey() === ownerContextKey) {
          host.onPendingResidentMigrationSettled?.(ghostId, result.ok);
        }
        if (!result.ok && result.reason === 'busy' && marketSyncCompleted) {
          host.onPendingResidentDeferred?.(ghostId);
        }
        if (!result.ok && result.reason === 'state-changed' && marketSyncCompleted) {
          host.onPendingResidentDeferred?.(ghostId);
        }
      }
    } catch (error) {
      if (stopAttempted && host.ownerContextKey() === ownerContextKey) {
        try {
          host.onPendingResidentMigrationSettled?.(ghostId, false);
        } catch {
          // Restoring the plugin is best-effort; the entry is still deferred.
        }
      }
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
