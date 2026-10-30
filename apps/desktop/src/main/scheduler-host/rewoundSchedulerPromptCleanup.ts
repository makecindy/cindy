import { purgeRewoundSchedulerPrompts } from '../localDb/ipc/messages.js';

const BATCH = 100;
const MAX_BATCHES_PER_SWEEP = 5;
export const REWOUND_SCHEDULER_PROMPT_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
export const REWOUND_SCHEDULER_PROMPT_CLEANUP_FIRST_DELAY_MS = 30 * 1000;

let stopCleanup: (() => void) | null = null;

export function startRewoundSchedulerPromptCleanup(
  deps: {
    purge?: (limit: number) => Promise<{ deleted: number }>;
    logger?: { warn?: (message: string, error?: unknown) => void };
    firstDelayMs?: number;
    intervalMs?: number;
  } = {},
): void {
  stopRewoundSchedulerPromptCleanup();
  const purge = deps.purge ?? ((limit: number) => purgeRewoundSchedulerPrompts(limit));
  let stopped = false;
  let running = false;
  const sweep = async () => {
    if (stopped || running) return;
    running = true;
    try {
      for (let batch = 0; batch < MAX_BATCHES_PER_SWEEP; batch += 1) {
        if (stopped) return;
        const result = await purge(BATCH);
        if ((result?.deleted ?? 0) < BATCH) return;
      }
    } catch (error) {
      deps.logger?.warn?.('rewound scheduler prompt cleanup failed', error);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => {
    void sweep();
  }, deps.firstDelayMs ?? REWOUND_SCHEDULER_PROMPT_CLEANUP_FIRST_DELAY_MS);
  first.unref?.();
  const timer = setInterval(() => {
    void sweep();
  }, deps.intervalMs ?? REWOUND_SCHEDULER_PROMPT_CLEANUP_INTERVAL_MS);
  timer.unref?.();
  stopCleanup = () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
  };
}

export function stopRewoundSchedulerPromptCleanup(): void {
  stopCleanup?.();
  stopCleanup = null;
}
