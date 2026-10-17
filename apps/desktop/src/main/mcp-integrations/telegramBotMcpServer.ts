/**
 * cindy_telegram_bot —— Agent 在 Telegram 轮次里直接驱动 Bot API。
 *
 * 作用域不来自模型参数:渠道在 provider 开始这一轮前登记 `ChannelToolScope`
 * (当前 chat / 触发者是不是主人 / 这条连接自己的 transport), 终态释放
 * (im/shared/channelToolScope.ts)。没有活跃作用域的调用一律 fail closed ——
 * 桌面任务、官方 hook 会话、轮次结束后的迟到调用都调不动任何 chat。
 *
 * 目标 chat 的纪律:
 *   - 具名工具永远发到本轮所在的 chat / topic(不接受 chat_id 参数);
 *   - `call_api` 默认把 chat_id 钉在当前 chat。只有**主人私聊**触发的轮次允许指定别的
 *     chat_id(群轮次即使主人触发也不放开 —— 群窗口 / 引用块把成员可控文本注入主人轮次,
 *     注入可借主人身份把内容发到别的群; 与群历史检索 2026-07-30 的裁决同一信任模型);
 *   - 非主人触发的轮次只能用「只读 + 发消息」这一类方法, 管理动作(踢人 / 禁言 / 改群 /
 *     删消息 / 置顶 / 退群)需要主人触发, 否则 PERMISSION_DENIED;
 *   - 与长轮询抢更新 / 改 webhook / 注销的方法(getUpdates、setWebhook…)任何人都不能调。
 *
 * 出站回流: 经这里发出的消息与 transport 自己发的一样进群窗口, 下一轮群上下文里才看得到
 * "bot 刚才发了什么"。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { LiziMcpSessionContext } from '@cindy/mcps';
import { TELEGRAM_OUTBOUND_MEDIA, TelegramApiError, type TgMessage } from '@cindy/im';

import { createLogger } from '../logger.js';
import {
  readChannelToolScope,
  type TelegramToolScope,
} from '../im/shared/channelToolScope';

const log = createLogger('mcp/cindy_telegram_bot');

export interface TelegramBotMcpDeps {
  getSessionContext(): LiziMcpSessionContext;
}

/** 任何人都不能经 Agent 调的方法: 抢长轮询 / 改 webhook / 注销 bot。 */
const HARD_BLOCKED_METHODS: ReadonlySet<string> = new Set([
  'getUpdates',
  'setWebhook',
  'deleteWebhook',
  'getWebhookInfo',
  'logOut',
  'close',
]);

/**
 * 非主人触发的轮次允许的 call_api 方法前缀: 读信息、发消息、改自己发的消息、应答回调。
 * 其余(ban / restrict / promote / set*Chat* / pin / delete / leaveChat / 论坛话题管理…)需要主人触发。
 */
const GUEST_ALLOWED_METHOD_RE =
  /^(get[A-Z]\w*|send[A-Z]\w*|copyMessages?|forwardMessages?|editMessage\w*|setMessageReaction|answer\w*|stopPoll|stopMessageLiveLocation)$/;

const DOWNLOAD_SUBDIR = 'telegram-downloads';
const MESSAGE_TEXT_MAX_CHARS = 4096;
const CAPTION_MAX_CHARS = 1024;
const POLL_QUESTION_MAX_CHARS = 300;
const POLL_OPTION_MAX_CHARS = 100;
const ECHO_TEXT_MAX_CHARS = 2_000;

function result(payload: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true as const } : {}),
  };
}

function noScope() {
  return result(
    {
      ok: false,
      errorCode: 'NO_ACTIVE_TELEGRAM_SCOPE',
      error: '该工具只在由 Telegram 消息触发、且仍在进行中的轮次里可用。',
    },
    true,
  );
}

function denied(error: string) {
  return result({ ok: false, errorCode: 'PERMISSION_DENIED', error }, true);
}

/** Bot API 错误原样回给模型(error_code + description 足够它自纠); 其它异常不泄内部细节。 */
function failure(err: unknown, method: string) {
  if (err instanceof TelegramApiError) {
    return result(
      {
        ok: false,
        errorCode: 'TELEGRAM_API_ERROR',
        method,
        error_code: err.errorCode,
        description: err.message,
        ...(err.retryAfterSec !== undefined ? { retry_after: err.retryAfterSec } : {}),
      },
      true,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  // transport 的 sendMedia / downloadFile 用短码表达可预期失败(NOT_FOUND / TOO_LARGE …)。
  if (/^[A-Z_]+(:\d+)?$/.test(message)) {
    return result({ ok: false, errorCode: message.split(':')[0], error: message, method }, true);
  }
  log.warn(`cindy_telegram_bot ${method} failed: ${message}`);
  return result({ ok: false, errorCode: 'INTERNAL', error: '调用失败, 请稍后重试。', method }, true);
}

function isTgMessage(value: unknown): value is TgMessage {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as TgMessage).message_id === 'number' &&
    !!(value as TgMessage).chat &&
    typeof (value as TgMessage).chat.id === 'number'
  );
}

/** 消息 id 参数: 原生数字 id 或渠道编码 `chatId|msgId`; 都解不出 → null。 */
function nativeMessageId(value: string | undefined, fallback: string): number | null {
  const raw = (value ?? '').trim() || fallback;
  if (!raw) return null;
  const native = raw.includes('|') ? raw.split('|')[1] : raw;
  return /^\d+$/.test(native) ? Number(native) : null;
}

function echoOutbound(scope: TelegramToolScope, text: string, sent: unknown, fileNames?: string[]): void {
  if (!isTgMessage(sent)) return;
  try {
    scope.im.recordOutboundEcho(scope.laneUserId, text.slice(0, ECHO_TEXT_MAX_CHARS), sent, fileNames);
  } catch (err) {
    log.warn(`outbound echo failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function sentPayload(scope: TelegramToolScope, sent: unknown) {
  if (!isTgMessage(sent)) return { ok: true, result: sent };
  return {
    ok: true,
    messageId: `${sent.chat.id}|${sent.message_id}`,
    message_id: sent.message_id,
    chat_id: String(sent.chat.id),
    ...(scope.threadId ? { message_thread_id: Number(scope.threadId) } : {}),
  };
}

function replyParams(scope: TelegramToolScope, replyTo: string | undefined) {
  const id = replyTo === undefined ? null : nativeMessageId(replyTo, '');
  if (replyTo !== undefined && id === null) return 'INVALID';
  return id === null ? {} : { reply_parameters: { message_id: id, allow_sending_without_reply: true } };
}

function withinDir(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** workingDir 与 candidate 都取 realpath 后判定包含关系; 任一端解析失败或越界返回 null。 */
async function realPathWithinDir(workingDir: string | undefined, candidate: string): Promise<string | null> {
  if (!workingDir) return null;
  try {
    const [rootReal, fileReal] = await Promise.all([fs.realpath(workingDir), fs.realpath(candidate)]);
    return withinDir(rootReal, fileReal) ? fileReal : null;
  } catch {
    return null;
  }
}

/** 群 / 私聊两种 chat 的只读信息(管理员列表只在群里有)。 */
async function describeChat(scope: TelegramToolScope) {
  const api = scope.im.getBotApi();
  if (!api) throw new Error('NOT_CONNECTED');
  const chat = await api.call<Record<string, unknown>>('getChat', { chat_id: scope.chatId });
  const payload: Record<string, unknown> = {
    ok: true,
    chat,
    bot: { id: scope.im.getBotId(), username: scope.im.getBotUsername() },
    ...(scope.threadId ? { message_thread_id: Number(scope.threadId) } : {}),
  };
  if (scope.chatKind === 'group') {
    const [count, admins] = await Promise.allSettled([
      api.call<number>('getChatMemberCount', { chat_id: scope.chatId }),
      api.call<Array<{ status: string; user: { id: number; first_name: string; username?: string; is_bot: boolean } }>>(
        'getChatAdministrators',
        { chat_id: scope.chatId },
      ),
    ]);
    if (count.status === 'fulfilled') payload.member_count = count.value;
    if (admins.status === 'fulfilled') {
      payload.administrators = admins.value.map((a) => ({
        status: a.status,
        id: a.user.id,
        name: a.user.first_name,
        ...(a.user.username ? { username: a.user.username } : {}),
        is_bot: a.user.is_bot,
      }));
    }
  }
  return payload;
}

export function createTelegramBotMcpServer(deps: TelegramBotMcpDeps): McpServer {
  const server = new McpServer({ name: 'cindy_telegram_bot', version: '1.0.0' });

  const scopeOf = (): TelegramToolScope | null => {
    const ctx = deps.getSessionContext();
    const scope = readChannelToolScope({
      sessionId: ctx.sessionId,
      sessionInstanceId: ctx.sessionInstanceId,
    });
    return scope?.channel === 'telegram' ? scope : null;
  };

  const apiOf = (scope: TelegramToolScope) => {
    const api = scope.im.getBotApi();
    if (!api) throw new Error('NOT_CONNECTED');
    return api;
  };

  server.tool(
    'send_text',
    '立刻往当前 Telegram 对话发一条文字消息(正常回答直接输出即可, 会自动回到对话; 这个工具用于回答之外的即时消息、或要带 HTML 格式 / 指定回复对象时)。',
    {
      text: z.string().min(1).max(MESSAGE_TEXT_MAX_CHARS).describe('消息正文; 默认纯文本'),
      parse_mode: z
        .enum(['HTML', 'MarkdownV2'])
        .optional()
        .describe('格式化模式; 不传为纯文本。HTML 支持 <b> <i> <code> <pre> <a href>; 格式错误 Telegram 会拒收'),
      reply_to_message_id: z
        .string()
        .optional()
        .describe('回复哪条消息(message_id); 不传则不作为回复'),
      disable_notification: z.boolean().optional(),
    },
    async ({ text, parse_mode, reply_to_message_id, disable_notification }) => {
      const scope = scopeOf();
      if (!scope) return noScope();
      const reply = replyParams(scope, reply_to_message_id);
      if (reply === 'INVALID') return result({ ok: false, errorCode: 'INVALID_MESSAGE_ID' }, true);
      try {
        const sent = await apiOf(scope).call<TgMessage>('sendMessage', {
          ...scope.im.resolveSendTarget(scope.laneUserId),
          text,
          ...(parse_mode ? { parse_mode } : {}),
          ...(disable_notification ? { disable_notification: true } : {}),
          ...reply,
        });
        echoOutbound(scope, text, sent);
        return result(sentPayload(scope, sent));
      } catch (err) {
        return failure(err, 'sendMessage');
      }
    },
  );

  server.tool(
    'send_media',
    '往当前 Telegram 对话发一条媒体消息: 图片 / 文件 / 视频 / 音频 / 语音 / 动图 / 贴纸 / 圆形视频。来源三选一: 本地绝对路径(上传, 50 MB 内)、公网 URL、或 Telegram file_id(转发已有文件)。',
    {
      kind: z.enum(Object.keys(TELEGRAM_OUTBOUND_MEDIA) as [string, ...string[]]).describe(
        'photo | document | video | audio | voice | animation | sticker | video_note',
      ),
      path: z.string().optional().describe('本地文件绝对路径'),
      url: z.string().url().optional().describe('公网 URL(Telegram 服务器直接拉取)'),
      file_id: z.string().optional().describe('Telegram file_id(对方发过的文件可直接转发)'),
      caption: z.string().max(CAPTION_MAX_CHARS).optional().describe('说明文字(贴纸 / 圆形视频不支持)'),
      reply_to_message_id: z.string().optional(),
    },
    async ({ kind, path: absPath, url, file_id, caption, reply_to_message_id }) => {
      const scope = scopeOf();
      if (!scope) return noScope();
      if (reply_to_message_id !== undefined && nativeMessageId(reply_to_message_id, '') === null) {
        return result({ ok: false, errorCode: 'INVALID_MESSAGE_ID' }, true);
      }
      let uploadPath = absPath;
      if (absPath) {
        if (!path.isAbsolute(absPath)) {
          return result({ ok: false, errorCode: 'PATH_NOT_ABSOLUTE', error: 'path 必须是绝对路径' }, true);
        }
        // 非主人触发的轮次只能发本任务工作目录里的文件: 群成员不能借 bot 把本机任意文件发进群。
        // 两端都按 realpath 判定(工作目录里指向外面的 symlink 也拦), 出站用校验过的真实路径。
        if (!scope.requesterIsOwner) {
          const real = await realPathWithinDir(deps.getSessionContext().workingDir, absPath);
          if (!real) return denied('非主人触发的轮次只能发送当前任务工作目录内的文件。');
          uploadPath = real;
        }
      }
      try {
        const sent = await scope.im.sendMedia(scope.laneUserId, {
          kind: kind as keyof typeof TELEGRAM_OUTBOUND_MEDIA,
          ...(uploadPath ? { absPath: uploadPath } : {}),
          ...(url ? { url } : {}),
          ...(file_id ? { fileId: file_id } : {}),
          ...(caption ? { caption } : {}),
          ...(reply_to_message_id ? { replyToMessageId: reply_to_message_id } : {}),
        });
        return result({ ok: true, messageId: sent.messageId, kind, ...(absPath ? { file: path.basename(absPath) } : {}) });
      } catch (err) {
        return failure(err, TELEGRAM_OUTBOUND_MEDIA[kind as keyof typeof TELEGRAM_OUTBOUND_MEDIA]?.method ?? 'sendMedia');
      }
    },
  );

  server.tool(
    'send_poll',
    '在当前 Telegram 对话发起投票(2–10 个选项); type=quiz 时需给 correct_option_id。',
    {
      question: z.string().min(1).max(POLL_QUESTION_MAX_CHARS),
      options: z.array(z.string().min(1).max(POLL_OPTION_MAX_CHARS)).min(2).max(10),
      is_anonymous: z.boolean().optional().describe('默认 true(匿名)'),
      allows_multiple_answers: z.boolean().optional(),
      type: z.enum(['regular', 'quiz']).optional(),
      correct_option_id: z.number().int().min(0).max(9).optional().describe('quiz 的正确选项下标'),
      reply_to_message_id: z.string().optional(),
    },
    async ({ question, options, is_anonymous, allows_multiple_answers, type, correct_option_id, reply_to_message_id }) => {
      const scope = scopeOf();
      if (!scope) return noScope();
      const reply = replyParams(scope, reply_to_message_id);
      if (reply === 'INVALID') return result({ ok: false, errorCode: 'INVALID_MESSAGE_ID' }, true);
      if (type === 'quiz' && correct_option_id === undefined) {
        return result({ ok: false, errorCode: 'INVALID_PARAMS', error: 'quiz 必须给 correct_option_id' }, true);
      }
      try {
        const sent = await apiOf(scope).call<TgMessage>('sendPoll', {
          ...scope.im.resolveSendTarget(scope.laneUserId),
          question,
          options: options.map((text) => ({ text })),
          ...(is_anonymous !== undefined ? { is_anonymous } : {}),
          ...(allows_multiple_answers !== undefined ? { allows_multiple_answers } : {}),
          ...(type ? { type } : {}),
          ...(correct_option_id !== undefined ? { correct_option_id } : {}),
          ...reply,
        });
        echoOutbound(scope, `[投票] ${question}\n${options.map((o) => `• ${o}`).join('\n')}`, sent);
        return result(sentPayload(scope, sent));
      } catch (err) {
        return failure(err, 'sendPoll');
      }
    },
  );

  server.tool(
    'set_reaction',
    '给当前对话里的某条消息加 / 换 / 撤表情反应(emoji 为空即撤掉)。默认目标是触发本轮的那条消息。',
    {
      emoji: z.string().max(16).optional().describe('单个 emoji, 如 👍 ❤️ 🔥; 空或不传 = 撤掉反应'),
      message_id: z.string().optional().describe('默认 = 触发本轮的消息'),
      is_big: z.boolean().optional(),
    },
    async ({ emoji, message_id, is_big }) => {
      const scope = scopeOf();
      if (!scope) return noScope();
      const target = nativeMessageId(message_id, scope.triggerMessageId);
      if (target === null) return result({ ok: false, errorCode: 'INVALID_MESSAGE_ID' }, true);
      const value = emoji?.trim() ?? '';
      try {
        await apiOf(scope).call('setMessageReaction', {
          chat_id: scope.chatId,
          message_id: target,
          reaction: value ? [{ type: 'emoji', emoji: value }] : [],
          ...(is_big ? { is_big: true } : {}),
        });
        return result({ ok: true, message_id: target, emoji: value || null });
      } catch (err) {
        return failure(err, 'setMessageReaction');
      }
    },
  );

  server.tool(
    'download_file',
    '按 file_id 把对方发来的文件(图片 / 文档 / 语音 / 视频…)下载到当前任务目录的 telegram-downloads/ 下, 返回本地绝对路径。Bot API 限 20 MB。',
    {
      file_id: z.string().min(1),
      file_name: z.string().max(180).optional().describe('落盘文件名(默认取 Telegram 的文件名)'),
    },
    async ({ file_id, file_name }) => {
      const scope = scopeOf();
      if (!scope) return noScope();
      const workingDir = deps.getSessionContext().workingDir;
      if (!workingDir) return result({ ok: false, errorCode: 'NO_WORKING_DIR' }, true);
      try {
        const saved = await scope.im.downloadFile(file_id, path.join(workingDir, DOWNLOAD_SUBDIR), file_name);
        return result({ ok: true, absPath: saved.absPath, fileName: saved.fileName, size: saved.size });
      } catch (err) {
        return failure(err, 'getFile');
      }
    },
  );

  server.tool(
    'get_chat',
    '读取当前 Telegram 对话的信息: 群名 / 类型 / 简介 / 成员数 / 管理员(群), 以及本 bot 的 id 与用户名。',
    {},
    { readOnlyHint: true, destructiveHint: false },
    async () => {
      const scope = scopeOf();
      if (!scope) return noScope();
      try {
        return result(await describeChat(scope));
      } catch (err) {
        return failure(err, 'getChat');
      }
    },
  );

  server.tool(
    'pin_message',
    '在当前群置顶 / 取消置顶一条消息(需要 bot 有置顶权限; 只有主人触发的轮次可用)。',
    {
      message_id: z.string().optional().describe('默认 = 触发本轮的消息'),
      unpin: z.boolean().optional().describe('true = 取消置顶'),
      disable_notification: z.boolean().optional(),
    },
    async ({ message_id, unpin, disable_notification }) => {
      const scope = scopeOf();
      if (!scope) return noScope();
      if (!scope.requesterIsOwner) return denied('置顶 / 取消置顶需要主人触发的轮次。');
      const target = nativeMessageId(message_id, scope.triggerMessageId);
      if (target === null) return result({ ok: false, errorCode: 'INVALID_MESSAGE_ID' }, true);
      const method = unpin ? 'unpinChatMessage' : 'pinChatMessage';
      try {
        await apiOf(scope).call(method, {
          chat_id: scope.chatId,
          message_id: target,
          ...(!unpin && disable_notification ? { disable_notification: true } : {}),
        });
        return result({ ok: true, message_id: target, pinned: !unpin });
      } catch (err) {
        return failure(err, method);
      }
    },
  );

  server.tool(
    'delete_message',
    '删除当前对话里的一条消息(bot 自己发的, 或群里有删消息权限时别人发的; 只有主人触发的轮次可用)。',
    {
      message_id: z.string().min(1),
    },
    async ({ message_id }) => {
      const scope = scopeOf();
      if (!scope) return noScope();
      if (!scope.requesterIsOwner) return denied('删除消息需要主人触发的轮次。');
      const target = nativeMessageId(message_id, '');
      if (target === null) return result({ ok: false, errorCode: 'INVALID_MESSAGE_ID' }, true);
      try {
        await apiOf(scope).call('deleteMessage', { chat_id: scope.chatId, message_id: target });
        return result({ ok: true, message_id: target, deleted: true });
      } catch (err) {
        return failure(err, 'deleteMessage');
      }
    },
  );

  server.tool(
    'call_api',
    '直接调用任意 Telegram Bot API 方法(https://core.telegram.org/bots/api), 具名工具没覆盖的都走这里: sendLocation / sendContact / sendDice / sendChatAction / editMessageText / forwardMessage / getChatMember / createForumTopic / banChatMember / setChatTitle …。params 里不传 chat_id 时默认当前对话; 群轮次只能操作当前群; 非主人触发只允许读取与发送类方法。',
    {
      method: z.string().regex(/^[a-zA-Z]{2,64}$/).describe('Bot API 方法名, 如 sendLocation'),
      params: z.record(z.string(), z.unknown()).optional().describe('方法参数(JSON 对象), 与 Bot API 文档同名'),
    },
    async ({ method, params }) => {
      const scope = scopeOf();
      if (!scope) return noScope();
      if (HARD_BLOCKED_METHODS.has(method)) {
        return denied(`${method} 会干扰 bot 自身的连接, 不开放。`);
      }
      if (!scope.requesterIsOwner && !GUEST_ALLOWED_METHOD_RE.test(method)) {
        return denied(`${method} 属于管理类动作, 需要主人触发的轮次。`);
      }
      const input: Record<string, unknown> = { ...(params ?? {}) };
      const ownerDm = scope.requesterIsOwner && scope.chatKind === 'direct';
      for (const key of ['chat_id', 'from_chat_id'] as const) {
        const given = input[key];
        if (given === undefined) continue;
        if (String(given) !== scope.chatId && !ownerDm) {
          return denied(`${key} 只能是当前对话(${scope.chatId}); 要操作别的 chat 请在私聊里让主人发起。`);
        }
      }
      // 不带 chat_id 的方法默认落在当前对话; topic id 只补给发送类方法(其它方法不认这个参数)。
      if (input.chat_id === undefined && method !== 'getMe' && !/^(get|set|delete)My[A-Z]/.test(method)) {
        const target = scope.im.resolveSendTarget(scope.laneUserId);
        input.chat_id = target.chat_id;
        if (target.message_thread_id !== undefined && /^(send|copy|forward)[A-Z]/.test(method)) {
          input.message_thread_id = target.message_thread_id;
        }
      }
      try {
        const api = apiOf(scope);
        const value = await api.call<unknown>(method, input);
        if (/^(send|copy|forward)[A-Z]/.test(method) && String(input.chat_id) === scope.chatId) {
          const text = typeof input.text === 'string' ? input.text : typeof input.caption === 'string' ? input.caption : `[${method}]`;
          if (Array.isArray(value)) {
            for (const item of value) echoOutbound(scope, text, item);
          } else {
            echoOutbound(scope, text, value);
          }
        }
        return result({ ok: true, method, result: value });
      } catch (err) {
        return failure(err, method);
      }
    },
  );

  return server;
}

/** 测试用: 下载目录名(与 download_file 同源)。 */
export const TELEGRAM_DOWNLOAD_SUBDIR = DOWNLOAD_SUBDIR;

