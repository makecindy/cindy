import { reserveModelIdForModel } from '@cindy/maker-shared/codex-usage-buckets';
import type { AccountRateLimitsResponse } from '../../types/account-rate-limits.js';

/** Account-scoped, bounded quota lookup. Only the wire request uses the reserve alias. */
export class CodexReserveRoute {
  private readonly accounts = new Map<string, {
    expiresAt: number;
    pending: Promise<AccountRateLimitsResponse | null>;
    snapshot?: AccountRateLimitsResponse | null;
  }>();

  constructor(
    private readonly read: (providerId?: string) => Promise<AccountRateLimitsResponse>,
    private readonly timeoutMs = 5_000,
  ) {}

  async resolve(providerId: string | null | undefined, model: string | undefined): Promise<string | null> {
    if (!model || model === 'gpt-5') return null;
    const key = providerId ?? '';
    let entry = this.accounts.get(key);
    if (!entry || entry.expiresAt <= Date.now()) {
      // Bound the entire read, including control-plane startup. Late results cannot
      // overwrite a newer snapshot or another account's route.
      const pending = new Promise<AccountRateLimitsResponse | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), this.timeoutMs);
        Promise.resolve().then(() => this.read(providerId ?? undefined)).then(
          (result) => { clearTimeout(timer); resolve(result); },
          () => { clearTimeout(timer); resolve(null); },
        );
      });
      entry = { expiresAt: Date.now() + 30_000, pending };
      this.accounts.set(key, entry);
      const captured = entry;
      void pending.then(snapshot => {
        if (this.accounts.get(key) === captured) captured.snapshot = snapshot;
      });
    }
    const snapshot = await entry.pending;
    return reserveModelIdForModel(snapshot?.rateLimitsByLimitId, model);
  }

  invalidate(providerId: string | null | undefined): void {
    this.accounts.delete(providerId ?? '');
  }

  /** Send never waits for control-plane IO. A cold/missing snapshot uses the normal route. */
  cached(providerId: string | null | undefined, model: string | undefined): string | null {
    const entry = this.accounts.get(providerId ?? '');
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return reserveModelIdForModel(entry.snapshot?.rateLimitsByLimitId, model);
  }
}
