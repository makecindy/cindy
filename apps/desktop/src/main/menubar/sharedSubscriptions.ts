import type { ProviderShareReceived } from '@cindy/device-link';
import { parseProviderShareInsights } from '../../shared/providerShareInsights.js';
import { providerLogo } from './logos.js';
import type { MenubarSubscriptionInput } from './snapshot.js';

/** Shares have no disclosed account identity: never deduplicate them by similar percentages. */
export function sharedSubscription(share: ProviderShareReceived, raw: unknown, nowMs: number): MenubarSubscriptionInput | null {
  const view = parseProviderShareInsights(raw);
  if (!view?.capabilities.quota || view.status.quota !== 'ready' || !view.quota) return null;
  // Pick one whole readable account, rather than adding percentages or mixing windows.
  const candidates = view.quota.accounts.flatMap(account => {
    if (account.state !== 'ready' || account.balance) return [];
    const week = account.windows.find(window => window.kind === 'week');
    if (!week || (week.resetsAt !== null && week.resetsAt <= nowMs)) return [];
    return [{ account, remaining: week.remainingPercent }];
  });
  const best = candidates.reduce<(typeof candidates)[number] | null>((best, candidate) =>
    !best || candidate.remaining > best.remaining ? candidate : best, null);
  if (!best) return null;
  const { account } = best;
  return {
    kind: 'subscription', id: `share:${share.shareId}`, providerId: share.providerId,
    family: 'shared', brand: share.providerLabel, logoSvg: providerLogo(share.providerId, share.providerLabel),
    account: null, plan: null, credits: null, creditsUnlimited: false, prepaidUsd: null,
    windows: account.windows.filter(window => window.resetsAt === null || window.resetsAt > nowMs).map(window => ({
      kind: window.kind, label: window.label, usedPercent: 100 - window.remainingPercent,
      resetsAtMs: window.resetsAt, windowMinutes: window.windowMinutes && window.windowMinutes > 0
        ? window.windowMinutes : window.kind === 'session' ? 300 : 10_080,
    })),
    updatedAtMs: account.updatedAt,
    shared: { label: share.owner?.displayName?.trim() || share.providerLabel, note: '',
      ownerName: share.owner?.displayName?.trim() || undefined,
      highestWeekly: view.quota.group || view.quota.partial || view.quota.accounts.length > 1 },
  };
}

export interface SharedQuotaDeps {
  scope(): string | null;
  shares(): readonly ProviderShareReceived[];
  accessEpoch(shareId: string): number;
  read(shareId: string): Promise<unknown>;
  subscribe(changed: () => void): () => void;
  publish(sources: MenubarSubscriptionInput[]): void;
}

interface SharedQuotaReading {
  share: ProviderShareReceived;
  accessEpoch: number;
  raw: unknown;
}

/** Visible-panel lease. Closing/revocation clears immediately and rejects every late response. */
export class SharedQuotaReader {
  private revision = 0;
  private open = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dispose: (() => void) | null = null;
  private identity: string | null = null;
  private readings: SharedQuotaReading[] = [];
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly deps: SharedQuotaDeps) {}

  private currentIdentity(): string {
    return JSON.stringify([this.deps.scope(), this.deps.shares().map(share =>
      [share, this.deps.accessEpoch(share.shareId)])]);
  }

  private isCurrentReading(reading: SharedQuotaReading): boolean {
    const latest = this.deps.shares().find(share => share.shareId === reading.share.shareId);
    return this.deps.accessEpoch(reading.share.shareId) === reading.accessEpoch
      && latest !== undefined && JSON.stringify(latest) === JSON.stringify(reading.share);
  }

  setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    if (open) {
      this.dispose = this.deps.subscribe(() => {
        const next = this.currentIdentity();
        if (next === this.identity) return;
        this.refresh();
      });
      this.refresh();
    } else {
      this.dispose?.();
      this.dispose = null;
      this.clear();
      this.identity = null;
    }
  }

  private invalidateRead(): void {
    this.revision++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private clear(): void {
    this.invalidateRead();
    this.clearReadings();
  }

  private clearReadings(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.readings = [];
    this.deps.publish([]);
  }

  refresh(): void {
    if (!this.open) {
      this.clear();
      return;
    }
    const identity = this.currentIdentity();
    this.invalidateRead();
    // Keep the detail source mounted during a same-identity manual refresh. A scope or
    // relationship change must still remove the old reading before its replacement arrives.
    if (identity !== this.identity) this.clearReadings();
    this.identity = identity;
    void this.read(this.revision);
  }

  private async read(revision: number): Promise<void> {
    const scope = this.deps.scope();
    const current = () => this.open && this.revision === revision && scope !== null && this.deps.scope() === scope;
    if (!current()) return;
    const targets = this.deps.shares().filter(share => share.status === 'active' && share.hostOnline && share.hostCapable);
    const results: SharedQuotaReading[] = [];
    // Bound network fanout; one failed share does not hide other suppliers.
    for (let offset = 0; offset < targets.length && current(); offset += 3) {
      await Promise.all(targets.slice(offset, offset + 3).map(async share => {
        const accessEpoch = this.deps.accessEpoch(share.shareId);
        try {
          const result = await this.deps.read(share.shareId);
          if (!current()) return;
          const reading = { share, accessEpoch, raw: result };
          if (!this.isCurrentReading(reading)) return;
          results.push(reading);
        } catch {
          // Failed or revoked reads contribute no cached value.
        }
      }));
    }
    if (!current()) return;
    this.readings = results;
    this.publishReadings();
    if (!current()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.read(revision);
    }, 5_000);
  }

  private publishReadings(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (!this.open) return;
    // Refusals can change the access epoch before the received DTO changes. Recheck at
    // publication too, including a fast result held while a sibling request was pending.
    if (this.currentIdentity() !== this.identity) { this.refresh(); return; }
    const now = Date.now();
    const sources = this.readings.flatMap(reading => {
      if (!this.isCurrentReading(reading)) return [];
      const source = sharedSubscription(reading.share, reading.raw, now);
      return source ? [source] : [];
    });
    this.deps.publish(sources.sort((a, b) => a.id.localeCompare(b.id)));
    // This timer is independent of network polling/manual refresh, so a slow replacement
    // cannot keep an expired value visible. Reprojection can select a live group fallback.
    const resets = sources.flatMap(source => source.windows.flatMap(window =>
      window.resetsAtMs !== null ? [window.resetsAtMs] : []));
    if (resets.length) this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.publishReadings();
    }, Math.min(Math.min(...resets) - now, 2_147_483_647));
  }
}
