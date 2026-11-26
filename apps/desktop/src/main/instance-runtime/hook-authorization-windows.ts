import type { HookProvider, SlackHookView } from '../../shared/hookControlIpc.js';
import type { AuthorizationBrowser } from './authorization-browser.js';

type Provider = HookProvider;
interface Lease {
  close: Promise<() => Promise<void>>;
  timer: NodeJS.Timeout;
}

/** Cloud-only adapter; uses authoritative hook state, never page text or callback navigation. */
export class HookAuthorizationWindows {
  private view: SlackHookView | null = null;
  private readonly leases = new Map<Provider, Lease>();
  private readonly cleanups = new Set<Promise<void>>();
  constructor(
    private readonly browser: Pick<AuthorizationBrowser, 'open'>,
    private readonly warn: () => void,
    private readonly maxLifetimeMs = 15 * 60_000,
  ) {}

  pending(provider: Provider): boolean {
    const view = this.view;
    if (!view) return false;
    if (provider !== 'slack')
      return (
        Boolean(view[provider]?.enabled) &&
        ['pending', 'awaiting_confirmation'].includes(view[provider]?.binding?.state ?? '')
      );
    const binding = view.pendingBind ?? view.binding;
    return (
      view.enabled &&
      (binding?.state === 'pending' ||
        (binding?.state === 'failed' && binding.reason === 'not-installed'))
    );
  }

  update(view: SlackHookView): void {
    this.view = view;
    for (const provider of this.leases.keys()) if (!this.pending(provider)) this.finish(provider);
  }

  open(provider: Provider, url: string): Promise<void> {
    this.finish(provider);
    const close = this.browser.open(url);
    const lease: Lease = {
      close,
      timer: setTimeout(() => {
        if (this.leases.get(provider) === lease) this.finish(provider);
      }, this.maxLifetimeMs),
    };
    lease.timer.unref();
    this.leases.set(provider, lease);
    return close.then(
      () => {},
      () => {
        if (this.leases.get(provider) === lease) {
          this.leases.delete(provider);
          clearTimeout(lease.timer);
        }
        throw new Error('AUTHORIZATION_BROWSER_START_FAILED');
      },
    );
  }

  private finish(provider: Provider): void {
    const lease = this.leases.get(provider);
    if (!lease) return;
    this.leases.delete(provider);
    clearTimeout(lease.timer);
    // Completion can precede browser startup. The late window is still reclaimed.
    const cleanup = lease.close
      .then(
        async (close) => {
          // Retain this generation's cleanup handle while retrying transient CDP
          // failures. Backoff is outside the browser queue so a new login or a
          // different provider is not blocked by a failed close.
          for (let attempt = 0; ; attempt++) {
            try { await close(); return; }
            catch (error) {
              if (attempt === 2) throw error;
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, attempt === 0 ? 1_000 : 5_000);
                timer.unref();
              });
            }
          }
        },
        () => {},
      )
      .catch(this.warn);
    this.cleanups.add(cleanup);
    void cleanup.finally(() => this.cleanups.delete(cleanup));
  }

  async dispose(): Promise<void> {
    for (const provider of this.leases.keys()) this.finish(provider);
    this.view = null;
    await Promise.all(this.cleanups);
  }
}
