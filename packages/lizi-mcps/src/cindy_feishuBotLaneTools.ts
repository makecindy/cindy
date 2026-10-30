/**
 * cindy_feishu_bot 的轮次内直通工具 —— Agent 在飞书 / Lark 轮次里直接驱动 Open API。
 *
 * 作用域不来自模型参数:渠道在 provider 开始这一轮前登记逐轮作用域(当前 chat / 触发者
 * 是不是主人 / 这条连接自己的 transport),终态释放(桌面 `im/shared/channelToolScope.ts`)。
 * 没有活跃作用域的调用一律 fail closed —— 桌面任务、hook 会话、轮次结束后的迟到调用都
 * 调不动任何 chat。个人设置页 bot 与伙伴自有连接共用这组工具,出站永远走触发本轮的那个 bot。
 *
 * 目标的纪律(与 cindy_telegram_bot 同一信任模型):
 *   - 具名发送工具永远发到本轮所在的 chat / 话题(不接受 chat_id 参数);
 *   - 带 message_id 的工具默认指向触发消息;指定别的 message_id 时先确认它就在本 chat
 *     (只有**主人私聊**触发的轮次放开 —— 群轮次即使主人触发也不放开:群历史 / 引用块把成员
 *     可控文本注入主人轮次,注入可借主人身份把内容发到别的群);
 *   - 置顶 / 取消置顶 / 撤回需要主人触发;
 *   - `call_api` 默认把 chat 钉在当前对话;非主人触发只能读取、在本对话里发消息 / 回复 / 表情 /
 *     上传;鉴权、应用管理、租户管理类接口任何人都不开放;
 *   - `send_file` 在非主人触发的轮次只能发当前任务工作目录内的文件(按 realpath 判定,
 *     与 cindy_telegram_bot 的 send_media 同一裁决)。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { FeishuBotLaneScope } from './types.js';

const TEXT_MAX_CHARS = 30_000;
const EMOJI_TYPE_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** 任何人都不能经 Agent 调的接口族:换 token / 用户授权 / 应用与租户管理。 */
const HARD_BLOCKED_PATH_RE = /^open-apis\/(auth|authen|application|admin|tenant|passport|mina|apaas)\b/;

/** 非主人触发的轮次允许的非 GET 接口:在本对话里发消息 / 回复 / 表情,上传图片与文件。 */
const GUEST_WRITE_PATH_RE =
  /^open-apis\/im\/v1\/(messages(\/[^/]+\/(reply|reactions(\/[^/]+)?))?|images|files)$/;

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
};

function result(payload: Record<string, unknown>, isError = false): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true as const } : {}),
  };
}

function noScope(): ToolResult {
  return result(
    {
      ok: false,
      errorCode: 'NO_ACTIVE_FEISHU_SCOPE',
      error: '该工具只在由飞书 / Lark 消息触发、且仍在进行中的轮次里可用。',
    },
    true,
  );
}

function denied(error: string): ToolResult {
  return result({ ok: false, errorCode: 'PERMISSION_DENIED', error }, true);
}

interface ApiErrorLike {
  name?: string;
  code?: number;
  httpStatus?: number;
  apiMsg?: string;
  message?: string;
}

/** Open API 错误原样回给模型(业务码 + msg 足够它自纠);其它异常不泄内部细节。 */
function failure(err: unknown, action: string): ToolResult {
  const e = (err ?? {}) as ApiErrorLike;
  if (e.name === 'FeishuApiError') {
    return result(
      {
        ok: false,
        errorCode: 'FEISHU_API_ERROR',
        action,
        ...(e.code !== undefined ? { code: e.code } : {}),
        ...(e.httpStatus !== undefined ? { http_status: e.httpStatus } : {}),
        msg: e.apiMsg ?? e.message ?? 'unknown',
      },
      true,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/^[A-Z_]+$/.test(message)) {
    return result({ ok: false, errorCode: message, error: message, action }, true);
  }
  return result({ ok: false, errorCode: 'INTERNAL', error: '调用失败, 请稍后重试。', action }, true);
}

function normalizePath(path: string): string {
  return path.trim().replace(/^\/+/, '').split('?')[0];
}

/** 主人私聊轮次可以越出当前对话(与 Telegram call_api 同一裁决)。 */
function mayLeaveChat(scope: FeishuBotLaneScope): boolean {
  return scope.requesterIsOwner && scope.chatKind === 'direct';
}

/**
 * message_id 参数 → 本轮可操作的消息 id。缺省回落触发消息;指定别的 id 时(除主人私聊)
 * 先读一遍确认它就在当前 chat,读不到或不在 → 拒绝。
 */
async function resolveMessageId(
  scope: FeishuBotLaneScope,
  value: string | undefined,
): Promise<{ ok: true; messageId: string } | { ok: false; result: ToolResult }> {
  const messageId = (value ?? '').trim() || scope.triggerMessageId;
  if (!messageId) {
    return { ok: false, result: result({ ok: false, errorCode: 'NO_MESSAGE_ID', error: '本轮没有触发消息 id, 请显式传 message_id。' }, true) };
  }
  if (messageId === scope.triggerMessageId || mayLeaveChat(scope)) return { ok: true, messageId };
  let chatId: unknown;
  try {
    chatId = (await scope.im.getMessage(messageId))?.chat_id;
  } catch (err) {
    return { ok: false, result: failure(err, 'get_message') };
  }
  if (chatId !== scope.chatId) {
    return {
      ok: false,
      result: denied('message_id 不在本轮所在的对话里; 只有主人私聊触发的轮次可以操作别的对话。'),
    };
  }
  return { ok: true, messageId };
}

/** candidate 是 root 本身或在 root 之内(两者都应是 realpath)。 */
function withinDir(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 非主人触发的轮次只能发当前任务工作目录内的文件:两端都取 realpath,工作目录里指向外面的
 * symlink 也拦下。返回校验过的真实路径(出站用它,避免校验后再被换指向),不允许时返回 null。
 */
async function realPathInsideWorkingDir(workingDir: string | undefined, absPath: string): Promise<string | null> {
  if (!workingDir) return null;
  try {
    const [rootReal, fileReal] = await Promise.all([fs.realpath(workingDir), fs.realpath(absPath)]);
    return withinDir(rootReal, fileReal) ? fileReal : null;
  } catch {
    return null;
  }
}

function readString(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * call_api 的目标钉死:除主人私聊轮次外,path / params / data 里出现的 chat_id 都必须是当前
 * chat;消息列表等按 container 选对话的接口,container_id_type 只能是 chat、container_id 必须是
 * 当前 chat(否则可借 `GET messages?container_id=<别的群>` 读别的群历史);`messages` 创建接口
 * 缺 receive_id 时自动补成当前 chat,指定别的 receive_id(含按 open_id 私发给别人)一律拒绝;
 * 带 message_id 的路径按 resolveMessageId 校验归属。
 */
async function pinCallApiTarget(
  scope: FeishuBotLaneScope,
  path: string,
  params: Record<string, unknown>,
  data: unknown,
): Promise<{ ok: true; params: Record<string, unknown>; data: unknown } | { ok: false; result: ToolResult }> {
  if (mayLeaveChat(scope)) return { ok: true, params, data };
  const chatInPath = path.match(/^open-apis\/im\/v1\/chats\/([^/]+)/)?.[1];
  if (chatInPath && chatInPath !== scope.chatId) {
    return { ok: false, result: denied('只能操作本轮所在的对话; 只有主人私聊触发的轮次可以指定别的 chat_id。') };
  }
  for (const source of [params, data]) {
    const chatId = readString(source, 'chat_id');
    if (chatId && chatId !== scope.chatId) {
      return { ok: false, result: denied('chat_id 必须是本轮所在的对话; 只有主人私聊触发的轮次可以指定别的 chat_id。') };
    }
    const containerIdType = readString(source, 'container_id_type');
    const containerId = readString(source, 'container_id');
    if ((containerIdType && containerIdType !== 'chat') || (containerId && containerId !== scope.chatId)) {
      return { ok: false, result: denied('container_id 必须是本轮所在的对话(container_id_type=chat); 只有主人私聊触发的轮次可以读别的对话。') };
    }
  }
  let nextParams = params;
  let nextData = data;
  if (path === 'open-apis/im/v1/messages') {
    const receiveIdType = readString(params, 'receive_id_type');
    const receiveId = readString(data, 'receive_id');
    if ((receiveIdType && receiveIdType !== 'chat_id') || (receiveId && receiveId !== scope.chatId)) {
      return { ok: false, result: denied('发消息只能发到本轮所在的对话(receive_id_type=chat_id, receive_id=当前 chat); 只有主人私聊触发的轮次可以发到别处。') };
    }
    nextParams = { ...params, receive_id_type: 'chat_id' };
    nextData = { ...((data && typeof data === 'object' ? data : {}) as Record<string, unknown>), receive_id: scope.chatId };
  }
  const messageInPath = path.match(/^open-apis\/im\/v1\/(?:messages|pins)\/([^/]+)/)?.[1];
  if (messageInPath) {
    const checked = await resolveMessageId(scope, messageInPath);
    if (!checked.ok) return checked;
  }
  return { ok: true, params: nextParams, data: nextData };
}

export function registerFeishuLaneTools(
  server: McpServer,
  getLaneScope: () => FeishuBotLaneScope | null,
): void {
  const replyArg = z
    .string()
    .trim()
    .max(128)
    .optional()
    .describe('回复哪条消息(message_id, om_ 开头)。缺省直接发到当前对话; 传触发消息 id 即「回复触发我的那条」。');
  const messageIdArg = (purpose: string) =>
    z.string().trim().max(128).optional().describe(`${purpose}的 message_id; 缺省为触发本轮的那条消息。`);

  server.tool(
    'send_text',
    '往当前飞书 / Lark 对话发一条纯文本消息(不渲染 markdown), 或回复其中某条消息。目标由本轮作用域钉死, 不接受 chat_id。',
    {
      text: z.string().min(1).max(TEXT_MAX_CHARS).describe('纯文本正文。'),
      reply_to_message_id: replyArg,
    },
    async ({ text, reply_to_message_id }) => {
      const scope = getLaneScope();
      if (!scope) return noScope();
      if (!text.trim()) return result({ ok: false, errorCode: 'EMPTY_TEXT', error: 'text 为空或纯空白, 不发送' }, true);
      try {
        if (reply_to_message_id) {
          const checked = await resolveMessageId(scope, reply_to_message_id);
          if (!checked.ok) return checked.result;
          const sent = await scope.im.replyText(checked.messageId, text);
          return result({ ok: true, messageId: sent.messageId, replyTo: checked.messageId });
        }
        const sent = await scope.im.sendText(scope.laneUserId, text);
        return result({ ok: true, messageId: sent.messageId });
      } catch (err) {
        return failure(err, 'send_text');
      }
    },
  );

  server.tool(
    'send_markdown',
    '往当前飞书 / Lark 对话发一条 markdown 卡片(**粗体** / `code` / 链接 / 列表 / 引用 / 标题会渲染), 或回复其中某条消息。目标由本轮作用域钉死。',
    {
      markdown: z.string().min(1).max(TEXT_MAX_CHARS).describe('markdown 正文。'),
      reply_to_message_id: replyArg,
    },
    async ({ markdown, reply_to_message_id }) => {
      const scope = getLaneScope();
      if (!scope) return noScope();
      if (!markdown.trim()) return result({ ok: false, errorCode: 'EMPTY_TEXT', error: 'markdown 为空或纯空白, 不发送' }, true);
      try {
        if (reply_to_message_id) {
          const checked = await resolveMessageId(scope, reply_to_message_id);
          if (!checked.ok) return checked.result;
          const sent = await scope.im.replyMarkdownText(checked.messageId, markdown);
          return result({ ok: true, messageId: sent.messageId, replyTo: checked.messageId });
        }
        const sent = await scope.im.sendMarkdownText(scope.laneUserId, markdown);
        return result({ ok: true, messageId: sent.messageId });
      } catch (err) {
        return failure(err, 'send_markdown');
      }
    },
  );

  server.tool(
    'send_file',
    '把本机一个文件(图片按图片消息、其它按文件消息)发到当前飞书 / Lark 对话。目标由本轮作用域钉死; 非主人触发的轮次只能发当前任务工作目录内的文件。',
    {
      path: z.string().min(1).describe('本机文件绝对路径。'),
      display_name: z.string().trim().min(1).max(255).optional().describe('展示文件名; 缺省用原文件名。'),
    },
    async ({ path: absPath, display_name }) => {
      const scope = getLaneScope();
      if (!scope) return noScope();
      if (!path.isAbsolute(absPath)) {
        return result({ ok: false, errorCode: 'PATH_NOT_ABSOLUTE', error: 'path 必须是绝对路径' }, true);
      }
      let sendPath = absPath;
      // 非主人触发的轮次只能发本任务工作目录里的文件: 群成员不能借 bot 把本机任意文件发进群。
      if (!scope.requesterIsOwner) {
        const real = await realPathInsideWorkingDir(scope.workingDir, absPath);
        if (!real) return denied('非主人触发的轮次只能发送当前任务工作目录内的文件。');
        sendPath = real;
      }
      try {
        const sent = await scope.im.sendFile(scope.laneUserId, sendPath, display_name);
        if (!sent.ok) {
          return result({ ok: false, errorCode: sent.reason ?? 'SEND_FAILED', error: sent.reason ?? 'unknown' }, true);
        }
        return result({ ok: true, ...(sent.messageId ? { messageId: sent.messageId } : {}) });
      } catch (err) {
        return failure(err, 'send_file');
      }
    },
  );

  server.tool(
    'set_reaction',
    '给当前对话里的一条消息加表情回应(缺省加在触发本轮的消息上)。返回 reaction_id, 之后可用 remove_reaction 撤掉。',
    {
      emoji_type: z
        .string()
        .regex(EMOJI_TYPE_RE)
        .describe('飞书 emoji_type 枚举(区分大小写), 如 THUMBSUP / DONE / OK / SMILE / HEART / FIRE / PARTY / Typing / OneSecond。'),
      message_id: messageIdArg('要加表情'),
    },
    async ({ emoji_type, message_id }) => {
      const scope = getLaneScope();
      if (!scope) return noScope();
      const checked = await resolveMessageId(scope, message_id);
      if (!checked.ok) return checked.result;
      try {
        const reactionId = await scope.im.reactToMessage(checked.messageId, emoji_type);
        if (!reactionId) {
          return result({ ok: false, errorCode: 'REACTION_FAILED', error: '表情未能加上(bot 可能没有该消息的操作权限)。' }, true);
        }
        return result({ ok: true, messageId: checked.messageId, reactionId });
      } catch (err) {
        return failure(err, 'set_reaction');
      }
    },
  );

  server.tool(
    'remove_reaction',
    '撤掉本 bot 之前加在某条消息上的表情回应(需要 set_reaction 返回的 reaction_id)。',
    {
      message_id: z.string().trim().min(1).max(128).describe('消息 message_id。'),
      reaction_id: z.string().trim().min(1).max(128).describe('set_reaction 返回的 reaction_id。'),
    },
    async ({ message_id, reaction_id }) => {
      const scope = getLaneScope();
      if (!scope) return noScope();
      const checked = await resolveMessageId(scope, message_id);
      if (!checked.ok) return checked.result;
      try {
        await scope.im.removeMessageReaction(checked.messageId, reaction_id);
        return result({ ok: true, messageId: checked.messageId, reactionId: reaction_id });
      } catch (err) {
        return failure(err, 'remove_reaction');
      }
    },
  );

  server.tool(
    'get_chat',
    '读当前飞书 / Lark 对话的信息(群名 / 描述 / 群主 / 人数 / 话题模式等), 可选带一页成员(open_id + 名字)。只读。',
    {
      include_members: z.boolean().optional().describe('是否带一页群成员(最多 100 人)。'),
      members_page_token: z.string().trim().max(256).optional().describe('上一页返回的 nextPageToken, 翻下一页成员。'),
    },
    async ({ include_members, members_page_token }) => {
      const scope = getLaneScope();
      if (!scope) return noScope();
      try {
        const chat = await scope.im.getChatInfo(scope.chatId);
        const members = include_members
          ? await scope.im.listChatMembers(scope.chatId, members_page_token ? { pageToken: members_page_token } : undefined)
          : undefined;
        return result({
          ok: true,
          service: scope.im.getService(),
          chatId: scope.chatId,
          ...(scope.threadId ? { threadId: scope.threadId } : {}),
          chatKind: scope.chatKind,
          requesterIsOwner: scope.requesterIsOwner,
          botAppId: scope.im.getBotAppId(),
          chat,
          ...(members ? { members } : {}),
        });
      } catch (err) {
        return failure(err, 'get_chat');
      }
    },
  );

  server.tool(
    'get_message',
    '读当前对话里一条消息的原始体(类型 / 发送者 / 内容 JSON / 时间 / 所属话题), 缺省读触发本轮的那条。只读。',
    { message_id: messageIdArg('要读') },
    async ({ message_id }) => {
      const scope = getLaneScope();
      if (!scope) return noScope();
      const checked = await resolveMessageId(scope, message_id);
      if (!checked.ok) return checked.result;
      try {
        const message = await scope.im.getMessage(checked.messageId);
        if (!message) return result({ ok: false, errorCode: 'NOT_FOUND', error: '消息不存在或 bot 读不到。' }, true);
        return result({ ok: true, message });
      } catch (err) {
        return failure(err, 'get_message');
      }
    },
  );

  const ownerOnly = (what: string) =>
    denied(`${what}是群管理动作, 需要由主人触发的轮次才能执行。`);

  server.tool(
    'pin_message',
    '把当前对话里的一条消息置顶(缺省置顶触发本轮的消息)。需要主人触发的轮次。',
    { message_id: messageIdArg('要置顶') },
    async ({ message_id }) => {
      const scope = getLaneScope();
      if (!scope) return noScope();
      if (!scope.requesterIsOwner) return ownerOnly('置顶');
      const checked = await resolveMessageId(scope, message_id);
      if (!checked.ok) return checked.result;
      try {
        await scope.im.pinMessage(checked.messageId);
        return result({ ok: true, messageId: checked.messageId });
      } catch (err) {
        return failure(err, 'pin_message');
      }
    },
  );

  server.tool(
    'unpin_message',
    '取消当前对话里一条消息的置顶。需要主人触发的轮次。',
    { message_id: z.string().trim().min(1).max(128).describe('要取消置顶的 message_id。') },
    async ({ message_id }) => {
      const scope = getLaneScope();
      if (!scope) return noScope();
      if (!scope.requesterIsOwner) return ownerOnly('取消置顶');
      const checked = await resolveMessageId(scope, message_id);
      if (!checked.ok) return checked.result;
      try {
        await scope.im.unpinMessage(checked.messageId);
        return result({ ok: true, messageId: checked.messageId });
      } catch (err) {
        return failure(err, 'unpin_message');
      }
    },
  );

  server.tool(
    'recall_message',
    '撤回本 bot 在当前对话里发出的一条消息(飞书只允许撤回 bot 自己发的)。需要主人触发的轮次; 没有缺省目标。',
    { message_id: z.string().trim().min(1).max(128).describe('要撤回的 message_id。') },
    async ({ message_id }) => {
      const scope = getLaneScope();
      if (!scope) return noScope();
      if (!scope.requesterIsOwner) return ownerOnly('撤回');
      const checked = await resolveMessageId(scope, message_id);
      if (!checked.ok) return checked.result;
      try {
        await scope.im.recallMessage(checked.messageId);
        return result({ ok: true, messageId: checked.messageId });
      } catch (err) {
        return failure(err, 'recall_message');
      }
    },
  );

  server.tool(
    'call_api',
    '以当前 bot 身份调任意飞书 / Lark Open API(具名工具没覆盖到的能力, 如 urgent 加急、消息卡片 patch、日历 / 云文档等)。path 形如 /open-apis/im/v1/messages/{id}/urgent_app。目标默认钉在当前对话: 非主人私聊轮次里 chat_id / receive_id 必须是当前 chat(发消息缺省自动补); 非主人触发只能 GET 或在本对话里发消息 / 回复 / 表情 / 上传。',
    {
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).describe('HTTP 方法。'),
      path: z.string().trim().min(1).max(512).describe('接口路径, 以 /open-apis/ 开头。'),
      params: z.record(z.string(), z.unknown()).optional().describe('query 参数。'),
      data: z.unknown().optional().describe('请求体(JSON)。'),
    },
    async ({ method, path, params, data }) => {
      const scope = getLaneScope();
      if (!scope) return noScope();
      const normalized = normalizePath(path);
      if (!normalized.startsWith('open-apis/')) {
        return result({ ok: false, errorCode: 'INVALID_PATH', error: 'path 必须以 /open-apis/ 开头。' }, true);
      }
      if (HARD_BLOCKED_PATH_RE.test(normalized)) {
        return denied('鉴权 / 应用管理 / 租户管理类接口不开放给 Agent。');
      }
      if (!scope.requesterIsOwner && method !== 'GET' && !GUEST_WRITE_PATH_RE.test(normalized)) {
        return denied('非主人触发的轮次只能读取, 或在本对话里发消息 / 回复 / 表情 / 上传。');
      }
      const pinned = await pinCallApiTarget(scope, normalized, params ?? {}, data);
      if (!pinned.ok) return pinned.result;
      try {
        const response = await scope.im.callApi({
          method,
          path: `/${normalized}`,
          ...(Object.keys(pinned.params).length > 0 ? { params: pinned.params } : {}),
          ...(pinned.data !== undefined ? { data: pinned.data } : {}),
        });
        return result({ ok: true, method, path: `/${normalized}`, response });
      } catch (err) {
        return failure(err, `call_api ${method} /${normalized}`);
      }
    },
  );
}
