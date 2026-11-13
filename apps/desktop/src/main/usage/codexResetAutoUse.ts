import type {
  CodexResetAutoUseSettings, MobileCodexRateLimitsResult, MobileCodexRateLimitResetResult,
} from '@cindy/maker-shared/device-link-contract';
import { matchCodexBucketForModel } from '@cindy/maker-shared/codex-usage-buckets';

export const DEFAULT_CODEX_RESET_AUTO_USE: Readonly<CodexResetAutoUseSettings> = {
  enabled: false, lowQuota: true, minimumDays: 3, expiring: true, expiryMinutes: 60,
};

export function parseCodexResetAutoUse(raw: unknown): CodexResetAutoUseSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid reset settings');
  const v = raw as Record<string, unknown>;
  if (typeof v.enabled !== 'boolean' || typeof v.lowQuota !== 'boolean' || typeof v.expiring !== 'boolean'
    || typeof v.minimumDays !== 'number' || !Number.isInteger(v.minimumDays) || v.minimumDays < 0 || v.minimumDays > 365
    || typeof v.expiryMinutes !== 'number' || ![30, 60, 360, 1440].includes(v.expiryMinutes)
    || (v.enabled && !v.lowQuota && !v.expiring)) throw new Error('Invalid reset settings');
  return { enabled: v.enabled, lowQuota: v.lowQuota, minimumDays: v.minimumDays,
    expiring: v.expiring, expiryMinutes: v.expiryMinutes };
}

/** Only the ordinary Codex weekly bucket triggers low quota; a different model's bucket cannot spend a card. */
export function shouldAutoUseCodexReset(snapshot: MobileCodexRateLimitsResult, now: number): boolean {
  const settings = snapshot.autoUse?.settings;
  if (!settings?.enabled || !snapshot.resetOffer || snapshot.resetOffer.retryOnly
    || snapshot.resetOffer.validUntil <= now || !snapshot.rateLimitResetCredits?.availableCount) return false;
  const windows = [snapshot.rateLimits, ...Object.values(snapshot.rateLimitsByLimitId ?? {})]
    .flatMap(bucket => [bucket.primary, bucket.secondary])
    .filter(w => w && Number.isFinite(w.usedPercent) && Number.isFinite(w.resetsAt)
      && w.resetsAt! * 1000 > now);
  if (!windows.some(w => w!.usedPercent > 0)) return false;
  const expiry = snapshot.resetOffer.expiresAt;
  if (settings.expiring && typeof expiry === 'number' && expiry * 1000 > now
    && expiry * 1000 - now <= settings.expiryMinutes * 60_000) return true;
  const buckets = snapshot.rateLimitsByLimitId;
  const generic = buckets && Object.keys(buckets).length
    ? matchCodexBucketForModel(buckets, null, now) : snapshot.rateLimits;
  return settings.lowQuota && !!generic && !generic.rateLimitReachedType?.includes('credits_depleted') && [generic.primary, generic.secondary].some(w =>
    w && Number.isFinite(w.usedPercent) && w.usedPercent > 99
    && (w.windowMinutes ?? 0) >= 7 * 24 * 60 && typeof w.resetsAt === 'number'
    && w.resetsAt * 1000 > now && w.resetsAt * 1000 - now >= settings.minimumDays * 86_400_000);
}

export interface CodexResetAutoUseDeps {
  scope(): string;
  read(providerId: string): Promise<MobileCodexRateLimitsResult>;
  /** A synchronous final check immediately before the upstream request. */
  authorized(providerId: string, snapshot: MobileCodexRateLimitsResult): boolean;
  consume(providerId: string, key: string, authorized: () => boolean): Promise<MobileCodexRateLimitResetResult>;
  record(providerId: string, snapshot: MobileCodexRateLimitsResult, at: number): Promise<void>;
  /** Wait for the web quota used by Pi/Claude Code before checking existing waits. */
  refreshWeb(providerId: string): Promise<void>;
  restored(providerId: string, snapshot: MobileCodexRateLimitsResult): Promise<void>;
  now(): number;
  warn(): void;
}

/** One in-flight check per owner/account. Consumption itself shares the manual reset service's lock and key. */
export class CodexResetAutoUse {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly attempts = new Map<string, string>();
  private readonly cooldown = new Map<string, number>();
  constructor(private readonly deps: CodexResetAutoUseDeps) {}

  check(providerId: string): Promise<void> {
    const scope = this.deps.scope();
    const key = `${scope}:${providerId}`;
    const existing = this.pending.get(key);
    if (existing) return existing;
    // Reading also broadcasts usage. Deferring the read installs the in-flight guard before that callback.
    const run = Promise.resolve().then(async () => {
      if ((this.cooldown.get(key) ?? 0) > this.deps.now()) return;
      this.cooldown.set(key, this.deps.now() + 30_000);
      const snapshot = await this.deps.read(providerId);
      const authorized = () => scope === this.deps.scope() && this.deps.authorized(providerId, snapshot);
      if (!authorized()) return;
      const retryOwnAttempt = snapshot.resetOffer?.retryOnly
        && this.attempts.get(key) === snapshot.resetOffer.idempotencyKey;
      if (retryOwnAttempt || shouldAutoUseCodexReset(snapshot, this.deps.now())) {
        this.attempts.set(key, snapshot.resetOffer!.idempotencyKey);
        const result = await this.deps.consume(providerId, snapshot.resetOffer!.idempotencyKey, authorized);
        this.attempts.delete(key);
        if (scope !== this.deps.scope()) return;
        if (result.outcome === 'reset' || result.outcome === 'alreadyRedeemed') {
          // Persistence failure cannot turn a completed redemption into a second attempt.
          try { await this.deps.record(providerId, snapshot, this.deps.now()); } catch { this.deps.warn(); }
          const refreshed = await this.deps.read(providerId);
          if (authorized() && refreshed.autoUse?.accountKey === snapshot.autoUse?.accountKey) {
            await this.deps.refreshWeb(providerId);
            if (authorized()) await this.deps.restored(providerId, refreshed);
          }
        }
      } else {
        // Another device/manual action may have restored quota. Resume only existing eligible waits.
        await this.deps.refreshWeb(providerId);
        if (authorized()) await this.deps.restored(providerId, snapshot);
      }
    }).catch(() => this.deps.warn()).finally(() => this.pending.delete(key));
    this.pending.set(key, run);
    return run;
  }
}
