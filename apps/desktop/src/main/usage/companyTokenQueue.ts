import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

export interface CompanyTokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export interface DailyTokens extends CompanyTokenCounts {
  day: string;
  model: string;
}
export interface CompanyPolicy {
  owner: string;
  orgRevision: number;
  memberRevision: number;
}
interface Batch {
  batchId: string;
  orgRevision: number;
  memberRevision: number;
  rows: DailyTokens[];
}
interface Stored extends CompanyPolicy {
  rows: DailyTokens[];
  pending: Batch | null;
}

const counters = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
export function projectUsage(
  models: ReadonlySet<string>,
  day: string,
  model: string,
  counts: CompanyTokenCounts,
): DailyTokens | null {
  if (
    !models.has(model) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !counters.every((k) => Number.isSafeInteger(counts[k]) && counts[k] >= 0) ||
    counters.every((k) => counts[k] === 0)
  )
    return null;
  return {
    day,
    model,
    input: counts.input,
    output: counts.output,
    cacheRead: counts.cacheRead,
    cacheWrite: counts.cacheWrite,
  };
}

/** Single main-process writer. A rename commits the aggregate and its outbox together. */
export class CompanyTokenQueue {
  constructor(private readonly file: string) {}

  clear() {
    rmSync(this.file, { force: true });
    rmSync(this.file + '.tmp', { force: true });
  }

  scope(): CompanyPolicy {
    const { owner, orgRevision, memberRevision } = JSON.parse(
      readFileSync(this.file, 'utf8'),
    ) as Stored;
    return { owner, orgRevision, memberRevision };
  }

  private save(data: Stored) {
    writeFileSync(this.file + '.tmp', JSON.stringify(data), { mode: 0o600, flush: true });
    renameSync(this.file + '.tmp', this.file);
  }

  private read(policy: CompanyPolicy): Stored {
    if (existsSync(this.file)) {
      const data: Stored = JSON.parse(readFileSync(this.file, 'utf8'));
      if (
        data.owner === policy.owner &&
        data.orgRevision === policy.orgRevision &&
        data.memberRevision === policy.memberRevision
      )
        return data;
      this.clear();
    }
    return { ...policy, rows: [], pending: null };
  }

  add(policy: CompanyPolicy, row: DailyTokens) {
    const data = this.read(policy);
    const previous = data.rows.find((r) => r.model === row.model && r.day === row.day);
    if (previous) {
      if (!counters.every((k) => Number.isSafeInteger(previous[k] + row[k]))) return;
      for (const k of counters) previous[k] += row[k];
    } else data.rows.push(row);
    this.save(data);
  }

  next(policy: CompanyPolicy, cutoff: string): Batch | null {
    const data = this.read(policy);
    if (data.pending) return data.pending;
    const rows = data.rows.filter((row) => row.day <= cutoff).slice(0, 256);
    if (!rows.length) return null;
    const batch = {
      batchId: randomUUID(),
      orgRevision: policy.orgRevision,
      memberRevision: policy.memberRevision,
      rows,
    };
    data.rows = data.rows.filter((row) => !rows.includes(row));
    data.pending = batch;
    this.save(data);
    return batch;
  }

  acknowledge(policy: CompanyPolicy, batchId: string) {
    const data = this.read(policy);
    if (data.pending?.batchId !== batchId) return;
    data.pending = null;
    if (data.rows.length) this.save(data);
    else this.clear();
  }
}
