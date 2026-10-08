import fs from 'node:fs';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { DingTalkChannelIM, IMAttachment, RichChannelIM } from '@cindy/im';
import { decodeDingTalkLaneUserId } from '@cindy/im';

import { captureImContext } from '../../../shared/imMessageSource';
import { createLogger } from '../../logger';
import type { ImChannelAdapter, ImOrchestratorConfig } from '../shared/types';
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

export function buildDingTalkAdapter(
  dingtalkIm: DingTalkChannelIM,
  config: ImOrchestratorConfig,
  deps: DingTalkAdapterDeps = defaultDeps,
): ImChannelAdapter {
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
      commitFinal: (output) => dingtalkIm.commitFinal(output),
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
    handleTextInteraction: (userId, request, options) =>
      handleDingTalkTextInteraction(dingtalkIm, userId, request, options),
    // 对齐 Telegram / 飞书的边界：主人私聊完全遵循 session.permissionMode，
    // 因而可以显式选择 bypassPermissions（完全访问）；群聊携带成员可控上下文，
    // 群轮次附加强确认策略，危险操作须主人在群里确认——只有主人触发且任务处于
    // 「完全访问」时才取缔（见 turnPolicyOptionalForMode）。
    turnPermissionPolicyFor: (event) => {
      if (!event.speaker) return undefined;
      const policy = createDingTalkTurnPermissionPolicy(event.messageId, event.speaker.isOwner);
      if (event.speaker.isOwner) ownerGroupTurnPolicies.add(policy);
      // 「钉钉账号」方式下的群成员轮次：主人可在设置里显式允许它们也用完全访问。
      // 机器人方式不受该设置影响。
      else if (dingtalkIm.getMode() === 'dws') dwsGuestGroupTurnPolicies.add(policy);
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
    prepareAgentTurnText: async (event) => {
      // 人格块（设置卡「人格」）：每轮现读，私聊与群聊都在最前面注入。
      const persona = buildDingTalkPersonaBlock(deps.readPersona());
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
      let groupMessageCount = 0;
      let contextAttachments: IMAttachment[] = [];
      const lane = decodeDingTalkLaneUserId(event.senderId);
      if (lane && dingtalkIm.supportsGroupHistory()) {
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
      if (!groupPrefix && !replyPrefix) {
        return {
          agentText: `${persona}${speakerLine}${event.text}`,
          ...(replyAttachments.length > 0 ? { contextAttachments: replyAttachments } : {}),
        };
      }
      // 顺序：人格 → 群上下文（较远背景）→ 引用块（直接相关）→ 发言人 → 正文。
      return {
        agentText: `${persona}${groupPrefix}${replyPrefix}${speakerLine}${event.text}`,
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
