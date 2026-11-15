import type { Schedule, ScheduleWebhookEvent } from '@cindy/maker-scheduler';
import { prFollowCommand } from '../../git-context/prFollowWatch';

export const GITHUB_WATCH_SCHEDULE = '__github_pr_watch__';
export const GITHUB_EVENT_CACHE_TTL_MS = 5 * 60_000;
export interface GithubPrRefresh {
  reason: 'event' | 'overflow' | 'reconnect';
  /** Comments can change without changing the PR summary. CI uses the status observer. */
  notify: readonly string[];
}
export interface GithubAppStatus {
  available: boolean;
  login?: string | null;
  endpointId?: string | null;
  installUrl?: string;
  repositories?: string[];
  unavailable?: string[];
  /** Optional capabilities; absent on older servers. */
  prSubscriptions?: boolean;
  dailyQuotaExempt?: boolean;
  automationSubscriptions?: boolean;
  events?: string[];
  /** False when the regional queue or upstream permission checks are delayed. */
  deliveryHealthy?: boolean;
}

/** Subscribe only to repositories named by existing active PR follow-up checks. */
export function followedGithubPrs(schedules: readonly Schedule[]): string[] {
  const urls = new Set<string>();
  for (const schedule of schedules) {
    if (schedule.status !== 'active' || !schedule.recurring || schedule.manual) continue;
    // Explicit App tasks own their repository/event filters and do not also
    // subscribe through the implicit PR-follow observer.
    if (schedule.webhookTrigger?.source?.preset === 'github-app') continue;
    for (const match of prFollowCommand(schedule).matchAll(/https:\/\/github\.com\/([a-z\d-]+\/[a-z\d_.-]+)\/pull\/(\d+)(?![a-z\d])/gi)) {
      urls.add(`https://github.com/${match[1]}/pull/${match[2]}`);
    }
  }
  return [...urls];
}

export function matchingGithubPrs(
  urls: readonly string[], events: readonly ScheduleWebhookEvent[], heads: Readonly<Record<string, string>> = {},
): string[] {
  return urls.filter(url => {
    const match = /^https:\/\/github\.com\/(.+)\/pull\/(\d+)$/.exec(url);
    return match && events.some(event => !['issues', 'push', 'release'].includes(event.event)
      && event.repository?.toLowerCase() === match[1]!.toLowerCase()
      && (event.number !== undefined ? event.number === Number(match[2])
        : Boolean(event.headSha && heads[url] && event.headSha.toLowerCase() === heads[url]!.toLowerCase())));
  });
}
