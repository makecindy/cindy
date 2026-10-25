import { createBotCanonicalSessionRegistry } from '@cindy/app-runtime/botCanonicalSessionRegistry';
import { getDbClient } from '../localDb/client/current.js';
export type { BotCanonicalSessionResolution } from '@cindy/app-runtime/botCanonicalSessionRegistry';
export const { resolveBotCanonicalSession } = createBotCanonicalSessionRegistry(getDbClient);
