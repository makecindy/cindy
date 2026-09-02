import { getDbClient } from './client/current.js';

export async function commitBotProfileDeletion(input: {
  botId: string;
  sessionIds: string[];
  keepTaskHistory: boolean;
}): Promise<{ sessionIds: string[]; status: 'archived' | 'deleted' }> {
  return getDbClient().tx('bots.deleteProfile', {
    botId: input.botId,
    sessionIds: [...new Set(input.sessionIds)],
    keepTaskHistory: input.keepTaskHistory,
    at: Date.now(),
  });
}
