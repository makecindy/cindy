import crypto from 'node:crypto';
import path from 'node:path';

import { isValidGhostId } from '../../shared/ghost.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import type { PluginMarketInstallationRecord } from './ledger.js';

const RECOVERY_SCHEMA_VERSION = 1;
const RECOVERY_FILE = 'recovery.v1.json';

export type PluginRecoveryDecisionRecord = 'keep' | 'review' | 'restored';
export type PluginRemovalIntent = 'user-uninstall' | 'server-purge';

interface RecoveryDecision {
  decision: PluginRecoveryDecisionRecord;
  decidedAt: string;
}

interface RemovalReceipt {
  installationKey: string;
  reason: PluginRemovalIntent;
  recordedAt: string;
}

interface SourceEvidence {
  contentDigest: string;
  verifiedAt: string;
}

interface PluginRecoveryStoreData {
  schemaVersion: typeof RECOVERY_SCHEMA_VERSION;
  decisions: Record<string, RecoveryDecision>;
  removalReceipts: Record<string, RemovalReceipt>;
  sourceEvidence: Record<string, SourceEvidence>;
}

function emptyData(): PluginRecoveryStoreData {
  return {
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    decisions: {},
    removalReceipts: {},
    sourceEvidence: {},
  };
}

function sha256(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Identity of one source release; intentionally excludes installed/updatedAt. */
export function pluginInstallationKey(record: PluginMarketInstallationRecord): string {
  return sha256([
    record.pluginId,
    record.ghostId,
    record.releaseId,
    record.version,
    record.sha256,
    record.scope,
    record.organizationId,
    record.source,
    record.sourceKey ?? null,
    record.manifestDigest ?? null,
  ]);
}

/**
 * A removal receipt belongs to one concrete ledger generation. A successful
 * reinstall of the same release gets a new updatedAt, so a stale receipt cannot
 * suppress recovery if clearing the companion file happened to fail.
 */
function pluginRemovalGenerationKey(record: PluginMarketInstallationRecord): string {
  return sha256([pluginInstallationKey(record), record.updatedAt]);
}

/** Identity of the exact historical removal candidate shown to a user. */
export function pluginRecoveryCandidateKey(record: PluginMarketInstallationRecord): string {
  return sha256([pluginInstallationKey(record), record.installed, record.updatedAt]);
}

function validIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function parseData(text: string | null): PluginRecoveryStoreData {
  if (text === null) return emptyData();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyData();
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyData();
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== RECOVERY_SCHEMA_VERSION) return emptyData();
  const out = emptyData();

  if (value.decisions && typeof value.decisions === 'object' && !Array.isArray(value.decisions)) {
    for (const [key, candidate] of Object.entries(value.decisions)) {
      if (!/^[a-f0-9]{64}$/.test(key) || !candidate || typeof candidate !== 'object') continue;
      const decision = candidate as Record<string, unknown>;
      if (
        (decision.decision === 'keep' ||
          decision.decision === 'review' ||
          decision.decision === 'restored') &&
        validIsoDate(decision.decidedAt)
      ) {
        out.decisions[key] = {
          decision: decision.decision,
          decidedAt: decision.decidedAt,
        };
      }
    }
  }

  if (
    value.removalReceipts &&
    typeof value.removalReceipts === 'object' &&
    !Array.isArray(value.removalReceipts)
  ) {
    for (const [ghostId, candidate] of Object.entries(value.removalReceipts)) {
      if (!candidate || typeof candidate !== 'object') continue;
      const receipt = candidate as Record<string, unknown>;
      if (
        isValidGhostId(ghostId) &&
        /^[a-f0-9]{64}$/.test(String(receipt.installationKey)) &&
        (receipt.reason === 'user-uninstall' || receipt.reason === 'server-purge') &&
        validIsoDate(receipt.recordedAt)
      ) {
        out.removalReceipts[ghostId] = {
          installationKey: String(receipt.installationKey),
          reason: receipt.reason,
          recordedAt: receipt.recordedAt,
        };
      }
    }
  }

  if (
    value.sourceEvidence &&
    typeof value.sourceEvidence === 'object' &&
    !Array.isArray(value.sourceEvidence)
  ) {
    for (const [key, candidate] of Object.entries(value.sourceEvidence)) {
      if (!/^[a-f0-9]{64}$/.test(key) || !candidate || typeof candidate !== 'object') continue;
      const evidence = candidate as Record<string, unknown>;
      if (
        /^[a-f0-9]{64}$/.test(String(evidence.contentDigest)) &&
        validIsoDate(evidence.verifiedAt)
      ) {
        out.sourceEvidence[key] = {
          contentDigest: String(evidence.contentDigest),
          verifiedAt: evidence.verifiedAt,
        };
      }
    }
  }
  return out;
}

export class PluginRecoveryStore {
  constructor(private readonly ledgerPathSource: string | (() => string)) {}

  bind(ledgerPath: string): PluginRecoveryStore {
    return typeof this.ledgerPathSource === 'function' ? new PluginRecoveryStore(ledgerPath) : this;
  }

  private filePath(): string {
    const ledgerPath =
      typeof this.ledgerPathSource === 'function' ? this.ledgerPathSource() : this.ledgerPathSource;
    return path.join(path.dirname(ledgerPath), RECOVERY_FILE);
  }

  private read(): PluginRecoveryStoreData {
    return parseData(readAtomicFileSync(this.filePath()));
  }

  private write(data: PluginRecoveryStoreData): void {
    atomicWriteFileSync(this.filePath(), `${JSON.stringify(data, null, 2)}\n`);
  }

  decisionFor(record: PluginMarketInstallationRecord): PluginRecoveryDecisionRecord | null {
    return this.read().decisions[pluginRecoveryCandidateKey(record)]?.decision ?? null;
  }

  recordDecision(
    record: PluginMarketInstallationRecord,
    decision: PluginRecoveryDecisionRecord,
  ): void {
    const data = this.read();
    data.decisions[pluginRecoveryCandidateKey(record)] = {
      decision,
      decidedAt: new Date().toISOString(),
    };
    this.write(data);
  }

  recordDecisions(
    records: readonly PluginMarketInstallationRecord[],
    decision: PluginRecoveryDecisionRecord,
  ): void {
    const data = this.read();
    const decidedAt = new Date().toISOString();
    for (const record of records) {
      data.decisions[pluginRecoveryCandidateKey(record)] = { decision, decidedAt };
    }
    this.write(data);
  }

  recordRemoval(record: PluginMarketInstallationRecord, reason: PluginRemovalIntent): void {
    const data = this.read();
    data.removalReceipts[record.ghostId] = {
      installationKey: pluginRemovalGenerationKey(record),
      reason,
      recordedAt: new Date().toISOString(),
    };
    this.write(data);
  }

  clearRemoval(ghostId: string): void {
    const data = this.read();
    if (!data.removalReceipts[ghostId]) return;
    delete data.removalReceipts[ghostId];
    this.write(data);
  }

  hasRemovalReceipt(record: PluginMarketInstallationRecord): boolean {
    const receipt = this.read().removalReceipts[record.ghostId];
    return receipt?.installationKey === pluginRemovalGenerationKey(record);
  }

  sourceContentDigest(record: PluginMarketInstallationRecord): string | null {
    return this.read().sourceEvidence[pluginInstallationKey(record)]?.contentDigest ?? null;
  }

  recordSourceContentDigest(record: PluginMarketInstallationRecord, contentDigest: string): void {
    const data = this.read();
    data.sourceEvidence[pluginInstallationKey(record)] = {
      contentDigest,
      verifiedAt: new Date().toISOString(),
    };
    this.write(data);
  }
}
