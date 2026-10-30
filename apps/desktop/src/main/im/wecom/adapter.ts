import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import type { IMMessageEvent, WecomIM } from '@cindy/im';
import { decodeWecomLane } from '@cindy/im';

import { captureImContext } from '../../../shared/imMessageSource';
import type { ImChannelAdapter, ImOrchestratorConfig } from '../shared/types';
import {
  sanitizeGroupWindowName,
  WECOM_PERSONAL_GROUP_WINDOW,
} from '../shared/channelGroupWindow';
import { buildImReplyContextBlock } from '../shared/replyContext';
import { createLogger } from '../../logger';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage';
import { ui } from './uiText';
import type { WecomTextInteractions } from './textInteractions';

function ensureWorkingDir(botId: string): string {
  const safeBotId = Buffer.from(botId, 'utf8').toString('base64url').slice(0, 96);
  const dir = ownerScopedImUserDataPath('im-working-dir', `wecom-${safeBotId}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionSafeUserId(userId: string): string {
  return Buffer.from(userId, 'utf8').toString('base64url');
}

const log = createLogger('im:wecom-adapter');

/** 群 lane 的 chatId; 私聊或坏掉的 lane 返回 null。 */
function groupChatIdOf(userId: string): string | null {
  try {
    const lane = decodeWecomLane(userId);
    return lane.kind === 'group' ? lane.targetId : null;
  } catch {
    return null;
  }
}

/** 引用回复块 —— 与共享层对没有 prepareAgentTurnText 的渠道的兜底完全一致。 */
function replyContextParts(event: IMMessageEvent): {
  replyBlock: string;
  replyContext?: IMMessageEvent['replyContext'];
} {
  if (!event.replyContext) return { replyBlock: '' };
  return { replyBlock: buildImReplyContextBlock(event.replyContext), replyContext: event.replyContext };
}

export interface WecomAdapterOptions {
  /** 伙伴自有连接: 主人私聊进伙伴主任务, 群按 lane 一条专线。 */
  companionBotId?: string;
}

export function buildWecomAdapter(
  wecomIm: WecomIM,
  interactions: WecomTextInteractions,
  config: ImOrchestratorConfig,
  options: WecomAdapterOptions = {},
): ImChannelAdapter {
  void options;
  // 群 lane → 入站 contextId(窗口 provider 用); 出站终稿按同一身份入窗, 没见过入站的
  // lane(后台轮次转播)回落到已连接的 bot id。
  const laneBotIds = new Map<string, string>();
  const botIdForLane = (userId: string): string => {
    const known = laneBotIds.get(userId);
    if (known) return known;
    const status = wecomIm.getStatus();
    return status.kind === 'connected' ? status.appId : '';
  };
  return {
    channel: 'wecom',
    im: wecomIm,
    output: {
      kind: 'chunked-text',
      im: wecomIm,
      beginReply: (userId) => wecomIm.beginReply(userId),
      commitFinal: async (output) => {
        await wecomIm.commitFinal(output);
        // 群消息本地窗口(与 Telegram 同一张表): 机器人自己发出的终稿也入窗, 下次群里
        // @ 时作为背景; 报错文案不入窗。入窗失败只告警, 不影响已发出的回复。
        const chatId = groupChatIdOf(output.userId);
        const botId = chatId ? botIdForLane(output.userId) : '';
        if (!chatId || !botId || output.terminal === 'error' || !output.text.trim()) return;
        await WECOM_PERSONAL_GROUP_WINDOW.record({
          botId,
          chatId,
          threadId: '',
          messageId: `out:${randomUUID()}`,
          chatName: null,
          author: { name: 'bot', isBot: true },
          text: output.text,
          sentAt: Date.now(),
        }).catch((err) => log.warn(`wecom group window outbound record failed: ${String(err)}`));
      },
    },
    config,
    ui,
    sessions: {
      source: 'wecom',
      sessionIdFor: (botId, userId) =>
        `wecom_${sessionSafeUserId(botId)}_${sessionSafeUserId(userId)}`,
      defaultTitle: (userId) =>
        userId.startsWith('group/')
          ? `企微群 · ${userId.slice(-6)}`
          : `企业微信 · ${userId.slice(-6)}`,
      generatedTitlePrefix: '企业微信 · ',
      workspaceKind: 'dialogue',
      ensureWorkingDir,
      extraInsertColumns: (botId, userId) => ({
        imBotContextId: botId,
        imUserId: userId,
      }),
    },
    processingEmoji: '',
    silentQueue: true,
    buildVendorOptions: (userId) => ({
      source: 'wecom',
      wecomConversationId: userId,
    }),
    // 伙伴自有连接: 企业微信传输层只放行 TOFU 主人(单聊首个发言人)的消息, 所以
    // 私聊一律是主人 → 伙伴主任务; 群(主人在群里 @)按 chat 一条专线。非主人私聊
    // 在传输层就被挡住, 这里仍按用户 id 判一次, 不靠「传输层一定挡住」。
    companionLane: (userId) => {
      let lane: ReturnType<typeof decodeWecomLane> | null = null;
      try {
        lane = decodeWecomLane(userId);
      } catch {
        lane = null;
      }
      if (lane?.kind === 'group') return { kind: 'group', chatId: lane.targetId, threadId: '' };
      const owner = wecomIm.getOwnerUserId();
      return owner && userId === owner ? { kind: 'owner-dm' } : { kind: 'guest-dm', userId };
    },
    handleTextInteraction: (userId, request, options) => interactions.handle(userId, request, options),
    // 群(主人在群里 @ 机器人): 先把这条入窗, 再拼「自上次以来群里的消息」前缀, 游标在
    // 消息被受理后 commit(与 Telegram 同一套语义)。私聊只保留引用回复块, 与共享层的兜底一致。
    prepareAgentTurnText: async (event) => {
      const { replyBlock, replyContext } = replyContextParts(event);
      const chatId = groupChatIdOf(event.senderId);
      if (!chatId) {
        if (!replyBlock) return null;
        return {
          agentText: `${replyBlock}${event.text}`,
          contextSnapshot: captureImContext({ replyPrefix: replyBlock, replyMessageCount: 1 }),
          ...(replyContext ? { replyContext } : {}),
        };
      }
      const botId = event.contextId;
      laneBotIds.delete(event.senderId);
      laneBotIds.set(event.senderId, botId);
      if (laneBotIds.size > 256) {
        const oldest = laneBotIds.keys().next().value;
        if (oldest !== undefined) laneBotIds.delete(oldest);
      }
      // 窗口是尽力而为的背景: 入窗或拼装失败只告警, 本轮照常带引用块与正文。
      const assembly = await (async () => {
        await WECOM_PERSONAL_GROUP_WINDOW.record({
          botId,
          chatId,
          threadId: '',
          messageId: event.messageId,
          chatName: null,
          author: { name: sanitizeGroupWindowName(event.speaker?.name ?? '') || 'user' },
          text: event.text,
          ...(event.attachments.length > 0
            ? { fileNames: event.attachments.map((att) => att.originalName) }
            : {}),
          sentAt: Date.now(),
        });
        return WECOM_PERSONAL_GROUP_WINDOW.buildContextPrefix({
          botId,
          chatId,
          threadId: '',
          triggerMessageId: event.messageId,
        });
      })().catch((err: unknown) => {
        log.warn(`wecom group window context failed (degraded): ${String(err)}`);
        return null;
      });
      if (!assembly) {
        return {
          agentText: `${replyBlock}${event.text}`,
          ...(replyBlock
            ? { contextSnapshot: captureImContext({ replyPrefix: replyBlock, replyMessageCount: 1 }) }
            : {}),
          ...(replyContext ? { replyContext } : {}),
        };
      }
      return {
        agentText: `${assembly.prefix}${replyBlock}${event.text}`,
        contextSnapshot: captureImContext({
          groupPrefix: assembly.prefix,
          groupMessageCount: assembly.messageCount,
          replyPrefix: replyBlock,
          replyMessageCount: 1,
        }),
        ...(replyContext ? { replyContext } : {}),
        commit: async () => {
          await assembly.commit();
        },
      };
    },
  };
}
