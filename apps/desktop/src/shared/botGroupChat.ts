/** Shared wire and presentation contract; Desktop import path. */
export * from '@cindy/maker-shared/botGroupChat';

import type { BotGroupFailure } from '@cindy/maker-shared/botGroupChat';

/** The desktop outbox uses the server deadline when admitting a retry. */
export type BotGroupSendResult = { ok: true; messageId: string }
  | (BotGroupFailure & { retryAt?: number; postRateLimited?: true });
