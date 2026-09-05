import type { ScheduleRun } from '@cindy/maker-scheduler';

type RunUnreadFields = Pick<ScheduleRun, 'readAt' | 'status'>;

export function isFailedScheduleRun(run: Pick<ScheduleRun, 'status'>): boolean {
  return run.status === 'failed' || run.status === 'interrupted';
}

export function isUnreadFailedScheduleRun(run: RunUnreadFields): boolean {
  return !run.readAt && isFailedScheduleRun(run);
}

export function isUnreadScheduleRun(run: RunUnreadFields): boolean {
  return (
    !run.readAt &&
    (run.status === 'success' || run.status === 'failed' || run.status === 'interrupted')
  );
}
