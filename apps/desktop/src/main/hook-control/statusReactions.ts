/** Client-owned palettes sent on every hello; cosmetic changes need no server release. */
import { PROCESSING_REACTION_POOL, EXPRESSIVE_ERROR_POOL } from '@cindy/im';
import type { HookStatusReactions } from '@cindy/slack-hook-protocol';

export const HOOK_STATUS_REACTIONS = {
  slack: {
    queued: 'eyes',
    processing: ['female-technologist::skin-tone-2', 'thinking_face', 'nerd_face', 'writing_hand'],
    error: 'flash03',
  },
  telegram: {
    queued: '👀',
    processing: PROCESSING_REACTION_POOL,
    error: '👎',
    expressiveError: EXPRESSIVE_ERROR_POOL,
  },
} satisfies Record<'slack' | 'telegram', HookStatusReactions>;
