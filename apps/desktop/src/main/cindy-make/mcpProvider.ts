import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpProvider, McpProviderContext } from '@cindy/maker-core';
import { resolveLiziMcpSessionContext } from '@cindy/mcps';
import {
  CINDY_MAKE_MCP_SERVER_NAME,
  CINDY_MAKE_REPORT_COMPLETE_TOOL,
  isCindyMakeVendorOptions,
} from '../../shared/cindyMakeSession.js';

export interface CindyMakeMcpDeps {
  /** Registers the completion; the card itself is persisted once the turn ends. */
  reportCompletion: (sessionId: string) => Promise<void>;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

/**
 * Claude binds a per-session context, so the marker alone decides registration.
 * The Codex and Pi bridges build every server once from an empty global context;
 * there the server must stay registered and the per-thread config (Codex) or
 * server list (Pi) hides it, while each call still fails closed on the marker.
 */
export function isCindyMakeServerVisible(ctx: McpProviderContext): boolean {
  if (isCindyMakeVendorOptions(ctx.vendorOptions)) return true;
  return (ctx.agentKind === 'codex' || ctx.agentKind === 'pi') && !ctx.workingDir;
}

function result(payload: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true as const } : {}),
  };
}

/** Text the model sees in the tool schema; it is the only instruction the tool carries. */
export const CINDY_MAKE_REPORT_COMPLETE_DESCRIPTION =
  '在当前 Cindy 个人版制作任务中，用户要求的代码修改已全部完成、并已按仓库 AGENTS.md 的提交前门禁' +
  '（pnpm test:unit:related 与涉及包的 typecheck）通过后调用，然后照常向用户总结改了什么、验证了什么。' +
  '这是向用户报告完成的唯一方式；不调用则用户不会收到完成通知。' +
  '无参数。只在真正完成时调用一次，不要用它汇报进度或提问。';

/**
 * Built-in `cindy_make` server. Phase 1 exposes only `report_complete`: the
 * hand-off point after which Cindy, not the model, owns what happens next.
 */
export function createCindyMakeMcpProvider(deps: CindyMakeMcpDeps): McpProvider {
  return {
    name: CINDY_MAKE_MCP_SERVER_NAME,
    isEnabled: isCindyMakeServerVisible,
    toClaudeSdkConfig: (ctx) => {
      if (!isCindyMakeServerVisible(ctx)) return null;
      const server = new McpServer({ name: CINDY_MAKE_MCP_SERVER_NAME, version: '1.0.0' });
      server.tool(
        CINDY_MAKE_REPORT_COMPLETE_TOOL,
        CINDY_MAKE_REPORT_COMPLETE_DESCRIPTION,
        {},
        { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        async () => {
          // Runtime context beats the factory closure: on the shared bridges the
          // factory context is the anonymous global one.
          const runtime = resolveLiziMcpSessionContext(ctx);
          const sessionId =
            typeof runtime.sessionId === 'string' && runtime.sessionId.trim()
              ? runtime.sessionId.trim()
              : undefined;
          if (!sessionId || !isCindyMakeVendorOptions(runtime.vendorOptions)) {
            return result(
              {
                ok: false,
                errorCode: 'NOT_CINDY_MAKE_TASK',
                error: '该工具只在通过 /cindy-make 创建的个人版制作任务中可用。',
              },
              true,
            );
          }
          try {
            await deps.reportCompletion(sessionId);
          } catch (error) {
            deps.logger.warn('cindy_make completion report failed', {
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
            return result(
              { ok: false, errorCode: 'REPORT_FAILED', error: '完成记录登记失败，请稍后重试。' },
              true,
            );
          }
          deps.logger.info('cindy_make completion reported', { sessionId });
          return result({
            ok: true,
            message:
              '已登记完成。本轮回复结束后 Cindy 会在对话里展示完成卡片；请照常向用户总结改动与验证结果。',
          });
        },
      );
      return { type: 'sdk', name: CINDY_MAKE_MCP_SERVER_NAME, instance: server };
    },
  };
}
