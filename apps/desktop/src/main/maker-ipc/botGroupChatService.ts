import { getDbClient } from '../localDb/client/current.js';
import { createBotGroupChatRuntime } from '@cindy/app-runtime/botGroupChatService';
export * from '@cindy/app-runtime/botGroupChatService';
export const { createBotGroupChatService, readPersistedReplyText } = createBotGroupChatRuntime({ getDbClient });
