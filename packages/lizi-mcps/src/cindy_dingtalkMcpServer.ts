import fs from 'node:fs/promises';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { DingTalkBotMcpHostDeps } from './types.js';

type DingTalkMcpDeps = DingTalkBotMcpHostDeps & {
  /** 当前会话所在的钉钉单聊 / 群 lane；不是钉钉会话时为 null。 */
  getChatId: () => string | null;
};

/**
 * In-process MCP bridge that lets the agent send a file into the DingTalk
 * conversation the current task belongs to.
 *
 * The receiver is the session's own DingTalk chat (vendorOptions.dingtalkChatId);
 * the model never supplies a target, and outside DingTalk sessions the tool
 * refuses. File locations are not restricted (owner's decision), so the tool is
 * not on the trusted list: every call goes through the session's normal
 * approval / Auto-review path.
 */
export function createDingTalkMcpServer(deps: DingTalkMcpDeps): McpServer {
  const server = new McpServer({ name: 'cindy_dingtalk', version: '1.0.0' });

  server.tool(
    'send_file_to_user',
    '把本机的一个文件（报告、表格、压缩包、图片等）作为文件消息发到当前钉钉单聊或群；大小上限以钉钉为准。' +
      '只能发到当前任务所在的钉钉对话；仅「钉钉账号」连接方式支持。参数 absPath 为文件绝对路径。' +
      '发送后群里所有人都能下载，不要发送密钥、凭证或与请求无关的私人文件。',
    { absPath: z.string().min(1).describe('要发送的文件的绝对路径') },
    async ({ absPath }) => sendFileToUser(deps, absPath),
  );

  return server;
}

async function sendFileToUser(deps: DingTalkMcpDeps, absPath: string) {
  const chatId = deps.getChatId();
  if (!chatId) {
    return result(
      {
        ok: false,
        errorCode: 'NO_CHAT_CONTEXT',
        error: '当前任务不是钉钉对话，无法确定发送目标。',
      },
      true,
    );
  }
  if (!path.isAbsolute(absPath)) {
    return result({ ok: false, errorCode: 'PATH_MUST_BE_ABSOLUTE', error: 'absPath 必须是绝对路径' }, true);
  }

  let file: string;
  try {
    file = await fs.realpath(absPath);
    const stat = await fs.stat(file);
    if (!stat.isFile()) {
      return result({ ok: false, errorCode: 'NOT_A_FILE', error: '只能发送普通文件' }, true);
    }
    if (stat.size === 0) {
      return result({ ok: false, errorCode: 'FILE_EMPTY', error: '文件为空' }, true);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'FILE_NOT_FOUND' : 'FILE_UNAVAILABLE';
    return result({ ok: false, errorCode: code, error: '文件不可用于发送' }, true);
  }

  try {
    const sent = await deps.sendFile(chatId, file);
    if (sent.ok) {
      return result({ ok: true, sent: { fileName: path.basename(file) } });
    }
    return result(
      {
        ok: false,
        errorCode: sent.reason === 'UNSUPPORTED' ? 'UNSUPPORTED_TRANSPORT' : 'SEND_FAILED',
        error:
          sent.reason === 'UNSUPPORTED'
            ? '当前钉钉连接方式（机器人应用）不支持发文件，请改用「钉钉账号」方式。'
            : '发送失败，结果未知：请先确认对话里是否已收到再决定是否重发。',
      },
      true,
    );
  } catch (error) {
    deps.logger?.warn?.(
      'send_file_to_user failed chat=...%s detail=%s',
      chatId.slice(-8),
      error instanceof Error ? error.message : String(error),
    );
    return result(
      {
        ok: false,
        errorCode: 'SEND_FAILED',
        error: '发送失败，结果未知：请先确认对话里是否已收到再决定是否重发。',
      },
      true,
    );
  }
}

function result(payload: unknown, isError = false) {
  return {
    isError,
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}
