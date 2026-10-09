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

export interface ConfirmationMarketRow {
  installed?: boolean;
  namespace?: string | null;
  scope?: 'public' | 'personal' | 'organization';
  organizationId?: string | null;
  sha256?: string | null;
}

export function confirmationMarketRecords(input: {
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
  };
}

export interface UnconfirmedConfirmationHost {
  readEvidence?(record: PluginInstanceRecord): InstanceConfirmationEvidence | null | undefined;
  isBlocked(): boolean;
  sync(): PluginInstanceRegistry;
  ownerContextKey(): string;
  readApproval(relId: string): GhostInstallReceiptReadResult;
  log?: { warn(message: string, meta?: Record<string, unknown>): void };
  runExclusive<T>(body: () => Promise<T>): Promise<T>;
  contentPath(relId: string): string;
  writeReceipt(relId: string, receipt: GhostInstallReceipt): Promise<void>;
  writeRegistry(registry: PluginInstanceRegistry): void;
}

/** Confirm unconfirmed rows only when the caller supplies positive evidence. */
export async function confirmUnconfirmedInstances(host: UnconfirmedConfirmationHost): Promise<void> {
  const readEvidence = host.readEvidence;
  if (!readEvidence || host.isBlocked()) return;
  const registry = host.sync();
  if (host.isBlocked()) return;
  const ownerContextKey = host.ownerContextKey();
  for (const record of Object.values(registry.instances)) {
    if (host.ownerContextKey() !== ownerContextKey) return;
    if (!record.active || record.namespaceState !== 'unconfirmed') continue;
    const evidenceSnapshot = namespaceCommitReceiptSnapshot(host.readApproval(record.contentRelId));
    let evidence: InstanceConfirmationEvidence | null | undefined;
    try {
      evidence = readEvidence(record);
    } catch (error) {
      host.log?.warn('unconfirmed instance evidence unavailable', {
        instanceKey: record.instanceKey,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!evidence) continue;
    const decision = confirmUnconfirmedInstance(record, evidence);
    if (!decision) continue;
    try {
      await host.runExclusive(async () => {
        if (host.ownerContextKey() !== ownerContextKey) return;
        const approval = host.readApproval(record.contentRelId);
        if (!sameNamespaceCommitReceiptSnapshot(
          evidenceSnapshot, namespaceCommitReceiptSnapshot(approval),
        )) return;
        if (approval.state !== 'approved' || approval.receipt.id !== record.ghostId) return;
        let revision = approval.receipt.revision;
        let packageSha256 = approval.receipt.packageSha256 ?? record.packageSha256;
        const stamped = hasDeliveryNamespace(approval.receipt) &&
          (approval.receipt.namespace ?? null) === decision.namespace;
        if (!stamped) {
          await host.writeReceipt(record.contentRelId, { ...approval.receipt, namespace: decision.namespace });
          const written = host.readApproval(record.contentRelId);
          if (written.state !== 'approved' || !hasDeliveryNamespace(written.receipt) ||
              (written.receipt.namespace ?? null) !== decision.namespace) return;
          revision = written.receipt.revision;
          packageSha256 = written.receipt.packageSha256 ?? packageSha256;
        }
        const current = host.sync();
        if (host.isBlocked()) return;
        const confirmed = confirmInstanceNamespace(current, record.instanceKey, decision.namespace, {
          revision, packageSha256,
        });
        if (confirmed === current) return;
        host.writeRegistry(confirmed);
      });
    } catch (error) {
      host.log?.warn('unconfirmed instance confirmation skipped', {
        instanceKey: record.instanceKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
