import { Scheduler as CoreScheduler, type SchedulerOptions } from '@cindy/plugin-runtime/download/scheduler';
import { desktopDownloadRuntime } from './runtime';
export type { SchedulerOptions } from '@cindy/plugin-runtime/download/scheduler';
export class Scheduler extends CoreScheduler {
  constructor(options: SchedulerOptions) { super({ ...desktopDownloadRuntime, ...options }); }
}
