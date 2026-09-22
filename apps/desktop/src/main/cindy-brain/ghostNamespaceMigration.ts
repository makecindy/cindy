/**
 * §5 旧安装 namespace 待迁移。
 *
 * 升级时不能因为 receipt 暂时没有 namespace 就把旧企业插件当成 root，
 * 也不能让升级后新装的包靠“缺字段”混进待迁移集合。待迁移实例保持原目录
 * 与运行资格。确认后在原目录/原 receipt 文件上写入 namespace，不搬到
 * `_ns/<org>/...`；存储键继续跟物理目录，避免 KV/OAuth 换键丢数据。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isValidPluginNamespace, PLUGIN_PREFIX_PATTERN } from '@cindy/plugin-protocol';

import { isValidGhostId } from '../../shared/ghost.js';
import { resolvePluginNamespaceState } from '../../shared/pluginIdentity.js';

export const NAMESPACE_MIGRATION_SCHEMA_VERSION = 1 as const;
export const NAMESPACE_MIGRATION_FILE = 'namespace-migration.v1.json';

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

export type NamespaceMigrationEntryStatus = 'pending' | 'committed';

export interface NamespaceMigrationEntry {
  ghostId: string;
  relId: string;
  capturedAt: string;
  status: NamespaceMigrationEntryStatus;
  namespace?: string | null;
  committedAt?: string;
  basis?: NamespaceMigrationBasis | 'awaiting-facts';
}

export interface NamespaceMigrationLedger {
  schemaVersion: typeof NAMESPACE_MIGRATION_SCHEMA_VERSION;
  censusedAt: string;
  entries: Record<string, NamespaceMigrationEntry>;
}

export type NamespaceMigrationLedgerRead =
  | { kind: 'missing' }
  | { kind: 'ok'; ledger: NamespaceMigrationLedger }
  | { kind: 'corrupt' }
  | { kind: 'unreadable' };

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
  installOrigin: 'manual' | 'agent-forge';
  marketSyncCompleted: boolean;
  marketRecord: {
    scope: 'public' | 'personal' | 'organization';
    source: 'market' | 'legacy-adopted' | 'git-market' | 'local-market';
    organizationId: string | null;
    namespace?: string | null;
  } | null;
  currentOrganization: {
    organizationId: string;
    orgSlug: string | null;
    pluginPrefix: string | null;
  } | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
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

export function censusNamespaceMigration(
  existing: NamespaceMigrationLedgerRead,
  candidates: readonly NamespaceCensusCandidate[],
  now: string,
): { kind: 'unchanged'; ledger: NamespaceMigrationLedger } | { kind: 'created'; ledger: NamespaceMigrationLedger } | { kind: 'blocked'; reason: 'unreadable' | 'corrupt' } {
  if (existing.kind === 'unreadable' || existing.kind === 'corrupt') {
    return { kind: 'blocked', reason: existing.kind };
  }
  if (existing.kind === 'ok') return { kind: 'unchanged', ledger: existing.ledger };
  const entries: Record<string, NamespaceMigrationEntry> = {};
  for (const candidate of candidates) {
    if (!isCensusCandidate(candidate)) continue;
    entries[candidate.ghostId] = {
      ghostId: candidate.ghostId,
      relId: candidate.relId,
      capturedAt: now,
      status: 'pending',
    };
  }
  return {
    kind: 'created',
    ledger: {
      schemaVersion: NAMESPACE_MIGRATION_SCHEMA_VERSION,
      censusedAt: now,
      entries,
    },
  };
}

export function classifyNamespaceMigration(
  input: ClassifyNamespaceMigrationInput,
): NamespaceClassification {
  const record = input.marketRecord;
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

export function commitNamespaceMigration(
  ledger: NamespaceMigrationLedger,
  ghostId: string,
  namespace: string | null,
  basis: NamespaceMigrationBasis,
  now: string,
): NamespaceMigrationLedger {
  const current = ledger.entries[ghostId];
  if (!current || current.status === 'committed') {
    return ledger;
  }
  if (namespace !== null && !isValidPluginNamespace(namespace)) {
    return ledger;
  }
  return {
    ...ledger,
    entries: {
      ...ledger.entries,
      [ghostId]: {
        ...current,
        status: 'committed',
        namespace,
        committedAt: now,
        basis,
      },
    },
  };
}

export function commitRootNamespaceMigration(
  ledger: NamespaceMigrationLedger,
  ghostId: string,
  basis: NamespaceMigrationBasis,
  now: string,
): NamespaceMigrationLedger {
  return commitNamespaceMigration(ledger, ghostId, null, basis, now);
}

export type NamespaceCommitPlan =
  | { kind: 'skip'; reason: 'not-pending' | 'busy' }
  | { kind: 'write-ledger-only'; namespace: string | null; basis: 'receipt-recovered' }
  | {
      kind: 'write-receipt-and-ledger';
      namespace: string | null;
      basis: NamespaceMigrationBasis;
    };

/**
 * Crash window: receipt may already carry namespace while the census ledger
 * is still pending. Finish the ledger to match the receipt; do not reclassify.
 * Busy only blocks a first-time receipt write, not ledger recovery.
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
      kind: 'write-ledger-only',
      namespace: input.receiptNamespace,
      basis: 'receipt-recovered',
    };
  }
  if (input.busy) return { kind: 'skip', reason: 'busy' };
  return {
    kind: 'write-receipt-and-ledger',
    namespace: input.requested.namespace,
    basis: input.requested.basis,
  };
}

export function pendingNamespaceGhostIds(ledger: NamespaceMigrationLedger): string[] {
  return Object.values(ledger.entries)
    .filter((entry) => entry.status === 'pending')
    .map((entry) => entry.ghostId);
}

export function isPendingNamespaceGhost(
  ledger: NamespaceMigrationLedger | null,
  ghostId: string,
): boolean {
  return ledger?.entries[ghostId]?.status === 'pending';
}

export function parseNamespaceMigrationLedger(raw: unknown): NamespaceMigrationLedger | null {
  if (!isPlainObject(raw)) return null;
  if (raw.schemaVersion !== NAMESPACE_MIGRATION_SCHEMA_VERSION) return null;
  if (!isIsoTimestamp(raw.censusedAt)) return null;
  if (!isPlainObject(raw.entries)) return null;
  const entries: Record<string, NamespaceMigrationEntry> = {};
  for (const [key, value] of Object.entries(raw.entries)) {
    const entry = parseEntry(value);
    if (!entry || entry.ghostId !== key) return null;
    entries[key] = entry;
  }
  return {
    schemaVersion: NAMESPACE_MIGRATION_SCHEMA_VERSION,
    censusedAt: raw.censusedAt,
    entries,
  };
}

function parseEntry(value: unknown): NamespaceMigrationEntry | null {
  if (!isPlainObject(value)) return null;
  if (!isValidGhostId(value.ghostId) || typeof value.relId !== 'string') return null;
  if (value.relId !== value.ghostId) return null;
  if (!isIsoTimestamp(value.capturedAt)) return null;
  if (value.status !== 'pending' && value.status !== 'committed') return null;
  if (value.status === 'pending') {
    return {
      ghostId: value.ghostId,
      relId: value.relId,
      capturedAt: value.capturedAt,
      status: 'pending',
      ...(typeof value.basis === 'string' ? { basis: value.basis as NamespaceMigrationEntry['basis'] } : {}),
    };
  }
  if (value.namespace !== null && !isValidPluginNamespace(value.namespace)) return null;
  if (!isIsoTimestamp(value.committedAt)) return null;
  if (!isCommittedBasis(value.basis)) return null;
  return {
    ghostId: value.ghostId,
    relId: value.relId,
    capturedAt: value.capturedAt,
    status: 'committed',
    namespace: value.namespace === null ? null : value.namespace,
    committedAt: value.committedAt,
    basis: value.basis,
  };
}

function isCommittedBasis(value: unknown): value is NamespaceMigrationBasis {
  return (
    value === 'builtin' ||
    value === 'market-public' ||
    value === 'market-personal' ||
    value === 'market-custom' ||
    value === 'manual-after-sync' ||
    value === 'explicit-root' ||
    value === 'market-organization' ||
    value === 'forge-current-org' ||
    value === 'receipt-recovered'
  );
}

export function resolveInstallAgainstPending(input: {
  ghostId: string;
  requestedNamespace: string | null;
  pending: boolean;
  classification: NamespaceClassification | null;
}): { kind: 'proceed' } | { kind: 'already-installed' } | { kind: 'wait'; reason: string } {
  if (!input.pending) return { kind: 'proceed' };
  if (input.requestedNamespace === null) return { kind: 'already-installed' };
  if (!input.classification || input.classification.kind === 'pending') {
    return {
      kind: 'wait',
      reason: `意识 ${input.ghostId} 仍在 namespace 待迁移，不能先装同名企业实例`,
    };
  }
  if (input.classification.namespace === input.requestedNamespace) {
    return { kind: 'already-installed' };
  }
  return { kind: 'proceed' };
}

export interface NamespaceMigrationStore {
  read(): NamespaceMigrationLedgerRead;
  write(ledger: NamespaceMigrationLedger): void;
}

export function createNamespaceMigrationStore(filePath: string): NamespaceMigrationStore {
  const read = (): NamespaceMigrationLedgerRead => {
    let text: string;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
      return { kind: 'unreadable' };
    }
    try {
      const ledger = parseNamespaceMigrationLedger(JSON.parse(text));
      if (!ledger) return { kind: 'corrupt' };
      return { kind: 'ok', ledger };
    } catch {
      return { kind: 'corrupt' };
    }
  };

  return {
    read,
    write(ledger: NamespaceMigrationLedger): void {
      const current = read();
      if (current.kind === 'unreadable') {
        throw new Error('namespace migration ledger is unreadable');
      }
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(tempPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
        fs.renameSync(tempPath, filePath);
      } catch (error) {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // temp may not exist
        }
        throw error;
      }
    },
  };
}

export function namespaceMigrationFilePath(stateRoot: string): string {
  return path.join(stateRoot, NAMESPACE_MIGRATION_FILE);
}
