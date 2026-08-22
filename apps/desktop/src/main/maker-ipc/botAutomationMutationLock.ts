const tails = new Map<string, Promise<void>>();

/**
 * Scheduler definitions and Bot ownership links live in different state
 * machines. Serialize a fire-time snapshot with edit/archive mutations so a
 * run can never freeze half of the old configuration and half of the new one.
 */
export async function withBotAutomationMutationLock<T>(
  scheduleId: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(scheduleId);
  const waitPrevious = previous ? previous.catch(() => undefined) : Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = waitPrevious.then(() => gate);
  const tracked = current.finally(() => {
    if (tails.get(scheduleId) === tracked) tails.delete(scheduleId);
  });
  tails.set(scheduleId, tracked);
  await waitPrevious;
  try {
    return await task();
  } finally {
    release();
  }
}

export function resetBotAutomationMutationLocksForTest(): void {
  tails.clear();
}
