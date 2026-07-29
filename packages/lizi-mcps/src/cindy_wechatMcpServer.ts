import fs from 'node:fs/promises';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { WechatBotMcpHostDeps } from './types.js';

const MAX_MESSAGE_CHARS = 30_000;
const MAX_DISPLAY_NAME_CHARS = 180;

type WechatMcpDeps = WechatBotMcpHostDeps & {
  getPeerId: () => Promise<string | null> | string | null;
  workingDir?: string;
};

/**
 * In-process MCP bridge for proactive personal WeChat messages.
 *
 * The host resolves the receiver from the current WeChat session or the most
 * recent peer seen by the active binding. The model never supplies an
 * arbitrary peer id. File sends are additionally confined to the session
 * working directory after resolving symlinks.
 */
export function createWechatMcpServer(deps: WechatMcpDeps): McpServer {
  const server = new McpServer({ name: 'cindy_wechat', version: '1.0.0' });

  server.tool(
    'list_tools',
    '列出个人微信可用工具。使用 call_tool 调用具体工具。',
    {},
    async () => ({
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            tools: [
              {
                name: 'send_message_to_user',
                description: '向当前个人微信会话对应的已知联系人发送一条文本消息。',
              },
              {
                name: 'send_file_to_user',
                description:
                  '向当前个人微信联系人发送当前工作目录内不超过 5 MB 的图片或文件。参数：{ absPath: 绝对路径, displayName?: 展示文件名 }。',
              },
            ],
          }),
        },
      ],
    }),
  );

  server.tool(
    'call_tool',
    '调用个人微信工具。先使用 list_tools 获取工具名。',
    {
      name: z.string(),
      args: z.record(z.string(), z.unknown()).default({}),
    },
    async ({ name, args }) => {
      if (name === 'send_message_to_user') return sendMessageToUser(deps, args);
      if (name === 'send_file_to_user') return sendFileToUser(deps, args);
      return result({ ok: false, errorCode: 'UNKNOWN_TOOL', error: name }, true);
    },
  );

  return server;
}

async function sendMessageToUser(deps: WechatMcpDeps, args: Record<string, unknown>) {
  const parsed = z
    .object({ text: z.string().min(1).max(MAX_MESSAGE_CHARS) })
    .safeParse(args);
  if (!parsed.success || parsed.data.text.trim().length === 0) {
    return result({ ok: false, errorCode: 'INVALID_ARGS', error: 'text 不能为空' }, true);
  }
  const peerId = await deps.getPeerId();
  if (!peerId) return noPeerContextResult();
  try {
    const sent = await deps.sendMessage(peerId, parsed.data.text);
    return sent.ok
      ? result({ ok: true, messageId: sent.messageId })
      : result({ ok: false, errorCode: 'SEND_FAILED', error: sent.reason ?? 'unknown' }, true);
  } catch (error) {
    deps.logger?.warn?.(
      'send_message_to_user failed peer=...%s detail=%s',
      peerId.slice(-8),
      error instanceof Error ? error.message : String(error),
    );
    return result({ ok: false, errorCode: 'SEND_FAILED', error: 'WeChat send failed' }, true);
  }
}

async function sendFileToUser(deps: WechatMcpDeps, args: Record<string, unknown>) {
  const parsed = z
    .object({
      absPath: z.string().min(1),
      displayName: z.string().min(1).max(MAX_DISPLAY_NAME_CHARS).optional(),
    })
    .safeParse(args);
  if (!parsed.success) {
    return result({ ok: false, errorCode: 'INVALID_ARGS', error: '文件参数无效' }, true);
  }
  const peerId = await deps.getPeerId();
  if (!peerId) return noPeerContextResult();

  let safePath: string;
  try {
    safePath = await resolveFileWithinWorkingDir(parsed.data.absPath, deps.workingDir);
  } catch (error) {
    const errorCode =
      error instanceof WechatFilePathError
        ? error.code
        : (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'FILE_NOT_FOUND'
          : 'FILE_UNAVAILABLE';
    return result({ ok: false, errorCode, error: '文件不可用于发送' }, true);
  }

  try {
    const sent = await deps.sendFile(peerId, safePath, parsed.data.displayName);
    if (sent.ok) {
      return result({
        ok: true,
        messageId: sent.messageId,
        sent: {
          displayName: parsed.data.displayName ?? path.basename(safePath),
        },
      });
    }
    return result(
      {
        ok: false,
        errorCode: mapFileSendError(sent.reason),
        error: sent.reason ?? 'unknown',
      },
      true,
    );
  } catch (error) {
    deps.logger?.warn?.(
      'send_file_to_user failed peer=...%s detail=%s',
      peerId.slice(-8),
      error instanceof Error ? error.message : String(error),
    );
    return result({ ok: false, errorCode: 'SEND_FAILED', error: 'WeChat send failed' }, true);
  }
}

async function resolveFileWithinWorkingDir(
  candidate: string,
  workingDir: string | undefined,
): Promise<string> {
  if (!workingDir) throw new WechatFilePathError('WORKING_DIR_UNAVAILABLE');
  if (!path.isAbsolute(candidate)) throw new WechatFilePathError('PATH_MUST_BE_ABSOLUTE');
  const [root, file] = await Promise.all([fs.realpath(workingDir), fs.realpath(candidate)]);
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new WechatFilePathError('PATH_OUT_OF_BOUNDS');
  }
  return file;
}

class WechatFilePathError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function mapFileSendError(reason: string | undefined): string {
  return (
    {
      NOT_FOUND: 'FILE_NOT_FOUND',
      EMPTY: 'FILE_EMPTY',
      TOO_LARGE: 'FILE_TOO_LARGE',
      UPLOAD_FAIL: 'UPLOAD_FAILED',
      SEND_FAIL: 'SEND_FAILED',
    }[reason ?? ''] ?? 'SEND_FAILED'
  );
}

function noPeerContextResult() {
  return result(
    {
      ok: false,
      errorCode: 'NO_PEER_CONTEXT',
      error: '当前绑定尚未收到过微信消息，无法确定安全的发送目标。',
    },
    true,
  );
}

function result(payload: unknown, isError = false) {
  return {
    isError,
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}
