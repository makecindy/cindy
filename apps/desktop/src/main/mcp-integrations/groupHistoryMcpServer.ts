import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { LiziMcpSessionContext } from '@cindy/mcps';
import { createLogger } from '../logger.js';
import {
  readGroupHistoryAccess,
  type GroupHistoryAccessScope,
} from '../im/shared/groupHistoryAccess';
import {
  searchGroupHistory,
  type GroupHistorySearchHit,
  type GroupHistorySearchLane,
} from '../im/shared/groupHistorySearch';

const log = createLogger('mcp/cindy_group_history');

const RESULT_TEXT_MAX_CHARS = 1_500;
/**
 * 单次调用的正文总预算 — 对齐群窗口注入的 4000 字预算(groupWindow.ts):
 * 检索工具不能成为绕过该闸的通道。超出预算的命中只回 snippet。
 */
const RESULT_TOTAL_TEXT_BUDGET = 4_000;
const PERSONAL_TELEGRAM_PROVIDER_PREFIX = 'telegram-personal:';

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

/**
 * Owner 的跨 lane 能力只覆盖个人 Telegram bot 命名空间。
 * 这里是工具边界的最后一道校验，不能让模型参数把租约扩成官方群或未来 provider。
 */
function isPersonalTelegramProvider(provider: string): boolean {
  const botId = provider.slice(PERSONAL_TELEGRAM_PROVIDER_PREFIX.length);
  return provider.startsWith(PERSONAL_TELEGRAM_PROVIDER_PREFIX) && botId.length > 0;
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
  if (!isPersonalTelegramProvider(target.provider)) {
    return {
      errorCode: 'PERMISSION_DENIED',
      error: '主人轮次只能检索个人 Telegram bot 的精确 lane。',
    };
  }
  return target;
}

function presentHits(hits: GroupHistorySearchHit[]) {
  let budget = RESULT_TOTAL_TEXT_BUDGET;
  return hits.map((hit) => {
    const text = hit.text.slice(0, Math.max(0, Math.min(RESULT_TEXT_MAX_CHARS, budget)));
    budget -= text.length;
    return {
      messageId: hit.messageId,
      chatName: hit.chatName,
      author: hit.author,
      isBot: hit.isBot,
      sentAt: hit.sentAt,
      excerpt: hit.snippet,
      // 预算耗尽后正文降级为空串, snippet 仍在 — 命中列表完整、正文受闸。
      text,
      textTruncated: text.length < hit.text.length,
      fileNames: hit.fileNames,
    };
  });
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
          hits: presentHits(hits),
        });
      } catch (error) {
        // 底层异常消息可能带 SQL 片段/表名/DB 路径, 不回传给模型 context;
        // 细节只进本地日志(对齐 groupHistorySearch 的 errorKind 纪律)。
        log.warn(
          `cindy_group_history search failed (${error instanceof Error ? error.name : 'unknown'})`,
        );
        return result(
          {
            ok: false,
            errorCode: 'SEARCH_FAILED',
            error: '检索执行失败，请稍后重试。',
          },
          true,
        );
      }
    },
  );

  return server;
}
