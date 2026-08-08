/**
 * main/im/telegram/adapter.ts
 * ---------------------------------------------------------------------------
 * 个人 Telegram bot 的 ImChannelAdapter — DM + 群 lane 双形态, 不启用
 * threadScoped(群路由靠 lane 合成 userId, 见 @cindy/im telegram/codec.ts):
 *   - DM: userId = Telegram 数字 user id, 每 (bot, owner) 一个长期会话;
 *   - 群/topic: userId = `g/{chatId}[/{threadId}]`, 每 lane 一个长期会话,
 *     与官方 bot 的 telegram:group/topic externalKey 语义对齐。
 *
 * 渠道级差异化钩子(官方通道行为的移植):
 *   - prepareAgentTurnText(群): 触发消息送模型前拼本地群上下文前缀(#843),
 *     游标在消息被路由受理后 commit。
 *
 * 流式呈现不按 DM / 群分叉: 两边共用同一份过程时间线 + 正文视图。
 */

import fs from 'node:fs';
import type { TelegramIM } from '@cindy/im';
import { decodeTelegramLaneUserId, decodeTelegramMessageId } from '@cindy/im';

import type { ImChannelAdapter, ImOrchestratorConfig } from '../shared/types';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage';
import { buildTelegramGroupContextPrefix, buildTelegramReplyContextBlock } from './groupWindow';
import { readTelegramPersona } from './behaviorStore';
import { autoRegisterTelegramSpeaker } from './contactsAutoRegister';
import { createTelegramGuestTurnPermissionPolicy } from './permissionPolicy';
import { telegramUiText, ui, PROCESSING_EMOJI } from './uiText';
import type { GroupHistoryAccessScope } from '../shared/groupHistoryAccess';

function ensureWorkingDir(botId: string): string {
  const dir = ownerScopedImUserDataPath('im-working-dir', `telegram-${botId}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** lane userId 含 `/`, 会话 id 与文件系统场景统一替换成 `-`。 */
function sessionSafeUserId(userId: string): string {
  return userId.replace(/\//g, '-');
}

/**
 * 人格块(soul.md 语义) — Hermes channel_prompt 先例: 每轮注入送模型文本,
 * 不落 transcript(prepareAgentTurnText 的 agentText 只进模型, 落库用渠道原文)。
 * owner 在设置卡编辑, 即改即生效。
 */
function personaBlock(): string {
  const persona = readTelegramPersona();
  const soul = persona.soul.trim();
  if (!persona.botName && !soul) return '';
  const nameLine = persona.botName ? `你的名字: ${persona.botName}\n` : '';
  return `<bot_persona>\n${nameLine}${soul}\n</bot_persona>\n\n`;
}

/** 发言人显示名/用户名消毒: 平台可改字段是不可信输入, 去控制字符与换行防注入。 */
function sanitizeSpeakerText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value
    .replace(/[\u0000-\u001f\u007f\u200b]/g, ' ')
    .trim()
    .slice(0, 64);
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
    interactionExpiredNotice: telegramUiText.expiredCardNotice,
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
    // 官方 bot 的结果表情习惯: 成功 👍 / 失败 👎; 中止不放(撤回 👀 即可)。
    terminalReactionEmoji: (kind) => (kind === 'done' ? '👍' : kind === 'error' ? '👎' : null),
    // /project: 从 Telegram 把当前会话切到 desktop 项目目录(bot 原生会话)。
    projectSwitching: true,
    buildVendorOptions: (userId) => ({ telegramChatId: userId, source: 'telegram' }),
    // 一群一会话的权限收紧(D1 + 2026-07-30 review 修订): **所有群轮次**都挂
    // 破坏性操作强确认 — 不只成员触发的。群窗口/引用块把成员可控文本注入
    // owner 触发的轮次, 提示注入可借 owner 轮次的宽松档执行危险操作; 统一
    // 强确认后确认卡只认 owner 点击, owner 多一次点按换掉这条注入通路。
    // DM(无 speaker)不挂, owner 私聊保持全速。
    turnPermissionPolicyFor: (event) =>
      event.speaker ? createTelegramGuestTurnPermissionPolicy(event.messageId) : undefined,
    groupHistoryAccessFor: (event): GroupHistoryAccessScope => {
      const lane = decodeTelegramLaneUserId(event.senderId);
      const provider = `telegram-personal:${event.contextId}`;
      return {
        // 跨 lane 检索只给 DM(!lane, 上游已保证 DM 非 owner 不进业务链路)。
        // 群轮次一律 lane-only —— 与上面 turnPermissionPolicyFor 的 2026-07-30
        // 裁决同一信任模型: 群窗口/引用块把成员可控文本注入 owner 触发的轮次,
        // 注入可借 owner 轮次把其它 lane 的历史检索出来回帖泄漏。owner 要跨
        // lane 查, 走私聊(检索类调用无强确认卡, 不能靠确认兜底)。
        access: lane ? 'lane' : 'owner',
        provider,
        lane: lane ? { provider, chatId: lane.chatId, threadId: lane.threadId } : null,
      };
    },
    prepareAgentTurnText: async (event) => {
      const lane = decodeTelegramLaneUserId(event.senderId);
      const replyBlock = event.replyContext
        ? buildTelegramReplyContextBlock(event.replyContext)
        : '';
      const persona = personaBlock();
      if (!lane) {
        // DM: 无群窗口, 但人格块与引用注入(回复某条消息触发)同样生效。
        if (!replyBlock && !persona) return null;
        return { agentText: `${persona}${replyBlock}${event.text}` };
      }
      const { messageId: triggerMessageId } = decodeTelegramMessageId(event.messageId);
      // 一群一 lane: 窗口维度与会话维度重合((chat, topic) 即 lane), 游标单条 —
      // 会话上下文本身连续, 窗口前缀只补"两轮之间群里别人说了什么"。
      const assembly = await buildTelegramGroupContextPrefix({
        botId: event.contextId,
        chatId: lane.chatId,
        threadId: lane.threadId,
        cursorScope: lane.threadId,
        triggerMessageId,
      });
      // 记住每个人①: 群里说话的人自动登记进智能通讯录(尽力而为, 零阻塞)。
      if (event.speaker) {
        autoRegisterTelegramSpeaker(event.speaker, { chatName: null });
      }
      // 全响应·自主判断(ambient): 安静上下文指令 — 值得说才说, 否则 NO_REPLY
      // 哨兵沉默(transport 在流式 finalize 吞掉哨兵并撤占位)。
      const ambientBlock = event.ambient
        ? '<ambient_mode>\n本条群消息不是对你的直接召唤(该群开启了全响应模式)。' +
          '只在你确有价值可补充时回复; 与你无关或不需要你插话时, ' +
          '只输出 NO_REPLY(不带任何其它字符)。\n</ambient_mode>\n'
        : '';
      // 群多人: 发言人标签注入(显示名是不可信输入 — 控制字符/换行消毒, 截断)。
      const speakerLine = event.speaker
        ? `[发言人] ${sanitizeSpeakerText(event.speaker.name)}` +
          (event.speaker.username ? ` (@${sanitizeSpeakerText(event.speaker.username)})` : '') +
          ` · id:${event.speaker.id}${event.speaker.isOwner ? ' · 主人' : ''}\n`
        : '';
      // 顺序: 群窗口(较远的背景) → 引用块(直接相关) → 发言人 → 用户正文。
      return {
        agentText: `${persona}${ambientBlock}${assembly.prefix}${replyBlock}${speakerLine}${event.text}`,
        commit: async () => {
          await assembly.commit();
        },
      };
    },
  };
}
