import fs from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LiziMcpSessionContext } from '@cindy/mcps';
import { readChannelToolScope, type IMessageToolScope } from '../im/shared/channelToolScope';

/** Credentials and webhook administration never enter this tool surface. */
export function createIMessageMcpServer(deps: { getSessionContext(): LiziMcpSessionContext }): McpServer {
  const server = new McpServer({ name: 'cindy_imessage', version: '1.0.0' });
  const result = (value: unknown, isError = false) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}),
  });
  const scoped = async (chatId: string | undefined, run: (scope: IMessageToolScope, target: string) => Promise<unknown>) => {
    const context = deps.getSessionContext();
    const scope = readChannelToolScope(context);
    if (scope?.channel !== 'imessage') return result({ error: 'NO_ACTIVE_IMESSAGE_SCOPE' }, true);
    const target = chatId ?? scope.chatId;
    // Like other IM channels, only an owner DM may address another configured conversation.
    if (target !== scope.chatId && (!scope.requesterIsOwner || scope.chatKind !== 'direct')) {
      return result({ error: 'PERMISSION_DENIED' }, true);
    }
    if (!scope.im.listChats().some(chat => chat.guid === target)) return result({ error: 'CHAT_NOT_CONNECTED' }, true);
    try { return result(await run(scope, target)); }
    catch { return result({ error: 'IMESSAGE_OPERATION_FAILED', message: '操作未确认完成。发送失败时请先查聊天记录，避免重复发送。' }, true); }
  };
  const chat = z.string().max(512).optional().describe('Default: current chat. Another connected chat requires an owner DM turn.');
  server.tool('send_text', 'Send an immediate iMessage through the active local BlueBubbles connection. Normal final answers are sent automatically.',
    { text: z.string().min(1).max(20000), chat_id: chat },
    ({ text, chat_id }) => scoped(chat_id, (scope, target) => scope.im.sendText(target, text)));
  server.tool('send_file', 'Send a local file through the active iMessage connection, up to 64 MiB.',
    { path: z.string().min(1), name: z.string().max(255).optional(), chat_id: chat },
    ({ path: file, name, chat_id }) => scoped(chat_id, async (scope, target) => {
      if (!path.isAbsolute(file)) throw new Error('PATH_NOT_ABSOLUTE');
      const realFile = await fs.realpath(file);
      if (!scope.requesterIsOwner) {
        const workingDir = deps.getSessionContext().workingDir;
        if (!workingDir) throw new Error('WORKING_DIR_REQUIRED');
        const relative = path.relative(await fs.realpath(workingDir), realFile);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('PERMISSION_DENIED');
      }
      return scope.im.sendFile(target, realFile, name);
    }));
  server.tool('history', 'Read one page of iMessage history from a connected conversation. Returns at most 100 messages; advance offset for the next page.',
    { chat_id: chat, after: z.number().int().min(0).default(0), before: z.number().int().min(0).optional(), offset: z.number().int().min(0).default(0) },
    { readOnlyHint: true, destructiveHint: false },
    ({ chat_id, after, before, offset }) => scoped(chat_id, (scope, target) => scope.im.readHistory(target, after, before ?? Date.now(), offset)));
  server.tool('status', 'Read local iMessage connection health and connected chats. Uncertain deliveries require checking history before retrying.', {},
    { readOnlyHint: true, destructiveHint: false },
    () => scoped(undefined, async (scope, target) => ({
      health: scope.im.health(), chats: scope.im.listChats().filter(chat =>
        (scope.requesterIsOwner && scope.chatKind === 'direct') || chat.guid === target),
    })));
  return server;
}
