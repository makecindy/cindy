import { extractIpcError } from '@/utils/ipcError';

/**
 * 打开一个伙伴默认就是打开 TA 的对话，但有两种时候不能抢跑：
 *
 * - `settingsOpen`：用户要看的是设置页，不是对话。
 * - `addRequested`：URL 上还带着老的 `?add=1`（阵容还是模态那阵子的深链）。
 *   这一帧正在被重定向到 `/bots/roster`，此时再去建/跳主任务，用户会先被扔进
 *   一个对话再被拽走。
 *
 * 阵容页面化之后不再有「模态开着」这一态，所以 `addOpen` 不复存在。
 */
export function shouldDeferCanonicalBotSessionNavigation(input: {
  settingsOpen: boolean;
  addRequested: boolean;
}): boolean {
  return input.settingsOpen || input.addRequested;
}

const DEFAULT_CANONICAL_CREATE_RETRY_DELAYS_MS = [150, 400, 900] as const;
const DEFAULT_CANONICAL_CREATE_ATTEMPT_TIMEOUT_MS = 8_000;

export class BotCanonicalSessionCreateTimeoutError extends Error {
  constructor() {
    super('Bot canonical Session creation timed out');
    this.name = 'BotCanonicalSessionCreateTimeoutError';
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BotCanonicalSessionCreateTimeoutError()), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function withBotCanonicalSessionReadTimeout<T>(
  read: () => Promise<T>,
  timeoutMs = DEFAULT_CANONICAL_CREATE_ATTEMPT_TIMEOUT_MS,
): Promise<T> {
  return withTimeout(read(), timeoutMs);
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Bot creation can race the account-owned local DB during the first renderer
 * boot. Retry only those short-lived readiness failures, and bound every IPC
 * attempt so a cancelled page cannot leave its navigation gate locked forever.
 * The main-side CAS makes repeated null-expected creates idempotent.
 */
export function isRetryableBotCanonicalSessionCreateError(error: unknown): boolean {
  const ipcError = extractIpcError(error);
  const message = [
    ipcError?.message,
    error instanceof Error ? error.message : String(error),
  ]
    .filter(Boolean)
    .join(' ');
  return /DbClient not ready|Bot 数据服务尚未初始化|App session is switching|session is switching/i.test(
    message,
  );
}

export async function createBotCanonicalSessionWithRetry<T>(
  create: () => Promise<T>,
  options: {
    retryDelaysMs?: readonly number[];
    attemptTimeoutMs?: number;
    wait?: (delayMs: number) => Promise<void>;
  } = {},
): Promise<T> {
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_CANONICAL_CREATE_RETRY_DELAYS_MS;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_CANONICAL_CREATE_ATTEMPT_TIMEOUT_MS;
  const wait = options.wait ?? sleep;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return await withTimeout(create(), attemptTimeoutMs);
    } catch (error) {
      lastError = error;
      const retryable =
        error instanceof BotCanonicalSessionCreateTimeoutError ||
        isRetryableBotCanonicalSessionCreateError(error);
      if (!retryable || attempt === retryDelaysMs.length) throw error;
      await wait(retryDelaysMs[attempt]);
    }
  }

  throw lastError ?? new Error('Bot canonical Session creation failed');
}
