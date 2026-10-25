import {createRemoteHistoryMessagesHandler,type RemoteHistoryIpcDeps} from '@cindy/app-runtime/remoteHistoryMessages';
import { z } from 'zod';
import { XdtHelperToolRegistry } from '../../../../packages/lizi-mcps/src/lizi_xdtHelperToolRegistry.js';
import { registerListSessionsTool } from '../../../../packages/lizi-mcps/src/xdt-helper/list_sessions.js';
import { registerSearchChatHistoryTool } from '../../../../packages/lizi-mcps/src/xdt-helper/search_chat_history.js';
import { historyPayload } from '../../../../packages/lizi-mcps/src/xdt-helper/_history_devices.js';
import type { XdtHelperHistoryDeps } from '../../../../packages/lizi-mcps/src/xdt-helper/_history_types.js';

/** Device-link's released history contracts; reuse the same MCP query validators. */
export function createRemoteHistory(history: XdtHelperHistoryDeps, get: (id: string) => Promise<unknown>, guard: () => void, readTerminal: RemoteHistoryIpcDeps['readTerminal']) {
  return {
    async messages(value: unknown) {
      guard();
      const result=await createRemoteHistoryMessagesHandler({
        sessionExists:async id=>Boolean(await get(id)),
        getMessages:async args=>{guard();const result=await history.getMessages(args);if(!result.ok)throw new Error(result.errorCode);return result.page;},
        readTerminal,
      })(value);
      guard();return result;
    },
    async query(value: unknown) {
      const input = z.object({ tool: z.enum(['list_sessions', 'search_chat_history']), args: z.record(z.string(), z.unknown()) }).parse(value);
      if (input.args.device !== undefined && input.args.device !== 'local') throw new Error('INVALID_HISTORY_DEVICE');
      const registry = new XdtHelperToolRegistry();
      registerListSessionsTool(registry, { history });
      registerSearchChatHistoryTool(registry, { history });
      const result = historyPayload(await registry.call(input.tool, input.args));
      guard();
      return result;
    },
  };
}
