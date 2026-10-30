import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';
import type { McpAppRecord } from '../../shared/mcpApps.js';
import type { MakerSendTransaction } from '../maker-ipc/makerSendTransaction.js';
import { AUTO_REVIEW_DELEGATED_CONTINUATION } from '../maker-ipc/autoReviewUserIntent.js';
import { appMessageInput, MCP_APP_MESSAGE_CLIENT_PREFIX, MCP_APP_MESSAGE_GUARD, type McpAppMessageGuard } from './message.js';

interface AppMessageSenderDeps<Meta> {
  owner(): object | null | undefined;
  readClearBoundary(sessionId: string): Promise<number | null | undefined>;
  restoreQueue(sessionId: string): Promise<void>;
  clearBoundary(sessionId: string): number | null;
  shouldQueue(sessionId: string): boolean;
  getSessionMeta(sessionId: string): Promise<Meta | null | undefined>;
  createClientId(): string;
  buildQueueItem(params: {
    targetSessionId: string;
    message: string;
    persistedContent: string;
    clientId: string;
    meta: NonNullable<Meta>;
    sourcePlugin: { pluginId: string; name: string };
    autoReviewUserText: { kind: 'delegated-continuation' };
  }): Promise<AgentInputQueuedMessage>;
  enqueue(sessionId: string, item: AgentInputQueuedMessage): void;
  sendToAgentAccepted: MakerSendTransaction['sendToAgentAccepted'];
}

/** The App's card grant is checked after preparation and at the final send fence. */
export function createAppMessageSender<Meta>(deps: AppMessageSenderDeps<Meta>) {
  return async (
    sessionId: string,
    record: McpAppRecord,
    content: unknown[],
    assertViewCurrent: McpAppMessageGuard,
  ): Promise<void> => {
    const owner = deps.owner();
    const expectedClearBoundaryMs = await deps.readClearBoundary(sessionId);
    await deps.restoreQueue(sessionId);
    const assertInputCurrent = () => {
      if (!owner || owner !== deps.owner() || deps.clearBoundary(sessionId) !== expectedClearBoundaryMs)
        throw new Error('MCP_APP_CARD_UNAVAILABLE');
    };
    const assertDispatchCurrent = async () => {
      assertInputCurrent();
      await assertViewCurrent();
      assertInputCurrent();
    };
    await assertDispatchCurrent();
    const { blocks, text, persistedContent } = appMessageInput(content);
    const sourcePlugin = { pluginId: `mcp-app:${record.serverId}`, name: record.serverId };
    const clientId = `${MCP_APP_MESSAGE_CLIENT_PREFIX}${deps.createClientId()}`;
    if (deps.shouldQueue(sessionId)) {
      const meta = await deps.getSessionMeta(sessionId);
      if (!meta) throw new Error('MCP_APP_SESSION_UNAVAILABLE');
      const item = await deps.buildQueueItem({
        targetSessionId: sessionId, message: text, persistedContent, clientId, meta, sourcePlugin,
        autoReviewUserText: { kind: 'delegated-continuation' },
      });
      await assertDispatchCurrent();
      // The symbol survives Main queue copies but never enters JSON/IPC.
      const guardedItem = { ...item, [MCP_APP_MESSAGE_GUARD]: assertDispatchCurrent };
      deps.enqueue(sessionId, guardedItem);
      return;
    }
    const result = await deps.sendToAgentAccepted(sessionId, { type: 'user', content: blocks }, undefined, {
      sourcePlugin, [AUTO_REVIEW_DELEGATED_CONTINUATION]: true,
      [MCP_APP_MESSAGE_GUARD]: assertDispatchCurrent,
      expectedClearBoundaryMs,
      persistUserMessage: { clientId, content: persistedContent, sourcePlugin, expectedClearBoundaryMs },
    });
    if (result.accepted === false) throw new Error('MCP_APP_MESSAGE_NOT_ACCEPTED');
  };
}
