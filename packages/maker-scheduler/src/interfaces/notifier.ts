import type { Schedule, ScheduleRun } from '../types.js';

/** Host-only publication barrier; null suppresses a cancelled or empty report.
 * Never persisted or accepted through schedule CRUD / remote tool arguments. */
export type PrepareScheduleNotification = (run: ScheduleRun, executionSignal?: AbortSignal) => Promise<ScheduleRun | null>;

export interface Notifier {
  notify(schedule: Schedule, run: ScheduleRun, prepare?: PrepareScheduleNotification): Promise<void>;
}
