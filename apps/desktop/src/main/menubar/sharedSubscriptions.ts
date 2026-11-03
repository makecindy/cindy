import type { ProviderShareReceived } from '@cindy/device-link';
import { parseProviderShareInsights } from '../../shared/providerShareInsights.js';
import { providerLogo } from './logos.js';
import type { MenubarSubscriptionInput } from './snapshot.js';

/** Shares have no disclosed account identity: never deduplicate them by similar percentages. */
export function sharedSubscription(share: ProviderShareReceived, raw: unknown, nowMs: number): MenubarSubscriptionInput | null {
  const view = parseProviderShareInsights(raw);
  if (!view?.capabilities.quota || view.status.quota !== 'ready' || view.quota?.group !== false
    || view.quota.partial || view.quota.accounts.length !== 1) return null;
  const account = view.quota.accounts[0]!;
  if (account.state !== 'ready' || account.balance) return null;
  const week = account.windows.find(window => window.kind === 'week');
  if (!week || (week.resetsAt !== null && week.resetsAt <= nowMs)) return null;
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
    shared: { label: share.providerLabel, note: '' },
  };
}

export interface SharedQuotaDeps {
  scope(): string | null;
  shares(): readonly ProviderShareReceived[];
  read(shareId: string): Promise<unknown>;
  subscribe(changed: () => void): () => void;
  publish(sources: MenubarSubscriptionInput[]): void;
}

/** Visible-panel lease. Closing/revocation clears immediately and rejects every late response. */
export class SharedQuotaReader {
  private revision = 0;
  private open = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dispose: (() => void) | null = null;
  constructor(private readonly deps: SharedQuotaDeps) {}

  setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    if (open) {
      let identity = JSON.stringify([this.deps.scope(), this.deps.shares()]);
      this.dispose = this.deps.subscribe(() => {
        const next = JSON.stringify([this.deps.scope(), this.deps.shares()]);
        if (next === identity) return;
        identity = next;
        this.refresh();
      });
      this.refresh();
    } else {
      this.dispose?.();
      this.dispose = null;
      this.clear();
    }
  }

  private clear(): void {
    this.revision++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.deps.publish([]);
  }

  refresh(): void {
    this.clear();
    if (!this.open) return;
    void this.read(this.revision);
  }

  private async read(revision: number): Promise<void> {
    const scope = this.deps.scope();
    const current = () => this.open && this.revision === revision && scope !== null && this.deps.scope() === scope;
    if (!current()) return;
    const targets = this.deps.shares().filter(share => share.status === 'active' && share.hostOnline && share.hostCapable);
    const sources: MenubarSubscriptionInput[] = [];
    // Bound network fanout; one failed share does not hide other suppliers.
    for (let offset = 0; offset < targets.length && current(); offset += 3) {
      await Promise.all(targets.slice(offset, offset + 3).map(async share => {
        try {
          const result = await this.deps.read(share.shareId);
          if (!current()) return;
          const latest = this.deps.shares().find(item => item.shareId === share.shareId);
          if (!latest || JSON.stringify(latest) !== JSON.stringify(share)) return;
          const source = sharedSubscription(share, result, Date.now());
          if (source) sources.push(source);
        } catch {
          // Failed or revoked reads contribute no cached value.
        }
      }));
    }
    if (!current()) return;
    this.deps.publish(sources.sort((a, b) => a.id.localeCompare(b.id)));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.read(revision);
    }, 5_000);
  }
}
