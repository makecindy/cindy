import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { LiziMcpSessionContext } from '@cindy/mcps';
import {
  readGroupHistoryAccess,
  type GroupHistoryAccessScope,
} from '../im/shared/groupHistoryAccess';
import {
  searchGroupHistory,
  type GroupHistorySearchHit,
  type GroupHistorySearchLane,
} from '../im/shared/groupHistorySearch';

const RESULT_TEXT_MAX_CHARS = 1_500;

type SearchGroupHistory = typeof searchGroupHistory;

export interface GroupHistoryMcpDeps {
  getSessionContext(): LiziMcpSessionContext;
  search?: SearchGroupHistory;
}

const laneSchema = z.object({
  provider: z.string().min(1).optional(),
  chatId: z.string().min(1),
  threadId: z.string().default(''),
});

function result(payload: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true as const } : {}),
  };
}

function sameLane(a: GroupHistorySearchLane, b: GroupHistorySearchLane): boolean {
  return a.provider === b.provider && a.chatId === b.chatId && a.threadId === b.threadId;
}

function resolveTargetLane(
  scope: GroupHistoryAccessScope,
  requested: z.infer<typeof laneSchema> | undefined,
): GroupHistorySearchLane | { errorCode: string; error: string } {
  if (!requested) {
    return (
      scope.lane ?? {
        errorCode: 'NO_CURRENT_LANE',
        error: '当前轮次不属于群聊；请显式提供目标 provider/chatId/threadId。',
      }
    );
  }
  const target = {
    provider: requested.provider ?? scope.provider,
    chatId: requested.chatId,
    threadId: requested.threadId,
  };
  if (scope.lane && sameLane(scope.lane, target)) return target;
  if (scope.access !== 'owner') {
    return {
      errorCode: 'PERMISSION_DENIED',
      error: '当前轮次只能检索所在的 Telegram 群 lane。',
    };
  }
  return target;
}

function presentHit(hit: GroupHistorySearchHit) {
  const text = hit.text.slice(0, RESULT_TEXT_MAX_CHARS);
  return {
    messageId: hit.messageId,
    chatName: hit.chatName,
    author: hit.author,
    isBot: hit.isBot,
    sentAt: hit.sentAt,
    excerpt: hit.snippet,
    text,
    textTruncated: text.length < hit.text.length,
    fileNames: hit.fileNames,
  };
}

export function createGroupHistoryMcpServer(deps: GroupHistoryMcpDeps): McpServer {
  const server = new McpServer({ name: 'cindy_group_history', version: '1.0.0' });

  server.tool(
    'search',
    '检索本机保存的 Telegram 群历史。默认只查当前群/topic；只有主人触发的个人 Telegram 轮次可显式指定其它精确 lane。',
    {
      query: z.string().min(1).max(256),
      limit: z.number().int().min(1).max(20).optional(),
      lane: laneSchema.optional(),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ query, limit, lane }) => {
      const context = deps.getSessionContext();
      const scope = readGroupHistoryAccess({
        sessionId: context.sessionId,
        sessionInstanceId: context.sessionInstanceId,
      });
      if (!scope) {
        return result(
          {
            ok: false,
            errorCode: 'NO_ACTIVE_TELEGRAM_SCOPE',
            error: '该工具只在活跃的 Telegram 群历史授权轮次中可用。',
          },
          true,
        );
      }
      const target = resolveTargetLane(scope, lane);
      if ('errorCode' in target) return result({ ok: false, ...target }, true);
      try {
        const hits = await (deps.search ?? searchGroupHistory)({ lane: target, query, limit });
        return result({
          ok: true,
          lane: target,
          count: hits.length,
          hits: hits.map(presentHit),
        });
      } catch (error) {
        return result(
          {
            ok: false,
            errorCode: 'SEARCH_FAILED',
            error: error instanceof Error ? error.message : String(error),
          },
          true,
        );
      }
    },
  );

  return server;
}
