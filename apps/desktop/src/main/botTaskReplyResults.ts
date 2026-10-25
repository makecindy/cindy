import { createBotTaskReplyResults } from '@cindy/runtime-db/botTaskReplyResults';
import { getDbClient } from './localDb/client/current.js';
export const { readTaskResultsForReply } = createBotTaskReplyResults(getDbClient);
