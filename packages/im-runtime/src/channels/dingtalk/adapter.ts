import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import type { DingTalkIM, RichChannelIM } from '@cindy/im';
import { decodeDingTalkLaneUserId } from '@cindy/im';

import { captureImContext } from '@cindy/companion-core/imMessageSource';
import type { ImChannelAdapter, ImOrchestratorConfig } from '../../types';
import type { ChannelGroupWindow } from '../../channelGroupWindow';
import type { Logger } from '@cindy/maker-core';
import { imChannelNoteSourceFromEvent } from '../../channelNote';
import { handleDingTalkTextInteraction } from './interaction';
import { createDingTalkTurnPermissionPolicy } from './permissionPolicy';
import { ui } from './uiText';

export function dingtalkManagedWorkingDirName(appKey: string): string {
  if (/^[A-Za-z0-9_-]{1,128}$/.test(appKey)) return `dingtalk-${appKey}`;
  const digest = createHash('sha256').update(appKey, 'utf8').digest('hex').slice(0, 24);
  return `dingtalk-external-${digest}`;
}

export function dingtalkSessionIdFor(appKey: string, userId: string): string {
  const encodedIdentity = Buffer.from(JSON.stringify([appKey, userId]), 'utf8').toString(
    'base64url',
  );
  return `dingtalk_${encodedIdentity}`;
}

function sanitizeSpeaker(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u200b]/g, ' ')
    .trim()
    .slice(0, 64);
}


export interface DingTalkAdapterOptions {
  /** 伙伴自有连接: 主人私聊进伙伴主任务, 群按 lane 一条专线, 权限档是唯一开关。 */
  companionBotId?: string;
}

export function buildDingTalkAdapter(
  dingtalkIm: DingTalkIM,
  config: ImOrchestratorConfig,
  host: { ensureWorkingDir(appKey: string): string; window: ChannelGroupWindow; log: Pick<Logger, 'warn'> },
  options: DingTalkAdapterOptions = {},
): ImChannelAdapter {
  const companion = Boolean(options.companionBotId);
  const { ensureWorkingDir, window: DINGTALK_PERSONAL_GROUP_WINDOW, log } = host;
  return {
    channel: 'dingtalk',
    // The shared card-action subscription still expects the rich interface.
    // Normal turn output is discriminated below and never calls card methods.
    im: dingtalkIm as RichChannelIM,
    output: {
      kind: 'chunked-text',
      im: dingtalkIm,
      commitFinal: async (output) => {
        await dingtalkIm.commitFinal(output);
        // 群消息本地窗口(与 Telegram 同一张表): 机器人自己发出的终稿也入窗, 下次群里
        // @ 时作为背景; 报错文案不入窗。入窗失败只告警, 不影响已发出的回复。
        const lane = decodeDingTalkLaneUserId(output.userId);
        const status = dingtalkIm.getStatus();
        const appKey = status.kind === 'connected' ? status.appId : '';
        if (!lane || !appKey || output.terminal === 'error' || !output.text.trim()) return;
        await DINGTALK_PERSONAL_GROUP_WINDOW.record({
          botId: appKey,
          chatId: lane.conversationId,
          threadId: '',
          messageId: `out:${randomUUID()}`,
          chatName: null,
          author: { name: 'bot', isBot: true },
          text: output.text,
          sentAt: Date.now(),
        }).catch((err) => log.warn(`dingtalk group window outbound record failed: ${String(err)}`));
      },
    },
    config,
    ui,
    sessions: {
      source: 'dingtalk',
      sessionIdFor: dingtalkSessionIdFor,
      defaultTitle: (userId) =>
        decodeDingTalkLaneUserId(userId)
          ? `钉钉群聊 · ${userId.slice(-6)}`
          : `钉钉 · ${userId.slice(-6)}`,
      generatedTitlePrefix: '钉钉 · ',
      workspaceKind: 'dialogue',
      ensureWorkingDir,
      extraInsertColumns: (appKey, userId) => ({
        imBotContextId: appKey,
        imUserId: userId,
      }),
    },
    processingEmoji: '',
    silentQueue: true,
    buildVendorOptions: (userId) => ({ dingtalkChatId: userId, source: 'dingtalk' }),
    // 伙伴自有连接: TOFU 认定的主人私聊进主任务(传输层已丢弃非主人私聊, 这里仍按 id
    // 判一次); 群会话按 conversation 一条专线。
    companionLane: (userId) => {
      const lane = decodeDingTalkLaneUserId(userId);
      if (lane) return { kind: 'group', chatId: lane.conversationId, threadId: '' };
      const owner = dingtalkIm.getOwnerUserId();
      return owner && userId === owner ? { kind: 'owner-dm' } : { kind: 'guest-dm', userId };
    },
    handleTextInteraction: (userId, request, options) =>
      handleDingTalkTextInteraction(dingtalkIm, userId, request, options),
    // 对齐 Telegram / 飞书的边界：主人私聊完全遵循 session.permissionMode，
    // 因而可以显式选择 bypassPermissions（完全访问）；群聊携带成员可控上下文，
    // 无论谁 @ bot 都附加强确认策略，危险操作仍须主人在群里确认。
    // 伙伴自有 bot(2026-10-16 Chris 裁决, 与 Telegram / 飞书同口径): 伙伴设置里的权限档是
    // 唯一开关, 主人触发的轮次不另挂策略; 成员触发的轮次只在破坏性动作上要主人确认。
    turnPermissionPolicyFor: (event) => {
      if (!event.speaker) return undefined;
      if (companion && event.speaker.isOwner) return undefined;
      return createDingTalkTurnPermissionPolicy(event.messageId, event.speaker.isOwner);
    },
    // 群里发言人已由下面的 `[发言人]` 行写明(含主人标记), 渠道说明不再重复。
    channelNoteSourceFor: (event) => imChannelNoteSourceFromEvent(event, { omitSender: true }),
    // 群: 先把这条入窗, 再拼「自上次以来群里的消息」前缀(与 Telegram 同一张表、同一套
    // 游标语义, 游标在消息被受理后 commit), 然后是发言人行与正文。
    prepareAgentTurnText: async (event) => {
      if (!event.speaker) return null;
      const speaker = sanitizeSpeaker(event.speaker.name);
      const speakerLine = `[发言人] ${speaker} · id:${event.speaker.id}${event.speaker.isOwner ? ' · 主人' : ''}\n`;
      const lane = decodeDingTalkLaneUserId(event.senderId);
      if (!lane) return { agentText: `${speakerLine}${event.text}` };
      const chatName = event.interactionSource?.chatName
        ? sanitizeSpeaker(event.interactionSource.chatName) || null
        : null;
      // 窗口是尽力而为的背景: 入窗或拼装失败只告警, 本轮照常带发言人行与正文。
      const assembly = await (async () => {
        await DINGTALK_PERSONAL_GROUP_WINDOW.record({
          botId: event.contextId,
          chatId: lane.conversationId,
          threadId: '',
          messageId: event.messageId,
          chatName,
          author: { name: speaker || 'user' },
          text: event.text,
          ...(event.attachments.length > 0
            ? { fileNames: event.attachments.map((att) => att.originalName) }
            : {}),
          sentAt: Date.now(),
        });
        return DINGTALK_PERSONAL_GROUP_WINDOW.buildContextPrefix({
          botId: event.contextId,
          chatId: lane.conversationId,
          threadId: '',
          triggerMessageId: event.messageId,
        });
      })().catch((err: unknown) => {
        log.warn(`dingtalk group window context failed (degraded): ${String(err)}`);
        return null;
      });
      if (!assembly) return { agentText: `${speakerLine}${event.text}` };
      return {
        agentText: `${assembly.prefix}${speakerLine}${event.text}`,
        contextSnapshot: captureImContext({
          groupPrefix: assembly.prefix,
          groupMessageCount: assembly.messageCount,
        }),
        commit: async () => {
          await assembly.commit();
        },
      };
    },
  };
}
