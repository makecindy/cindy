/**
 * Positive evidence that may move an unconfirmed instance back to confirmed.
 * Receipt rewrites are not evidence. Callers pass market rows they already trust.
 */
import { hasDeliveryNamespace } from '../../shared/pluginIdentity.js';
import type { GhostInstallReceipt, GhostInstallReceiptReadResult } from './ghostInstallReceipt.js';
import {
  namespaceCommitReceiptSnapshot,
  sameNamespaceCommitReceiptSnapshot,
} from './pluginNamespaceMigration.js';
import {
  confirmInstanceNamespace,
  confirmUnconfirmedInstance,
  marketRowMatchesUnconfirmedInstance,
  type InstanceConfirmationEvidence,
  type InstanceConfirmationMarketRecord,
  type PluginInstanceRecord,
  type PluginInstanceRegistry,
} from './pluginInstanceRegistry.js';

interface ConfirmationMarketRow {
  pluginId?: string | null;
  installed?: boolean;
  namespace?: string | null;
  scope?: 'public' | 'personal' | 'organization';
  organizationId?: string | null;
  sha256?: string | null;
}

function confirmationMarketRecords(input: {
  rows: readonly ConfirmationMarketRow[];
  record: PluginInstanceRecord;
  currentOrganization: { organizationId: string; orgSlug: string | null } | null;
}): InstanceConfirmationMarketRecord[] {
  return input.rows
    .filter((row) => row.installed !== false)
    .filter((row) => marketRowMatchesUnconfirmedInstance(row, input.record, input.currentOrganization))
    .map((row) => ({
      ...(hasDeliveryNamespace(row) ? { namespace: row.namespace ?? null } : {}),
      organizationId: row.organizationId,
      packageSha256: row.sha256,
      scope: row.scope,
      installed: row.installed,
    }));
}

export function buildUnconfirmedConfirmationEvidence(input: {
  rows: readonly ConfirmationMarketRow[] | undefined;
  record: PluginInstanceRecord;
  currentOrganization: { organizationId: string; orgSlug: string | null } | null;
  packageSha256: string | null;
  forgeSelfTest: boolean;
  legacyManifestVerified?: boolean;
}): InstanceConfirmationEvidence {
  return {
    marketRecords: input.rows === undefined
      ? undefined
      : confirmationMarketRecords({
          rows: input.rows,
          record: input.record,
          currentOrganization: input.currentOrganization,
        }),
    currentOrganization: input.currentOrganization,
    packageSha256: input.packageSha256,
    forgeSelfTest: input.forgeSelfTest,
    ...(input.legacyManifestVerified ? { legacyManifestVerified: true } : {}),
  };
}

interface UnconfirmedConfirmationHost {
  readEvidence?(record: PluginInstanceRecord): InstanceConfirmationEvidence | null | undefined;
  isBlocked(): boolean;
  sync(): PluginInstanceRegistry;
  prepare?(): Promise<PluginInstanceRegistry>;
  ownerContextKey(): string;
  readApproval(relId: string): GhostInstallReceiptReadResult;
  orphanPendingNamespace?(record: PluginInstanceRecord, approval: GhostInstallReceiptReadResult): { namespace: string | null } | undefined;
  log?: { warn(message: string, meta?: Record<string, unknown>): void };
  runExclusive<T>(body: () => Promise<T>): Promise<T>;
  contentPath(relId: string): string;
  writeReceipt(relId: string, receipt: GhostInstallReceipt): Promise<void>;
  writeRegistry(registry: PluginInstanceRegistry): void;
}

/** Confirm unconfirmed rows only when the caller supplies positive evidence. */
export async function confirmUnconfirmedInstances(host: UnconfirmedConfirmationHost): Promise<{ unresolvedPending: number; mutationFailures: number }> {
  const readEvidence = host.readEvidence;
  if (host.isBlocked()) return { unresolvedPending: 0, mutationFailures: 0 };
  const ownerContextKey = host.ownerContextKey();
  const registry = host.prepare ? await host.prepare() : host.sync();
  if (host.isBlocked() || host.ownerContextKey() !== ownerContextKey) {
    return { unresolvedPending: 0, mutationFailures: 0 };
  }
  const orphans = new Set(Object.values(registry.instances).filter((record) =>
    record.active && record.namespaceState === 'pending' && registry.census !== null &&
    !registry.census.pendingRelIds.includes(record.contentRelId),
  ).map((record) => record.instanceKey));
  if (!readEvidence) return { unresolvedPending: orphans.size, mutationFailures: 0 };
  let mutationFailures = 0;
  for (const record of Object.values(registry.instances)) {
    if (host.ownerContextKey() !== ownerContextKey) return { unresolvedPending: 0, mutationFailures: 0 };
    const orphan = orphans.has(record.instanceKey);
    if (!record.active || (record.namespaceState !== 'unconfirmed' && !orphan)) continue;
    const initialApproval = host.readApproval(record.contentRelId);
    const evidenceSnapshot = namespaceCommitReceiptSnapshot(initialApproval);
    const target = orphan ? host.orphanPendingNamespace?.(record, initialApproval) : record;
    if (!target) continue;
    // This is a candidate for evidence checking, not a persisted state change or
    // an expansion of the frozen upgrade allowlist. Receipt fields alone never confirm it.
    const candidate: PluginInstanceRecord = orphan
      ? { ...record, namespace: target.namespace, namespaceState: 'unconfirmed' } : record;
    let evidence: InstanceConfirmationEvidence | null | undefined;
    try {
      evidence = readEvidence(candidate);
    } catch (error) {
      host.log?.warn('unconfirmed instance evidence unavailable', {
        instanceKey: record.instanceKey,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!evidence) continue;
    // Forge self-tests only restore an already-known namespace. An orphan has
    // no such history and cannot acquire the census-only Forge exception.
    const decision = confirmUnconfirmedInstance(candidate, orphan ? { ...evidence, forgeSelfTest: false } : evidence);
    if (!decision) continue;
    try {
      await host.runExclusive(async () => {
        if (host.ownerContextKey() !== ownerContextKey) return;
        const approval = host.readApproval(record.contentRelId);
        if (!sameNamespaceCommitReceiptSnapshot(
          evidenceSnapshot, namespaceCommitReceiptSnapshot(approval),
        )) return;
        if (approval.state !== 'approved' || approval.receipt.id !== record.ghostId) return;
        const currentRecord = host.sync().instances[record.instanceKey];
        if (!currentRecord?.active || currentRecord.pluginId !== record.pluginId || currentRecord.namespaceState !== record.namespaceState ||
            currentRecord.namespace !== record.namespace || currentRecord.receiptRevision !== record.receiptRevision ||
            currentRecord.packageSha256 !== record.packageSha256) return;
        const freshEvidence = readEvidence(candidate);
        if (!freshEvidence || confirmUnconfirmedInstance(candidate,
          orphan ? { ...freshEvidence, forgeSelfTest: false } : freshEvidence,
        )?.namespace !== decision.namespace) return;
        let revision = approval.receipt.revision;
        let packageSha256 = approval.receipt.packageSha256 ?? record.packageSha256;
        const stamped = hasDeliveryNamespace(approval.receipt) &&
          (approval.receipt.namespace ?? null) === decision.namespace;
        if (!stamped) {
          await host.writeReceipt(record.contentRelId, { ...approval.receipt, namespace: decision.namespace });
          if (host.ownerContextKey() !== ownerContextKey) return;
          const written = host.readApproval(record.contentRelId);
          if (written.state !== 'approved' || !hasDeliveryNamespace(written.receipt) ||
              (written.receipt.namespace ?? null) !== decision.namespace) return;
          revision = written.receipt.revision;
          packageSha256 = written.receipt.packageSha256 ?? packageSha256;
        }
        const current = host.sync();
        if (host.isBlocked()) return;
        const live = current.instances[record.instanceKey];
        if (!live?.active || live.pluginId !== record.pluginId || live.namespaceState !== record.namespaceState || live.namespace !== record.namespace ||
            live.receiptRevision !== revision || live.packageSha256 !== packageSha256) return;
        const confirmed = confirmInstanceNamespace(current, record.instanceKey, decision.namespace, {
          revision, packageSha256,
        });
        if (confirmed === current) return;
        host.writeRegistry(confirmed);
        orphans.delete(record.instanceKey);
      });
    } catch (error) {
      mutationFailures += 1;
      host.log?.warn('unconfirmed instance confirmation skipped', {
        instanceKey: record.instanceKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { unresolvedPending: orphans.size, mutationFailures };
}
