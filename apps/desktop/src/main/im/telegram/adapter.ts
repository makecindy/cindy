/**
 * main/im/telegram/adapter.ts
 * ---------------------------------------------------------------------------
 * 个人 Telegram bot 的 ImChannelAdapter — DM + 群 lane 双形态, 不启用
 * threadScoped(群路由靠 lane 合成 userId, 见 @cindy/im telegram/codec.ts):
 *   - DM: userId = Telegram 数字 user id, 每 (bot, owner) 一个长期会话;
 *   - 群/topic: userId = `g/{chatId}[/{threadId}]`, 每 lane 一个长期会话,
 *     与官方 bot 的 telegram:group/topic externalKey 语义对齐。
 *
 * 两个渠道级差异化钩子(官方通道行为的移植):
 *   - answerOnlyProgress(DM): Telegram 客户端把可编辑消息渲染成 Rich draft
 *     动画, 过程时间线反复重排会清空重播(#848) → DM 中间态只发正文;
 *   - prepareAgentTurnText(群): 触发消息送模型前拼本地群上下文前缀(#843),
 *     游标在消息被路由受理后 commit。
 */

import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';
import type { TelegramIM } from '@cindy/im';
import {
  decodeTelegramLaneUserId,
  decodeTelegramMessageId,
} from '@cindy/im';

import type { ImChannelAdapter, ImOrchestratorConfig } from '../shared/types';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage';
import { buildTelegramGroupContextPrefix, buildTelegramReplyContextBlock } from './groupWindow';
import { ui, PROCESSING_EMOJI } from './uiText';

function ensureWorkingDir(botId: string): string {
  const dir = ownerScopedImUserDataPath('im-working-dir', `telegram-${botId}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** lane userId 含 `/`, 会话 id 与文件系统场景统一替换成 `-`。 */
function sessionSafeUserId(userId: string): string {
  return userId.replace(/\//g, '-');
}

export function buildTelegramAdapter(
  telegramIm: TelegramIM,
  config: ImOrchestratorConfig,
): ImChannelAdapter {
  return {
    channel: 'telegram',
    im: telegramIm,
    output: { kind: 'rich-card', im: telegramIm },
    config,
    ui,
    sessions: {
      source: 'telegram',
      sessionIdFor: (botId, userId) => `telegram_${botId}_${sessionSafeUserId(userId)}`,
      defaultTitle: (userId) =>
        decodeTelegramLaneUserId(userId)
          ? `[TG·群] ${userId.slice(-6)}`
          : `[TG·DM] ${userId.slice(-6)}`,
      generatedTitlePrefix: 'TG · ',
      // 私聊与群 lane 的工作目录都是 app 托管目录, 不该聚成假项目组。
      workspaceKind: 'dialogue',
      ensureWorkingDir,
      extraInsertColumns: (botId, userId) => ({
        imBotContextId: botId,
        imUserId: userId,
      }),
    },
    processingEmoji: PROCESSING_EMOJI,
    // /project: 从 Telegram 把当前会话切到 desktop 项目目录(bot 原生会话)。
    projectSwitching: true,
    buildVendorOptions: (userId) => ({ telegramChatId: userId, source: 'telegram' }),
    answerOnlyProgress: (userId) => decodeTelegramLaneUserId(userId) === null,
    prepareAgentTurnText: async (event) => {
      const lane = decodeTelegramLaneUserId(event.senderId);
      const replyBlock = event.replyContext
        ? buildTelegramReplyContextBlock(event.replyContext)
        : '';
      if (!lane) {
        // DM: 无群窗口, 但引用注入(回复某条消息触发)同样生效。
        if (!replyBlock) return null;
        return { agentText: `${replyBlock}${event.text}` };
      }
      const { messageId: triggerMessageId } = decodeTelegramMessageId(event.messageId);
      const assembly = await buildTelegramGroupContextPrefix({
        botId: event.contextId,
        chatId: lane.chatId,
        threadId: lane.threadId,
        triggerMessageId,
      });
      // 顺序: 群窗口(较远的背景) → 引用块(直接相关) → 用户正文。
      return {
        agentText: `${assembly.prefix}${replyBlock}${event.text}`,
        commit: assembly.commit,
      };
    },
  };
}

/** host 侧 media 目录(host.paths.telegramMediaDir 的取值来源)。 */
export function telegramMediaDir(): string {
  return path.join(app.getPath('userData'), 'cc-agent', 'telegram-media');
}
