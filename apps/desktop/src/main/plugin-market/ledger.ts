import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import type { PluginScope } from '@cindy/plugin-protocol';

const LEDGER_SCHEMA_VERSION = 1;

export interface PluginMarketInstallationRecord {
  pluginId: string;
  ghostId: string;
  releaseId: string;
  version: string;
  sha256: string;
  scope: PluginScope;
  organizationId: string | null;
  source: 'market' | 'legacy-adopted';
  installed: boolean;
  updatedAt: string;
}

interface PluginMarketLedgerData {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  installations: Record<string, PluginMarketInstallationRecord>;
  defaultInstallOptOuts: Record<string, string[]>;
}

function emptyLedger(): PluginMarketLedgerData {
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    installations: {},
    defaultInstallOptOuts: {},
  };
}

function validRecord(value: unknown): value is PluginMarketInstallationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.pluginId === 'string' &&
    typeof record.ghostId === 'string' &&
    typeof record.releaseId === 'string' &&
    typeof record.version === 'string' &&
    typeof record.sha256 === 'string' &&
    (record.scope === 'public' ||
      record.scope === 'organization' ||
      record.scope === 'personal') &&
    (record.organizationId === null || typeof record.organizationId === 'string') &&
    (record.source === 'market' || record.source === 'legacy-adopted') &&
    typeof record.installed === 'boolean' &&
    typeof record.updatedAt === 'string'
  );
}

/**
 * Plugin 市场来源账本。包目录仍是 runtime 安装事实；本账本只记录 server
 * Plugin ID、Release 溯源和 defaultInstall 退订，不复制 manifest/凭证。
 */
export class PluginMarketLedger {
  constructor(private readonly filePathSource: string | (() => string)) {}

  /**
   * Binds a dynamic owner-scoped ledger to the path captured at operation start.
   * Static test/isolated ledgers keep their instance so callers can inspect them.
   */
  bind(filePath: string): PluginMarketLedger {
    return typeof this.filePathSource === 'function'
      ? new PluginMarketLedger(filePath)
      : this;
  }

  private filePath(): string {
    return typeof this.filePathSource === 'function'
      ? this.filePathSource()
      : this.filePathSource;
  }

  read(): PluginMarketLedgerData {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath(), 'utf8'));
    } catch {
      return emptyLedger();
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyLedger();
    const value = raw as Record<string, unknown>;
    if (value.schemaVersion !== LEDGER_SCHEMA_VERSION) return emptyLedger();
    const installations: Record<string, PluginMarketInstallationRecord> = {};
    if (value.installations && typeof value.installations === 'object') {
      for (const [ghostId, record] of Object.entries(value.installations)) {
        if (validRecord(record) && record.ghostId === ghostId) installations[ghostId] = record;
      }
    }
    const defaultInstallOptOuts: Record<string, string[]> = {};
    if (value.defaultInstallOptOuts && typeof value.defaultInstallOptOuts === 'object') {
      for (const [userId, pluginIds] of Object.entries(value.defaultInstallOptOuts)) {
        if (!Array.isArray(pluginIds)) continue;
        defaultInstallOptOuts[userId] = [
          ...new Set(pluginIds.filter((id): id is string => typeof id === 'string')),
        ];
      }
    }
    return { schemaVersion: LEDGER_SCHEMA_VERSION, installations, defaultInstallOptOuts };
  }

  installationForGhost(ghostId: string): PluginMarketInstallationRecord | null {
    return this.read().installations[ghostId] ?? null;
  }

  upsertInstallation(record: PluginMarketInstallationRecord): void {
    const data = this.read();
    data.installations[record.ghostId] = record;
    this.write(data);
  }

  markRemoved(ghostId: string, userId: string | null): void {
    const data = this.read();
    const record = data.installations[ghostId];
    if (!record) return;
    data.installations[ghostId] = {
      ...record,
      installed: false,
      updatedAt: new Date().toISOString(),
    };
    if (userId) {
      data.defaultInstallOptOuts[userId] = [
        ...new Set([...(data.defaultInstallOptOuts[userId] ?? []), record.pluginId]),
      ];
    }
    this.write(data);
  }

  isDefaultInstallSuppressed(userId: string, pluginId: string): boolean {
    return this.read().defaultInstallOptOuts[userId]?.includes(pluginId) ?? false;
  }

  private write(data: PluginMarketLedgerData): void {
    const filePath = this.filePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, {
        mode: 0o600,
        flag: 'wx',
      });
      try {
        fs.renameSync(tempPath, filePath);
      } catch (error) {
        // Windows refuses to replace an existing file with renameSync. The
        // destination is only the previous ledger snapshot, so remove it and
        // retry while retaining the freshly flushed temp file.
        const code = error && typeof error === 'object' && 'code' in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
        if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EEXIST')) {
          throw error;
        }
        fs.rmSync(filePath, { force: true });
        fs.renameSync(tempPath, filePath);
      }
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
  }
}
