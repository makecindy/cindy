import { purgeRewoundSchedulerPrompts } from '../localDb/ipc/messages.js';

const BATCH = 100;
const MAX_BATCHES_PER_SWEEP = 5;
export const REWOUND_SCHEDULER_PROMPT_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
export const REWOUND_SCHEDULER_PROMPT_CLEANUP_FIRST_DELAY_MS = 30 * 1000;

export type RewoundSchedulerPromptPurge = (
  limit: number,
  cursor: number,
) => Promise<{ deleted: number; cursor: number | null }>;

let stopCleanup: (() => void) | null = null;

/**
 * 每轮从头沿 rewind_at 索引分窗口扫；每批的扫描量由 DB 层限定，与命中多少无关。
 * cursor 回到 null 说明隐藏行已全部看过，本轮结束；没扫完的留给十分钟后的下一轮。
 */
export function startRewoundSchedulerPromptCleanup(
  deps: {
    purge?: RewoundSchedulerPromptPurge;
    logger?: { warn?: (message: string, error?: unknown) => void };
    firstDelayMs?: number;
    intervalMs?: number;
  } = {},
): void {
  stopRewoundSchedulerPromptCleanup();
  const purge: RewoundSchedulerPromptPurge =
    deps.purge ?? ((limit, cursor) => purgeRewoundSchedulerPrompts(limit, cursor));
  let stopped = false;
  let running = false;
  const sweep = async () => {
    if (stopped || running) return;
    running = true;
    try {
      let cursor = 0;
      for (let batch = 0; batch < MAX_BATCHES_PER_SWEEP; batch += 1) {
        if (stopped) return;
        const result = await purge(BATCH, cursor);
        if (result?.cursor == null) return;
        cursor = result.cursor;
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
