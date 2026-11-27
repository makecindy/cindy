// The URL and QR are short-lived account material. Keep them out of agent messages and logs.
type Outcome = 'ready' | 'unavailable' | 'cancelled' | 'unconfirmed';

export interface VerificationUi {
  card(url: string, check: () => void, ended: () => void): Promise<{
    update(url: string): Promise<void>; verified(): void; cancel(): void;
  } | null>;
}

function providerUrl(report: Record<string, unknown>): string | null {
  if (report.status !== 'required' || typeof report.url !== 'string' || report.url.length > 2048) return null;
  try {
    const u = new URL(report.url);
    if (u.origin !== 'https://accounts.google.com' || u.username || u.password || u.hash ||
        [...u.searchParams.keys()].some(key => !['plt', 'continue', 'sarp', 'scc', 'flowName'].includes(key) || u.searchParams.getAll(key).length !== 1) ||
        u.pathname !== '/v3/signin/continue' || !u.searchParams.get('plt') ||
        u.searchParams.getAll('continue').length !== 1 ||
        u.searchParams.get('continue') !== 'https://developers.google.com/gemini-code-assist/auth/auth_success_gemini') return null;
    return u.href;
  } catch { return null; }
}

export async function recoverGoogleAccount(probe: () => Promise<Record<string, unknown>>, signal: AbortSignal, ui: VerificationUi): Promise<Outcome> {
  if (signal.aborted) return 'cancelled';
  const first = providerUrl(await probe().catch(() => ({})));
  if (!first) return 'unconfirmed';
  if (signal.aborted) return 'cancelled';
  let cancelled = false;
  let requested = false;
  let wake: (() => void) | undefined;
  const stop = () => { cancelled = true; wake?.(); };
  const check = () => { requested = true; wake?.(); };
  signal.addEventListener('abort', stop, { once: true });
  let card: Awaited<ReturnType<VerificationUi['card']>> = null;
  try {
    card = await ui.card(first, check, stop);
    if (!card) return 'unavailable';
    if (cancelled) return 'cancelled';
    let lastProbe = Date.now();
    let lastRefresh = lastProbe;
    while (!cancelled && !signal.aborted) {
      const now = Date.now();
      const refresh = requested || now - lastRefresh >= 180000;
      if (requested || now - lastProbe >= 30000) {
        requested = false;
        lastProbe = now;
        const report = await probe().catch(() => ({ status: 'unknown' }));
        if (cancelled || signal.aborted) break;
        if (report.status === 'ready') { card.verified(); return 'ready'; }
        const fresh = providerUrl(report);
        if (fresh && refresh) {
          lastRefresh = now;
          await card.update(fresh);
        }
      }
      if (!requested && !cancelled) await new Promise<void>(resolve => {
        const timer = setTimeout(done, Math.max(0, lastProbe + 30000 - Date.now()));
        function done() { clearTimeout(timer); wake = undefined; resolve(); }
        wake = done;
      });
    }
    return 'cancelled';
  } finally {
    signal.removeEventListener('abort', stop);
    card?.cancel();
  }
}
