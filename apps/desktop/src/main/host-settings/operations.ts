import { createHmac, randomBytes, randomUUID } from 'node:crypto';

/** Receipts deliberately retain no settings values or confirmation contents. */
export interface SettingsOperationReceipt {
  operationId: string;
  domain: string;
  status: 'saved' | 'rejected' | 'unknown';
  saved: boolean;
  application: 'next_task' | 'next_agent_start' | 'applied' | 'failed' | 'not_applied';
  revision?: string;
  code?: string;
}

export class HostSettingsError extends Error {
  constructor(readonly code: string) { super(`Host settings: ${code}`); }
}

interface Entry {
  owner: string;
  caller: string;
  domain: string;
  revision: string;
  expiresAt: number;
  digest?: string;
  promise?: Promise<SettingsOperationReceipt>;
  receipt?: SettingsOperationReceipt;
}

/**
 * Process-local, bounded operation journal. IDs are issued by a read, not invented
 * by the model: absent/expired/restarted IDs can never accidentally replay a write.
 * These IDs are correlation only, NEVER evidence of human consent.
 */
export class SettingsOperationJournal {
  private readonly entries = new Map<string, Entry>();
  private readonly key = randomBytes(32);
  constructor(private readonly now: () => number = Date.now, private readonly capacity = 256, private readonly ttlMs = 10 * 60_000) {}

  issue(owner: string, caller: string, domain: string, revision: string): string {
    this.prune();
    if (this.entries.size >= this.capacity) {
      // Never evict an in-flight write; callers can recover its real receipt.
      const removable = [...this.entries].find(([, entry]) => !entry.promise || entry.receipt);
      if (!removable) throw new HostSettingsError('BUSY');
      this.entries.delete(removable[0]);
    }
    const id = randomUUID();
    this.entries.set(id, { owner, caller, domain, revision, expiresAt: this.now() + this.ttlMs });
    return id;
  }

  async execute(args: {
    operationId: string; owner: string; caller: string; domain: string; revision: string;
    normalizedChange: unknown;
    assertCurrent: () => void;
    perform: () => Promise<SettingsOperationReceipt>;
  }): Promise<SettingsOperationReceipt> {
    this.prune();
    args.assertCurrent();
    const entry = this.entries.get(args.operationId);
    if (!entry) throw new HostSettingsError('OUTCOME_UNKNOWN');
    if (entry.owner !== args.owner || entry.caller !== args.caller || entry.domain !== args.domain || entry.revision !== args.revision) {
      throw new HostSettingsError('OPERATION_MISMATCH');
    }
    const digest = createHmac('sha256', this.key).update(JSON.stringify(args.normalizedChange)).digest('hex');
    if (entry.digest && entry.digest !== digest) throw new HostSettingsError('OPERATION_MISMATCH');
    if (entry.receipt) return { ...entry.receipt };
    if (entry.promise) return entry.promise;
    entry.digest = digest;
    // The first await happens after the promise has been registered, making
    // concurrent same-ID calls converge on one confirmation and one write.
    entry.promise = Promise.resolve().then(args.perform).then((receipt) => {
      entry.receipt = { ...receipt };
      return { ...receipt };
    }, (error: unknown) => {
      const code = error instanceof HostSettingsError ? error.code : 'SAVE_FAILED';
      const receipt: SettingsOperationReceipt = {
        operationId: args.operationId, domain: args.domain, status: 'rejected', saved: false,
        application: 'not_applied', code,
      };
      entry.receipt = receipt;
      return { ...receipt };
    });
    return entry.promise;
  }

  get(operationId: string, owner: string, caller: string): SettingsOperationReceipt | { status: 'pending' | 'unknown' } {
    this.prune();
    const entry = this.entries.get(operationId);
    if (!entry || entry.owner !== owner || entry.caller !== caller) return { status: 'unknown' };
    return entry.receipt ? { ...entry.receipt } : { status: 'pending' };
  }

  private prune(): void {
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= this.now() && (!entry.promise || entry.receipt)) this.entries.delete(id);
    }
  }
}
