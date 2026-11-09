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
  service: PrStatusService, watch: Pick<PrFollowWatch, 'notify'>, urls: readonly string[],
  isCurrent: () => boolean, refresh: GithubPrRefresh,
): Promise<void> {
  const notify = new Set(refresh.notify);
  for (const url of new Set(urls)) {
    if (!isCurrent()) return;
    const pr = query(url);
    if (!pr) continue;
    const [result] = await service.getStatuses([pr], { waitForFresh: true, refresh: true });
    if (!isCurrent()) return;
    if (!result?.ok) throw new Error('PR_VERIFICATION_FAILED');
    // CI changes are detected by onObserved; comments/overflow need a gate check
    // even when the summary is identical. The gate still decides whether to run AI.
    if (notify.has(url)) await watch.notify(url, isCurrent);
  }
}
