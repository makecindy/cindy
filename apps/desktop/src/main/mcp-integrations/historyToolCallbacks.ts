import type { ToolCallAuthorizer, XdtHelperMcpDeps } from '@cindy/mcps';
import { listWorkdirsForHistory, listSessionsForHistory, getMessagesForHistory } from '../localDb/chatHistoryReader.js';
import { searchChatHistoryHybrid } from '../localDb/chatHistorySearch.js';
import { resolveBotHistorySessionIds } from '../localDb/botHistoryScope.js';
import { isDbClientNotReadyError } from '../localDb/client/current.js';
import { getPluginHostToolCaller } from './hostToolCaller.js';
import { readChatHistoryMessages, type ChatHistoryReaderDeps } from './remoteChatHistory.js';

/** Shared helper history callbacks. Desktop and Node supply transport and the
 * same task-action authorizer; querying, pagination and Bot scope live here. */
export function createHistoryToolCallbacks(deps: {
  authorizeCall: ToolCallAuthorizer;
  invokeRemote: ChatHistoryReaderDeps['invokeRemote'];
}): Pick<NonNullable<XdtHelperMcpDeps['history']>,
  'resolveSessionScope' | 'listWorkdirs' | 'listSessions' | 'getMessages' | 'searchChatHistory'> {
  const failure = (error: unknown) => ({ ok: false as const,
    errorCode: isDbClientNotReadyError(error) ? 'HOST_NOT_READY' as const : 'INTERNAL' as const,
    message: error instanceof Error ? error.message : String(error) });
  return {
    async resolveSessionScope({ callerSessionId, callerMemoryScopeKey }) {
      try {
        if (!callerSessionId && getPluginHostToolCaller()) return { ok: true, sessionIds: null };
        const access = await deps.authorizeCall({ sessionId: callerSessionId, server: 'cindy_helper', tool: 'history', args: {} });
        return { ok: true, sessionIds: access.ok ? null
          : await resolveBotHistorySessionIds(callerSessionId, callerMemoryScopeKey) };
      } catch (error) { return failure(error); }
    },
    async listWorkdirs(args) {
      try { return { ok: true, page: await listWorkdirsForHistory(args) }; }
      catch (error) { return failure(error); }
    },
    async listSessions(args) {
      try { return { ok: true, page: await listSessionsForHistory(args) }; }
      catch (error) { return failure(error); }
    },
    getMessages: args => readChatHistoryMessages(args, { readLocal: getMessagesForHistory, invokeRemote: deps.invokeRemote }),
    async searchChatHistory(args) {
      try { return { ok: true, result: await searchChatHistoryHybrid(args) }; }
      catch (error) { return failure(error); }
    },
  };
}
