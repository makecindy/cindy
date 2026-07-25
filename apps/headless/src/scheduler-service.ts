import {
  BUILTIN_TEMPLATES,
  type CreateScheduleInput,
  type ScheduleTemplate,
  type Scheduler,
  type UpdateScheduleInput,
} from '@cindy/maker-scheduler';
import type { HeadlessScheduleStorage } from './schedule-storage.js';

/** Local control-plane facade around the shared cron engine. */
export class HeadlessSchedulerService {
  constructor(
    private readonly scheduler: Scheduler,
    private readonly storage: HeadlessScheduleStorage,
  ) {}

  start(): Promise<void> { return this.scheduler.start(); }
  stop(): Promise<void> { return this.scheduler.stop(); }
  list(): Promise<unknown> { return this.scheduler.list(); }
  get(id: string): Promise<unknown> { return this.scheduler.get(id); }
  create(input: CreateScheduleInput): Promise<unknown> { return this.scheduler.create(input); }
  update(id: string, patch: UpdateScheduleInput): Promise<unknown> { return this.scheduler.update(id, patch); }
  delete(id: string): Promise<void> { return this.scheduler.delete(id); }
  pause(id: string): Promise<unknown> { return this.scheduler.pause(id); }
  resume(id: string): Promise<unknown> { return this.scheduler.resume(id); }
  runNow(id: string): Promise<unknown> { return this.scheduler.runNow(id); }
  listRuns(id: string, limit?: number): Promise<unknown> { return this.scheduler.listRuns(id, limit); }
  deleteRun(id: string): Promise<void> { return this.scheduler.deleteRun(id); }
  /** Templates are shared with desktop; project-local templates are not yet a headless feature. */
  listTemplates(): ScheduleTemplate[] { return [...BUILTIN_TEMPLATES]; }
  getInflightCount(id: string): number { return this.scheduler.getInflightCount(id); }
  markRunRead(id: string): Promise<string | null> { return this.storage.markRunRead(id); }
  markScheduleRunsRead(id: string): Promise<number> { return this.storage.markScheduleRunsRead(id); }
  runtimeState(): unknown { return this.scheduler.getRuntimeSnapshot(); }
  async unreadCount(): Promise<number> {
    const schedules = await this.scheduler.list();
    let count = 0;
    for (const schedule of schedules) count += (await this.storage.listRuns(schedule.id, 1_000)).filter((run) => run.readAt === undefined && run.status !== 'running').length;
    return count;
  }
}
