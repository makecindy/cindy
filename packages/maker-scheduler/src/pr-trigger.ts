import type { Schedule } from './types.js';

export const PR_CHANGES = ['any', 'merged', 'review', 'ci'] as const;
export type PrChange = (typeof PR_CHANGES)[number];
export interface SchedulePrTrigger { url: string; change: PrChange }

const githubPr = /^https:\/\/github\.com\/([a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100})\/pull\/([1-9]\d*)\/?$/i;
/** GitLab MR on any HTTPS instance; same shape the MR status reader (sessionPrRefs) accepts. */
const gitlabMr = /^https:\/\/([a-z\d](?:[a-z\d.-]*[a-z\d])?)\/((?:[a-z\d_.-]+\/)+[a-z\d_.-]+)\/-\/merge_requests\/([1-9]\d*)\/?$/i;

/** GitLab MR triggers have no GitHub App event feed; they need a timed status read unless routed via the GitLab plugin. */
export function isGitlabMrTriggerUrl(url: string | undefined): boolean {
  if (typeof url !== 'string' || url.length > 2048) return false;
  const match = gitlabMr.exec(url.trim());
  if (
    !match ||
    match[1]!.toLowerCase() === 'github.com' ||
    match[2]!.split('/').some((segment) => segment === '.' || segment === '..') ||
    !Number.isSafeInteger(Number(match[3]))
  ) {
    return false;
  }
  try {
    return new URL(match[0]).hostname === match[1]!.toLowerCase();
  } catch {
    return false;
  }
}

/** GitHub PR or GitLab MR; the URL is canonicalised to lower case. */
export function normalizePrTrigger(value: SchedulePrTrigger): SchedulePrTrigger {
  const url = typeof value?.url === 'string' ? value.url.trim() : '';
  if (isGitlabMrTriggerUrl(url) && PR_CHANGES.includes(value.change)) {
    const gitlab = gitlabMr.exec(url)!;
    return {
      url: `https://${gitlab[1]!.toLowerCase()}/${gitlab[2]!.toLowerCase()}/-/merge_requests/${gitlab[3]}`,
      change: value.change,
    };
  }
  const github = githubPr.exec(url);
  if (!github || !Number.isSafeInteger(Number(github[2])) || !PR_CHANGES.includes(value.change)) {
    throw new Error('Invalid GitHub pull request or GitLab merge request trigger');
  }
  return {
    url: 'https://github.com/' + github[1]!.toLowerCase() + '/pull/' + github[2],
    change: value.change,
  };
}

export function isGithubPrTriggerUrl(url: string): boolean {
  return url.toLowerCase().startsWith('https://github.com/');
}

/** Older recurring checks opt in by naming PRs in the pre-run command. */
export function schedulePrTriggers(schedule: Pick<Schedule, 'prTrigger' | 'preRunHook' | 'recurring' | 'manual' | 'webhookTrigger'>): SchedulePrTrigger[] {
  if (schedule.webhookTrigger?.source?.preset === 'github-app') return [];
  if (schedule.prTrigger !== undefined) return schedule.prTrigger ? [schedule.prTrigger] : [];
  if (!schedule.recurring || schedule.manual) return [];
  const urls = (schedule.preRunHook?.command ?? '').matchAll(/https:\/\/github\.com\/([a-z\d-]+\/[a-z\d_.-]+)\/pull\/(\d+)(?![a-z\d])/gi);
  return Array.from(new Set(Array.from(urls, match => match[0].toLowerCase())), url => ({ url, change: 'any' }));
}
