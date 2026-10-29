import fs from 'node:fs';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import type { DingTalkChannelIM, DingTalkIM, IMAttachment, RichChannelIM } from '@cindy/im';
import { decodeDingTalkLaneUserId } from '@cindy/im';

import { captureImContext } from '../../../shared/imMessageSource';
import type { ImChannelAdapter, ImOrchestratorConfig } from '../shared/types';
import { DINGTALK_PERSONAL_GROUP_WINDOW } from '../shared/channelGroupWindow';
import { createLogger } from '../../logger';
import { imChannelNoteSourceFromEvent } from '../shared/channelNote';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage';
import {
  buildDingTalkGroupContextPrefix,
  buildDingTalkReplyContextBlock,
  DINGTALK_GROUP_CONTEXT_LIMIT,
  DINGTALK_GROUP_CONTEXT_RESOURCE_MESSAGES,
} from './groupContext';
import { handleDingTalkTextInteraction } from './interaction';
import {
  buildDingTalkPersonaBlock,
  readDingTalkPersona,
  type DingTalkPersonaConfig,
} from './personaStore';
import { readDingTalkAccess, type DingTalkAccessConfig } from './accessStore';
import { createDingTalkTurnPermissionPolicy } from './permissionPolicy';
import { ui } from './uiText';

const log = createLogger('im:dingtalk');

function ensureWorkingDir(appKey: string): string {
  const dir = ownerScopedImUserDataPath('im-working-dir', dingtalkManagedWorkingDirName(appKey));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

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

export interface DingTalkAdapterDeps {
  /** 每轮现读人格，设置卡改动即生效；测试注入。 */
  readPersona(): DingTalkPersonaConfig;
  /** 每轮派发前现读群访问设置，关闭后立即生效；测试注入。 */
  readAccess(): DingTalkAccessConfig;
}

const defaultDeps: DingTalkAdapterDeps = {
  readPersona: readDingTalkPersona,
  readAccess: readDingTalkAccess,
};

/** 伙伴连接复用机器人传输, 不读取个人渠道的人格与群访问开关。 */
export interface DingTalkAdapterOptions extends Partial<DingTalkAdapterDeps> {
  companionBotId?: string;
}

export function buildDingTalkAdapter(
  dingtalkIm: DingTalkChannelIM | DingTalkIM,
  config: ImOrchestratorConfig,
  options: DingTalkAdapterOptions = {},
): ImChannelAdapter {
  const deps = { ...defaultDeps, ...options };
  const companion = Boolean(options.companionBotId);
  // 同一条群任务里默认只有主人触发的轮次可以凭「完全访问」取缔逐轮强确认；用对象
  // 身份记下这批 policy，非主人轮次仍 fail-closed。
  const ownerGroupTurnPolicies = new WeakSet<object>();
  // 「钉钉账号」方式下群成员的轮次：仅在主人打开 guestFullAccess 时才可取缔。
  const dwsGuestGroupTurnPolicies = new WeakSet<object>();
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
    // 插话只给「钉钉账号」方式：Agent 能在一轮中途用 dws 回消息，插话才对得上；
    // 机器人方式只在一轮结束时回复，仍按排队处理。
    // 伙伴连接不读个人渠道开关。
    steerWhileBusy: () =>
      !companion &&
      'getMode' in dingtalkIm &&
      dingtalkIm.getMode() === 'dws' &&
      deps.readAccess().steerWhileBusy,
    buildVendorOptions: (userId) => ({ dingtalkChatId: userId, source: 'dingtalk' }),
    // 伙伴自有连接: TOFU 认定的主人私聊进主任务(传输层已丢弃非主人私聊, 这里仍按 id
    // 判一次); 群会话按 conversation 一条专线。
    companionLane: (userId) => {
      const lane = decodeDingTalkLaneUserId(userId);
      if (lane) return { kind: 'group', chatId: lane.conversationId, threadId: '' };
      const owner = 'getOwnerUserId' in dingtalkIm ? dingtalkIm.getOwnerUserId() : '';
      return owner && userId === owner ? { kind: 'owner-dm' } : { kind: 'guest-dm', userId };
    },
    handleTextInteraction: (userId, request, options) =>
      handleDingTalkTextInteraction(dingtalkIm, userId, request, options),
    // 对齐 Telegram / 飞书的边界：主人私聊完全遵循 session.permissionMode，
    // 因而可以显式选择 bypassPermissions（完全访问）；群聊携带成员可控上下文，
    // 群轮次附加强确认策略，危险操作须主人在群里确认——只有主人触发且任务处于
    // 「完全访问」时才取缔（见 turnPolicyOptionalForMode）。
    turnPermissionPolicyFor: (event) => {
      if (!event.speaker) return undefined;
      if (companion && event.speaker.isOwner) return undefined;
      const policy = createDingTalkTurnPermissionPolicy(event.messageId, event.speaker.isOwner);
      if (companion) return policy;
      if (event.speaker.isOwner) ownerGroupTurnPolicies.add(policy);
      // 「钉钉账号」方式下的群成员轮次：主人可在设置里显式允许它们也用完全访问。
      // 机器人方式不受该设置影响。
      else if ('getMode' in dingtalkIm && dingtalkIm.getMode() === 'dws') dwsGuestGroupTurnPolicies.add(policy);
      return policy;
    },
    // 「完全访问」是主人对这条任务的明确授权：该档下 Agent 的工具调用不会冒泡到
    // 宿主，逐轮强确认无法兑现，因此主人触发的群轮次取缔策略（对齐 Telegram）。
    // 群成员轮次默认保留策略并 fail-closed；仅当主人打开「群成员也使用完全访问」
    // 时一并取缔（设置每轮现读，关闭即恢复）。
    turnPolicyOptionalForMode: (mode, policy) =>
      mode === 'bypassPermissions' &&
      (ownerGroupTurnPolicies.has(policy) ||
        (dwsGuestGroupTurnPolicies.has(policy) && deps.readAccess().guestFullAccess)),
    // 群里发言人已由下面的 `[发言人]` 行写明(含主人标记), 渠道说明不再重复。
    channelNoteSourceFor: (event) => imChannelNoteSourceFromEvent(event, { omitSender: true }),
    // 群: 先把这条入窗, 再拼「自上次以来群里的消息」前缀(与 Telegram 同一张表、同一套
    // 游标语义, 游标在消息被受理后 commit), 然后是发言人行与正文。
    prepareAgentTurnText: async (event) => {
      // 人格块（设置卡「人格」）：每轮现读，私聊与群聊都在最前面注入。
      const persona = companion ? '' : buildDingTalkPersonaBlock(deps.readPersona());
      // 引用回复（仅「钉钉账号」方式会带 replyContext）：私聊与群聊都注入。
      // 被引消息的附件（replyAttachments）只作为 contextAttachments 交给模型，
      // 不算当前发言人发送的附件、不落库。
      const replyAttachments = event.replyAttachments ?? [];
      const replyPrefix = event.replyContext
        ? buildDingTalkReplyContextBlock(event.replyContext, replyAttachments.length)
        : '';
      if (!event.speaker) {
        if (!replyPrefix && !persona && replyAttachments.length === 0) return null;
        return {
          agentText: `${persona}${replyPrefix}${event.text}`,
          ...(replyPrefix
            ? { contextSnapshot: captureImContext({ replyPrefix, replyMessageCount: 1 }) }
            : {}),
          ...(replyAttachments.length > 0 ? { contextAttachments: replyAttachments } : {}),
        };
      }
      const speaker = sanitizeSpeaker(event.speaker.name);
      const speakerLine = `[发言人] ${speaker} · id:${event.speaker.id}${event.speaker.isOwner ? ' · 主人' : ''}\n`;
      // 群上下文：仅「钉钉账号（dws）」方式能以账号身份读取群历史；机器人方式没有该能力。
      let groupPrefix = '';
      let groupMessageCount: number | undefined;
      let contextAttachments: IMAttachment[] = [];
      const lane = decodeDingTalkLaneUserId(event.senderId);
      const supportsHistory = 'supportsGroupHistory' in dingtalkIm && dingtalkIm.supportsGroupHistory();
      let commit: (() => Promise<void>) | undefined;
      if (lane && 'fetchRecentGroupMessages' in dingtalkIm && supportsHistory) {
        try {
          const history = await dingtalkIm.fetchRecentGroupMessages(
            lane.conversationId,
            DINGTALK_GROUP_CONTEXT_LIMIT,
            // 最近几条里的截图 / 文件一并带上；触发消息自身的附件已随入站下载。
            { withResources: DINGTALK_GROUP_CONTEXT_RESOURCE_MESSAGES, excludeMessageId: event.messageId },
          );
          const built = buildDingTalkGroupContextPrefix(history, event.messageId);
          if (built) {
            groupPrefix = built.prefix;
            groupMessageCount = built.messageCount;
            contextAttachments = built.contextAttachments;
          }
        } catch (error) {
          // 拉取失败不阻断本轮：按无群上下文继续。
          log.warn(
            `dingtalk group context fetch failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      // 机器人连接沿用上游本地窗口; DWS 继续读取账号可见的群历史与资源。
      if (lane && !supportsHistory) {
        const chatName = event.interactionSource?.chatName
          ? sanitizeSpeaker(event.interactionSource.chatName) || null
          : null;
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
        if (assembly) {
          groupPrefix = assembly.prefix;
          groupMessageCount = assembly.messageCount;
          commit = async () => { await assembly.commit(); };
        }
      }
      if (!groupPrefix && !replyPrefix) {
        return {
          agentText: `${persona}${speakerLine}${event.text}`,
          ...(commit ? { commit } : {}),
          ...(replyAttachments.length > 0 ? { contextAttachments: replyAttachments } : {}),
        };
      }
      // 顺序：人格 → 群上下文（较远背景）→ 引用块（直接相关）→ 发言人 → 正文。
      return {
        agentText: `${persona}${groupPrefix}${replyPrefix}${speakerLine}${event.text}`,
        ...(commit ? { commit } : {}),
        contextSnapshot: captureImContext({
          ...(groupPrefix ? { groupPrefix, groupMessageCount } : {}),
          ...(replyPrefix ? { replyPrefix, replyMessageCount: 1 } : {}),
        }),
        // 群历史与被引消息里的图片 / 文件只进模型消息，不落库（与飞书同口径）。
        ...(contextAttachments.length + replyAttachments.length > 0
          ? { contextAttachments: [...contextAttachments, ...replyAttachments] }
          : {}),
      };
    },
  };
}
