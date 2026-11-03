import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';

/** Main-only card authorization; neither the View nor persisted queue can mint it. */
export const MCP_APP_MESSAGE_GUARD = Symbol('MCP_APP_MESSAGE_GUARD');
export type McpAppMessageGuard = () => Promise<void>;
export const MCP_APP_MESSAGE_CLIENT_PREFIX = 'mcp-app-message:';

type McpAppQueuedMessage = {
  clientId: string;
  sourcePlugin?: { pluginId: string };
  readonly [MCP_APP_MESSAGE_GUARD]?: McpAppMessageGuard;
};

/** A crash-restored App row has no live View grant and cannot be retried. */
export function isUnrestorableMcpAppMessage(item: McpAppQueuedMessage): boolean {
  // Pre-prefix App rows can exist after upgrading. Provenance can deny a stale
  // row, but only the Main-owned Symbol above can supply a live authorization.
  return !item[MCP_APP_MESSAGE_GUARD] &&
    (item.clientId.startsWith(MCP_APP_MESSAGE_CLIENT_PREFIX) ||
      item.sourcePlugin?.pluginId.startsWith('mcp-app:') === true);
}

/** JSON/restored queue rows cannot recreate a live View grant. Fail closed. */
export function queuedAppMessageGuard(item: McpAppQueuedMessage): McpAppMessageGuard | undefined {
  if (item[MCP_APP_MESSAGE_GUARD]) return item[MCP_APP_MESSAGE_GUARD];
  if (!isUnrestorableMcpAppMessage(item)) return undefined;
  return async () => { throw new Error('MCP_APP_CARD_UNAVAILABLE'); };
}

/** Convert protocol content into the existing, attachment-aware Cindy user input. */
export function appMessageBlocks(
  content: unknown[],
): Array<{ type: string; [key: string]: unknown }> {
  return (content as ContentBlock[]).map((block) => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text };
      case 'resource_link':
        return { type: 'text', text: `${block.name}: ${block.uri}` };
      case 'resource':
        if ('text' in block.resource) return { type: 'text', text: block.resource.text };
        throw new Error('MCP_APP_MESSAGE_CONTENT_UNSUPPORTED');
      default:
        throw new Error('MCP_APP_MESSAGE_CONTENT_UNSUPPORTED');
    }
  });
}

/** Keep the authored body for history, but escape native commands in model input. */
export function appMessageInput(content: unknown[]) {
  const authored = appMessageBlocks(content);
  const persistedContent = authored.map((block) => String(block.text)).join('\n');
  const blocks = authored.map((block) => ({
    ...block,
    text: String(block.text).replace(/^(\s*)\//, '$1\\/'),
  }));
  return { blocks, text: blocks.map((block) => block.text).join('\n'), persistedContent };
}
