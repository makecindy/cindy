import { getDbClient } from '../localDb/client/current.js';
import { createBotGroupTaskPostSnapshot } from '@cindy/app-runtime/botGroupTaskPostSnapshot';
export * from '@cindy/app-runtime/botGroupTaskPostSnapshot';
export const { prepareBotGroupTaskPost } = createBotGroupTaskPostSnapshot(getDbClient);
