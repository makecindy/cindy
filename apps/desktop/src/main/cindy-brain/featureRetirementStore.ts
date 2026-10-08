/** Host-owned, owner/device-scoped retirement receipts. Never modify original install receipts or user data. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isValidGhostId } from '../../shared/ghost.js';
import type { InstalledFeatureRetirement } from '../../shared/featureRetirements.js';

interface RetirementRecord {
  version: 1;
  retirementId: string;
  pluginId: string;
  previouslyEnabled: boolean;
  detectedAt: string;
  acknowledgedAt?: string;
}

export class FeatureRetirementStore {
  constructor(private readonly getStateRoot: () => string) {}

  private file(retirementId: string, pluginId: string): string {
    if (!isValidGhostId(retirementId) || !isValidGhostId(pluginId))
      throw new Error('Invalid retirement identity');
    return path.join(this.getStateRoot(), 'feature-retirements', retirementId, `${pluginId}.json`);
  }

  private read(retirementId: string, pluginId: string): RetirementRecord | undefined {
    let data: string;
    try {
      data = fs.readFileSync(this.file(retirementId, pluginId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const record = JSON.parse(data) as RetirementRecord;
    if (
      record.version !== 1 ||
      record.retirementId !== retirementId ||
      record.pluginId !== pluginId ||
      typeof record.previouslyEnabled !== 'boolean' ||
      typeof record.detectedAt !== 'string' ||
      (record.acknowledgedAt !== undefined && typeof record.acknowledgedAt !== 'string')
    ) {
      throw new Error('Invalid feature retirement record');
    }
    return record;
  }

  private write(record: RetirementRecord): void {
    const file = this.file(record.retirementId, record.pluginId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  /** Call only after confirming an actual installed directory and a valid approval receipt. */
  observe(retirementId: string, pluginId: string, enabled: boolean): InstalledFeatureRetirement {
    let record = this.read(retirementId, pluginId);
    if (!record) {
      record = {
        version: 1,
        retirementId,
        pluginId,
        previouslyEnabled: enabled,
        detectedAt: new Date().toISOString(),
      };
      this.write(record);
    }
    return {
      id: retirementId,
      eligible: record.previouslyEnabled,
      unread: record.previouslyEnabled && !record.acknowledgedAt,
    };
  }

  acknowledge(retirementId: string, pluginId: string): void {
    const record = this.read(retirementId, pluginId);
    if (!record) throw new Error('Feature retirement has not been recorded');
    if (!record.acknowledgedAt) this.write({ ...record, acknowledgedAt: new Date().toISOString() });
  }
}
