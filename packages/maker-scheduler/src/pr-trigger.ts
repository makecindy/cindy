import type { Schedule } from './types.js';

export const PR_CHANGES = ['any', 'merged', 'review', 'ci'] as const;
export type PrChange = (typeof PR_CHANGES)[number];
export interface SchedulePrTrigger { url: string; change: PrChange }

const githubPr = /^https:\/\/github\.com\/([a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100})\/pull\/([1-9]\d*)\/?$/i;

export function normalizePrTrigger(value: SchedulePrTrigger): SchedulePrTrigger {
  const match = typeof value?.url === 'string' && githubPr.exec(value.url.trim());
  if (!match || !Number.isSafeInteger(Number(match[2])) || !PR_CHANGES.includes(value.change)) {
    throw new Error('Invalid GitHub pull request trigger');
  }
  return { url: 'https://github.com/' + match[1]!.toLowerCase() + '/pull/' + match[2], change: value.change };
}

/** Older recurring checks opt in by naming PRs in the pre-run command. */
export function schedulePrTriggers(schedule: Pick<Schedule, 'prTrigger' | 'preRunHook' | 'recurring' | 'manual' | 'webhookTrigger'>): SchedulePrTrigger[] {
  if (schedule.webhookTrigger?.source?.preset === 'github-app') return [];
  if (schedule.prTrigger !== undefined) return schedule.prTrigger ? [schedule.prTrigger] : [];
  if (!schedule.recurring || schedule.manual) return [];
  const urls = (schedule.preRunHook?.command ?? '').matchAll(/https:\/\/github\.com\/([a-z\d-]+\/[a-z\d_.-]+)\/pull\/(\d+)(?![a-z\d])/gi);
  return Array.from(new Set(Array.from(urls, match => match[0].toLowerCase())), url => ({ url, change: 'any' }));
}
