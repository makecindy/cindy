import { ipcMain } from 'electron';
import { DL_HISTORY_QUERY_CHANNEL } from '@cindy/device-link';
import {
  XdtHelperToolRegistry,
  registerListSessionsTool,
  registerSearchChatHistoryTool,
  historyPayload,
  type XdtHelperHistoryDeps,
} from '@cindy/mcps';
import { listSessionsForHistory } from '../chatHistoryReader.js';
import { searchChatHistoryHybrid } from '../chatHistorySearch.js';
import { capReferenceMessageRows } from './history.js';
import { getDeviceLinkInvokeContext } from '../../device-link/invoke-context.js';
import { requireObject, throwIpcError } from '../../utils/ipcValidate.js';

/** Reuse MCP's strict input validation and the exact same readers/formatters on the source host. */
export function createHistoryQueryHandler(
  deps: Pick<XdtHelperHistoryDeps, 'listSessions' | 'searchChatHistory'>,
) {
  const registry = new XdtHelperToolRegistry();
  const unsupported = async () => ({
    ok: false as const,
    errorCode: 'INTERNAL' as const,
    message: 'Unsupported history operation',
  });
  const history: XdtHelperHistoryDeps = {
    ...deps,
    listWorkdirs: unsupported,
    getMessages: unsupported,
  };
  registerListSessionsTool(registry, { history });
  registerSearchChatHistoryTool(registry, { history });
  return async (value: unknown) => {
    const request = requireObject(value, 'request');
    if (request.tool !== 'list_sessions' && request.tool !== 'search_chat_history') {
      throwIpcError('INVALID_PARAMS', 'Unsupported history query');
    }
    const args = requireObject(request.args, 'args');
    if (args.device !== undefined && args.device !== 'local') {
      throwIpcError('INVALID_PARAMS', 'History queries cannot forward to another device');
    }
    const result = historyPayload(await registry.call(request.tool, args));
    if (Array.isArray(result.hits)) {
      result.hits = result.hits.map((hit) => ({
        ...hit,
        // Snippets are bounded; full text remains available via get_chat_history.
        context: capReferenceMessageRows(
          hit.context.map((row: Record<string, unknown>) => ({ ...row, agentMeta: null })),
          2000,
        ),
      }));
    }
    return result;
  };
}

export function registerHistoryQueryIpc(): void {
  const execute = createHistoryQueryHandler({
    listSessions: async (args) => ({
      ok: true,
      page: await listSessionsForHistory({ ...args, remoteVisibleOnly: true }),
    }),
    searchChatHistory: async (args) => ({
      ok: true,
      result: await searchChatHistoryHybrid({ ...args, remoteVisibleOnly: true }),
    }),
  });
  ipcMain.handle(DL_HISTORY_QUERY_CHANNEL, async (_event, value: unknown) => {
    const context = getDeviceLinkInvokeContext();
    // Not exposed through preload. Only the authenticated same-account tunnel may dispatch it.
    if (!context || context.sharedTask || context.channel !== DL_HISTORY_QUERY_CHANNEL) {
      throwIpcError('PERMISSION_DENIED', 'An authorized device link is required');
    }
    return execute(value);
  });
}
