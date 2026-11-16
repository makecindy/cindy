import type { GithubPrRefresh } from '../scheduler-host/webhook/github';
import type { PrFollowWatch } from './prFollowWatch';
import type { PrStatusService } from './prStatusService';

function query(url: string) {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/i.exec(url);
  return match ? { owner: match[1]!, repo: match[2]!, prNumber: Number(match[3]) } : null;
}

export async function cachedGithubPrHeads(service: PrStatusService, urls: readonly string[]): Promise<Record<string, string>> {
  const valid = urls.flatMap(url => { const pr = query(url); return pr ? [{ url, pr }] : []; });
  const statuses = await service.cachedStatuses(valid.map(item => item.pr));
  return Object.fromEntries(valid.flatMap(({ url }, index) => {
    const result = statuses[index];
    return result?.ok && result.headSha ? [[url, result.headSha]] : [];
  }));
}

/** A batch is acknowledged only after all selected facts have been re-read successfully. */
export async function refreshGithubPrEvents(
  service: PrStatusService, watch: Pick<PrFollowWatch, 'notify' | 'observedSignature'>, urls: readonly string[],
  isCurrent: () => boolean, refresh: GithubPrRefresh,
): Promise<void> {
  const notify = new Set(refresh.notify);
  const pending = [...new Set(urls)];
  let failed = false;
  const worker = async () => {
    while (pending.length && !failed && isCurrent()) {
      const url = pending.shift()!;
      const pr = query(url);
      if (!pr) continue;
      const before = watch.observedSignature(pr);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const [result] = await Promise.race([
          service.getStatuses([pr], { waitForFresh: true, refresh: true }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('PR_VERIFICATION_TIMEOUT')), 30_000);
            timer.unref?.();
          }),
        ]);
        if (!isCurrent()) return;
        if (!result?.ok) throw new Error('PR_VERIFICATION_FAILED');
        // CI uses the shared observer; comments/overflow also check unchanged summaries.
        // A changed observer baseline already rings the follower. An unchanged
        // summary (or first observation) still needs the explicit comment bell.
        if (notify.has(url) && (before === undefined || before === watch.observedSignature(pr))) {
          await watch.notify(url, isCurrent);
        }
      } catch (error) {
        failed = true;
        throw error;
      } finally { if (timer) clearTimeout(timer); }
    }
  };
  // Small bounded concurrency, independent of the ordinary Webhook lane.
  const results = await Promise.allSettled(Array.from({ length: Math.min(4, pending.length) }, worker));
  const error = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (error) throw error.reason;
}
