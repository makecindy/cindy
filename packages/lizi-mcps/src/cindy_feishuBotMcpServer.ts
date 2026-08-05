/**
 * cindy_feishuBotMcpServer.ts
 * ---------------------------------------------------------------------------
 * In-process MCP server for the feishu bot channel. Attached to every session
 * (no source gate) so users can say "跑完通过飞书通知我" from a desktop chat
 * and have the agent push results into the bot DM.
 *
 * 架构对齐 art MCP server:
 *   - 只挂两个入口工具 list_tools / call_tool
 *   - 细粒度工具放 FeishuBotToolRegistry
 *
 * Receiver resolution (single `getChatId` closure injected by the host):
 *   1. feishu-triggered session → `LiveSession.feishuChatId` (reply in the
 *      chat the user is already talking through).
 *   2. otherwise → bot's TOFU-recorded owner (the person who first DM'd this
 *      bot, semantically "the human this bot belongs to").
 *   3. neither → NO_CHAT_CONTEXT (bot has never been DM'd → user must bind
 *      the bot once before agent can push notifications).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jsonObjectArg } from './json-object-arg.js';

import {
  FeishuBotToolRegistry,
  type FeishuBotToolResult,
} from './cindy_feishuBotToolRegistry';
import type { FeishuBotMcpHostDeps } from './types.js';

import descListTools from './prompts/cindy_feishu_bot/tools/list_tools.md?raw';
import descCallTool from './prompts/cindy_feishu_bot/tools/call_tool.md?raw';
import descSendFileToUser from './prompts/cindy_feishu_bot/tools/send_file_to_user.md?raw';
import descSendMessageToUser from './prompts/cindy_feishu_bot/tools/send_message_to_user.md?raw';

const D = {
  list_tools: descListTools.trim(),
  call_tool: descCallTool.trim(),
  send_file_to_user: descSendFileToUser.trim(),
  send_message_to_user: descSendMessageToUser.trim(),
} as const;

type FeishuBotToolDescriptions = { [K in keyof typeof D]: string };

/**
 * Cindy hook 会话里追加到全部工具描述末尾的渠道路由提示(规则 9:通道路由的
 * 确定性用代码保证,不交给模型自由判断)。hook 渠道的文件回传靠最终回复文本里
 * 的 xdt-file 引用(hook outbound 收集器),提示与 hook-control 的 provider-aware
 * prompt note 语义对齐。导出仅供测试锁定文案。
 * (organic SlackIM 渠道及其 lizi_slack_bot 已于 2026-07-17 随老 relay 退役。)
 */
export const SLACK_HOOK_SESSION_CHANNEL_NOTE =
  '\n\n⚠️ 当前是 Slack 会话:文字回复直接输出即可(会自动回贴到当前 Slack thread,无需工具);把文件发给用户是在最终回复文本里写 `[文件名](xdt-file:///绝对路径)`(文件须位于当前工作目录内),图片直接引用其地址 `![说明](cindy-media://… 或 xdt-image://…)`,系统自动作为 Slack 附件发回,不要用本工具;仅当用户明确说「发飞书 / 飞书通知我」时才走飞书通道。';

export const TELEGRAM_HOOK_SESSION_CHANNEL_NOTE =
  '\n\n⚠️ 当前是 Telegram 会话:文字回复直接输出即可(会自动回贴到当前 Telegram 对话或回复链,无需工具);把文件发给用户是在最终回复文本里写 `[文件名](xdt-file:///绝对路径)`(文件须位于当前工作目录内),图片直接引用其地址 `![说明](cindy-media://… 或 xdt-image://…)`,系统自动作为 Telegram 附件发回,不要用本工具;仅当用户明确说「发飞书 / 飞书通知我」时才走飞书通道。';

const NOTE_BY_SOURCE: Record<string, string> = {
  'slack-hook': SLACK_HOOK_SESSION_CHANNEL_NOTE,
  telegram: TELEGRAM_HOOK_SESSION_CHANNEL_NOTE,
};

/** 按会话来源产出工具描述——无对应 note 的来源原样返回 D,保证字节级不变。 */
function buildDescriptions(sessionSource: string | undefined): FeishuBotToolDescriptions {
  // Object.hasOwn 挡原型链键('__proto__' 等),source 虽来自可信 host,防御性收紧
  const note =
    sessionSource !== undefined && Object.hasOwn(NOTE_BY_SOURCE, sessionSource)
      ? NOTE_BY_SOURCE[sessionSource]
      : undefined;
  if (note === undefined) return D;
  return {
    list_tools: D.list_tools + note,
    call_tool: D.call_tool + note,
    send_file_to_user: D.send_file_to_user + note,
    send_message_to_user: D.send_message_to_user + note,
  };
}

/**
 * Character upper bound for message text. Enforced via schema `.max()` so the
 * model sees the limit up-front. Note: z.string().max() counts JS characters
 * (UTF-16 code units), not UTF-8 bytes. Multi-byte characters (e.g. Chinese,
 * emoji) can each consume 3–4 bytes, so 30 000 chars may approach or exceed
 * Feishu's actual byte limit on messages. A future improvement should validate
 * Buffer.byteLength(text, 'utf8') instead of — or in addition to — char count.
 */
const FEISHU_MESSAGE_MAX_CHARS = 30_000;

// ── 共享规则:暂无,留空 map 占位,加新规则时直接塞进来 ────────────────────────
const RULES: Record<string, string> = {};

/**
 * MCP-server-side deps. The MCP layer never touches `getOwnerOpenId` directly
 * — the provider closure (in providers.ts) already collapses "current session
 * chatId or bot owner fallback" into a single `getChatId` result. So this
 * interface omits the host-only accessor and adds the resolved closure.
 */
export type FeishuBotMcpDeps = Omit<FeishuBotMcpHostDeps, 'getOwnerOpenId'> & {
  /**
   * Resolved receiver chatId for the current tool invocation. The provider
   * closure returns feishu-session chatId when present and falls back to
   * `getOwnerOpenId()` otherwise; null means neither path yielded a target
   * (typically: user has never DM'd the bot). Tools translate null into
   * NO_CHAT_CONTEXT with guidance.
   */
  getChatId: () => string | null | undefined;
  /**
   * 会话来源(ctx.vendorOptions.source,session 构建期确定)。Cindy hook 来源给
   * 本 server 全部工具描述追加渠道路由提示——若通道选择交给模型自由判断会
   * 随机把「把文件发给我」路由到飞书;用构建期注入把默认通道钉死在会话自身
   * 渠道上。描述在 session 构建期一次确定、会话内字节稳定,不影响 prompt cache。
   */
  sessionSource?: string;
};

// ── helpers ────────────────────────────────────────────────────────────────

function buildJsonResult(payload: unknown, isError = false): FeishuBotToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function isImageExt(absPath: string): boolean {
  const m = absPath.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return false;
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(m[1]);
}

// ── 细粒度工具:send_file_to_user ───────────────────────────────────────────

function registerSendFileToUser(
  registry: FeishuBotToolRegistry,
  deps: FeishuBotMcpDeps,
  d: FeishuBotToolDescriptions,
): void {
  registry.register({
    name: 'send_file_to_user',
    category: 'bot',
    description: d.send_file_to_user,
    inputShape: {
      absPath: z
        .string()
        .min(1)
        .describe(
          '本地绝对路径(必填)。Windows 反斜杠或正斜杠都行;Unix 必须 / 开头',
        ),
      displayName: z
        .string()
        .optional()
        .describe('发送给用户看到的文件名,默认用 basename(absPath)'),
    },
    handler: async ({ absPath, displayName }) => {
      const chatId = deps.getChatId();
      if (!chatId) {
        return buildJsonResult(
          {
            ok: false,
            errorCode: 'NO_CHAT_CONTEXT',
            error:
              `既没有当前飞书 session 的 chatId,bot 也没有绑定过 owner(用户从未私聊过 bot)。请让用户先在飞书里私聊自己配置的那个机器人一次完成绑定,再重试。`,
          },
          true,
        );
      }

      const result = await deps.sendFile(
        chatId,
        absPath,
        displayName,
      );

      if (!result.ok) {
        const codeMap: Record<string, string> = {
          NOT_FOUND: 'FILE_NOT_FOUND',
          EMPTY: 'FILE_EMPTY',
          TOO_LARGE: 'FILE_TOO_LARGE',
          UPLOAD_FAIL: 'UPLOAD_FAILED',
          SEND_FAIL: 'SEND_FAILED',
        };
        const errorCode = codeMap[result.reason ?? ''] ?? 'SEND_FAILED';
        return buildJsonResult(
          {
            ok: false,
            errorCode,
            error: result.reason ?? 'unknown',
            request: { absPath, displayName },
          },
          true,
        );
      }

      return buildJsonResult({
        ok: true,
        sent: {
          absPath,
          displayName: result.reason ?? displayName,
          kind: isImageExt(absPath) ? 'image' : 'file',
        },
      });
    },
  });
}

// ── 细粒度工具:send_message_to_user ────────────────────────────────────────

function registerSendMessageToUser(
  registry: FeishuBotToolRegistry,
  deps: FeishuBotMcpDeps,
  d: FeishuBotToolDescriptions,
): void {
  registry.register({
    name: 'send_message_to_user',
    category: 'bot',
    description: d.send_message_to_user,
    inputShape: {
      text: z
        .string()
        .min(1)
        .max(FEISHU_MESSAGE_MAX_CHARS)
        .describe(
          `markdown 正文(必填,${FEISHU_MESSAGE_MAX_CHARS} 字符上限)。飞书 lark_md 支持 **bold** / _italic_ / \`code\` / 链接 / 列表 / > 引用 / # 标题。`,
        ),
    },
    handler: async ({ text }) => {
      const chatId = deps.getChatId();
      if (!chatId) {
        return buildJsonResult(
          {
            ok: false,
            errorCode: 'NO_CHAT_CONTEXT',
            error:
              `既没有当前飞书 session 的 chatId,bot 也没有绑定过 owner(用户从未私聊过 bot)。请让用户先在飞书里私聊自己配置的那个机器人一次完成绑定,再重试。`,
          },
          true,
        );
      }

      // Empty-after-trim is a distinct error from schema's z.string().min(1) —
      // a payload like "   \n\n " satisfies min(1) but is semantically empty
      // and feishu would either reject or render blank. Catch it here so the
      // model gets a specific errorCode and doesn't blame the network.
      if (text.trim().length === 0) {
        return buildJsonResult(
          {
            ok: false,
            errorCode: 'EMPTY_TEXT',
            error: 'text 为空或纯空白,不发送',
          },
          true,
        );
      }

      const result = await deps.sendMessage(chatId, text);

      if (!result.ok) {
        const codeMap: Record<string, string> = {
          SEND_FAIL: 'SEND_FAILED',
        };
        const errorCode = codeMap[result.reason ?? ''] ?? 'SEND_FAILED';
        return buildJsonResult(
          {
            ok: false,
            errorCode,
            error: result.reason ?? 'unknown',
          },
          true,
        );
      }

      return buildJsonResult({
        ok: true,
        messageId: result.messageId,
      });
    },
  });
}

// ── Entry tools ────────────────────────────────────────────────────────────

const CATEGORY_ENUM = ['bot'] as const;

function registerListToolsEntry(
  server: McpServer,
  registry: FeishuBotToolRegistry,
  d: FeishuBotToolDescriptions,
): void {
  server.tool(
    'list_tools',
    d.list_tools,
    {
      category: z
        .enum(CATEGORY_ENUM)
        .optional()
        .describe('工具类目。不传时返回所有类目概览。'),
    },
    async ({ category }) => {
      if (category) {
        const tools = registry.list(category);
        const ruleKeys = registry.collectRuleKeys(category);
        const bundledRules: Record<string, string> = {};
        for (const key of ruleKeys) {
          const body = RULES[key];
          if (body) bundledRules[key] = body;
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                category,
                tools: tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  ...(t.rules && t.rules.length > 0 ? { rules: t.rules } : {}),
                })),
                ...(Object.keys(bundledRules).length > 0
                  ? { rules: bundledRules }
                  : {}),
                hint: '调用具体工具用 call_tool({name, args})。每个 tool 的 rules 数组列出它必须遵守的共享规则键,完整规则在顶层 rules 字段。',
              }),
            },
          ],
        };
      }
      const counts: Record<string, number> = {};
      for (const t of registry.list()) {
        counts[t.category] = (counts[t.category] ?? 0) + 1;
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              categories: registry.listCategories().map((c) => ({
                name: c,
                tool_count: counts[c] ?? 0,
              })),
              hint: '用 list_tools({category}) 查看某类目下的工具列表',
            }),
          },
        ],
      };
    },
  );
}

function registerCallToolEntry(
  server: McpServer,
  registry: FeishuBotToolRegistry,
  d: FeishuBotToolDescriptions,
): void {
  server.tool(
    'call_tool',
    d.call_tool,
    {
      name: z
        .string()
        .describe('工具名,从 list_tools 获取(如 send_file_to_user)'),
      args: jsonObjectArg('工具参数(JSON 对象)。不确定 schema 时可先传 {} 触发错误反馈。'),
    },
    async ({ name, args }) => registry.call(name, args),
  );
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createFeishuBotMcpServer(deps: FeishuBotMcpDeps): McpServer {
  const server = new McpServer({
    name: 'cindy_feishu_bot',
    version: '1.0.0',
  });

  const d = buildDescriptions(deps.sessionSource);
  const registry = new FeishuBotToolRegistry();
  registerSendFileToUser(registry, deps, d);
  registerSendMessageToUser(registry, deps, d);

  registerListToolsEntry(server, registry, d);
  registerCallToolEntry(server, registry, d);

  return server;
}
