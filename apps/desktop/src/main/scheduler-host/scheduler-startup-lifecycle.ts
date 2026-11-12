import type { Scheduler } from '@cindy/maker-scheduler';

interface StartSchedulerLifecycleHooks {
  create: () => Scheduler;
  afterStart?: (scheduler: Scheduler) => void | Promise<void>;
  publish?: (scheduler: Scheduler) => void;
}

/**
 * Run the asynchronous scheduler startup behind an account-generation fence.
 * The helper is Electron-free so the reset/start race stays deterministic in
 * unit tests.
 */
export async function runSchedulerStartup(
  startupGeneration: number,
  getGeneration: () => number,
  hooks: StartSchedulerLifecycleHooks,
): Promise<Scheduler> {
  const scheduler = hooks.create();
  await scheduler.start();
  if (getGeneration() !== startupGeneration) {
    await scheduler.stop();
    throw new Error('scheduler startup superseded by reset');
  }
  await hooks.afterStart?.(scheduler);
  if (getGeneration() !== startupGeneration) {
    await scheduler.stop();
    throw new Error('scheduler startup superseded by reset');
  }
  hooks.publish?.(scheduler);
  return scheduler;
}
