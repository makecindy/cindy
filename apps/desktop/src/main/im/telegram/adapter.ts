import { captureImContext } from '../../../shared/imMessageSource';
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
import {
  buildTelegramGroupContextPrefix,
  buildTelegramHistoryMediaNote,
  buildTelegramReplyContextBlock,
} from './groupWindow';
import { readTelegramPersona } from './behaviorStore';
import { autoRegisterTelegramSpeaker } from './contactsAutoRegister';
import { createTelegramGuestTurnPermissionPolicy } from './permissionPolicy';
import { telegramUiText, ui, PROCESSING_EMOJI } from './uiText';
import type { GroupHistoryAccessScope } from '../shared/groupHistoryAccess';
import type { TelegramToolScope } from '../shared/channelToolScope';
import { imChannelNoteDirectSourceFromEvent, imChannelNoteSourceFromEvent } from '../shared/channelNote';
import type { AmbientReplyJudge } from '../shared/ambientReplyJudge';

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
 * owner 在设置卡编辑, 即改即生效。只有设置页那份个人 bot 有人格块; 伙伴自有连接的
 * 身份来自伙伴的 SOUL(会话启动时装配), 不再注入。
 */
function personaBlock(): string {
  const persona = readTelegramPersona();
  const soul = persona.soul.trim();
  if (!persona.botName && !soul) return '';
  const nameLine = persona.botName ? `你的名字: ${persona.botName}\n` : '';
  return `<bot_persona>\n${nameLine}${soul}\n</bot_persona>\n\n`;
}

/** 个人 bot 的「我是谁」给判定器: 设置页人格的名字 + SOUL 摘要(判定不需要整份)。 */
async function describePersonaForAmbientJudge(): Promise<{ name: string; description: string }> {
  const persona = readTelegramPersona();
  return { name: persona.botName, description: persona.soul };
}

/** 发言人显示名/用户名消毒: 平台可改字段是不可信输入, 去控制字符与换行防注入。 */
function sanitizeSpeakerText(value: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f\u200b]/g, ' ');
  return cleaned.trim().slice(0, 64);
}

/**
 * 渠道说明末尾的一句工具提示: Agent 在 Telegram 轮次里第一时间知道自己手上有 Bot API,
 * 不用摸瞎试(工具描述只在工具清单里, 模型常常不去翻)。
 */
export const TELEGRAM_TOOLS_HINT =
  '本轮可直接用 cindy_telegram_bot 工具操作 Telegram Bot API(发文字 / 媒体 / 投票、表情、置顶、下载对方发来的文件、群信息、call_api 任意方法), 默认目标就是本条所在对话。';

export interface TelegramAdapterOptions {
  /** 伙伴自有连接: 不注入设置页人格, 私聊按主人 / 外部用户分落点。 */
  companionBotId?: string;
  /**
   * 全响应(ambient)群消息的前置判定器(辅助模型链)。不给 = 每条都起轮次, 由主模型
   * NO_REPLY(老行为)。
   */
  ambientReplyJudge?: AmbientReplyJudge;
  /**
   * 判定提示里的「我是谁」。伙伴连接给伙伴名字 + 简介; 不给时个人 bot 用设置页人格
   * (botName + SOUL 摘要)。
   */
  describeSelfForAmbientJudge?: () => Promise<{ name: string; description: string }>;
}

export function buildTelegramAdapter(
  telegramIm: TelegramIM,
  config: ImOrchestratorConfig,
  options: TelegramAdapterOptions = {},
): ImChannelAdapter {
  const companion = Boolean(options.companionBotId);
  // 同一条群任务会混入 owner 与非 owner 的消息。Full access 只能取缔 owner
  // 触发轮次的逐轮策略；用对象身份记录这批 policy，避免把会话级权限误当成
  // 整个群所有成员的授权。WeakSet 不延长排队 policy 的生命周期。
  const ownerGroupTurnPolicies = new WeakSet<object>();
  return {
    channel: 'telegram',
    getBotDisplayName: () => telegramIm.botName,
    im: telegramIm,
    output: { kind: 'rich-card', im: telegramIm },
    config,
    ui,
    interactionExpiredNotice: telegramUiText.expiredCardNotice,
    sessions: {
      source: 'telegram',
      sessionIdFor: (botId, userId) => `telegram_${botId}_${sessionSafeUserId(userId)}`,
      createTaskOnNew: true,
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
    // 已收到、等待处理；开始执行后切换为 processingEmoji。
    queuedEmoji: '👀',
    // 正常完成由回复本身反馈，清除状态表情；失败保留提醒。
    terminalReactionEmoji: (kind) => (kind === 'error' ? '👎' : null),
    // /project: 从 Telegram 把当前会话切到 desktop 项目目录(bot 原生会话)。
    projectSwitching: true,
    // 伙伴自有连接: 主人私聊进主任务; 群 / topic 按 lane 一条专线; 对外开放后的
    // 陌生人私聊(transport guestDm)按用户一条专线。
    companionLane: (userId) => {
      const lane = decodeTelegramLaneUserId(userId);
      if (lane) return { kind: 'group', chatId: lane.chatId, threadId: lane.threadId };
      return userId === telegramIm.getOwnerUserId() ? { kind: 'owner-dm' } : { kind: 'guest-dm', userId };
    },
    buildVendorOptions: (userId) => ({ telegramChatId: userId, source: 'telegram' }),
    // 全响应·自主判断: 辅助模型先看一眼该不该插话(带群窗口背景 + 发言人 + 机器人身份),
    // SKIP 就不起轮次。群窗口只读不 commit —— 这条消息留在窗口里当下次的背景。
    // 判不出来(unknown)照旧起轮次交给主模型。
    ambientTurnGate: async (event) => {
      const judge = options.ambientReplyJudge;
      if (!judge || event.ambient !== true) return 'proceed';
      const lane = decodeTelegramLaneUserId(event.senderId);
      if (!lane) return 'proceed';
      let triggerMessageId = '';
      try {
        triggerMessageId = decodeTelegramMessageId(event.messageId).messageId;
      } catch {
        triggerMessageId = '';
      }
      const [assembly, self] = await Promise.all([
        buildTelegramGroupContextPrefix({
          botId: event.contextId,
          chatId: lane.chatId,
          threadId: lane.threadId,
          cursorScope: lane.threadId,
          triggerMessageId,
        }).catch(() => ({ prefix: '' })),
        (options.describeSelfForAmbientJudge ?? describePersonaForAmbientJudge)().catch(() => ({
          name: '',
          description: '',
        })),
      ]);
      const speaker = event.speaker
        ? `[speaker] ${sanitizeSpeakerText(event.speaker.name)}` +
          (event.speaker.username ? ` (@${sanitizeSpeakerText(event.speaker.username)})` : '') +
          (event.speaker.isOwner ? ' · owner' : '')
        : '';
      const verdict = await judge({
        botName: self.name || telegramIm.botName,
        botDescription: self.description,
        groupContext: assembly.prefix,
        speaker,
        text: event.text,
        ...(event.replyContext
          ? { replyTo: { author: event.replyContext.author, text: event.replyContext.text } }
          : {}),
      });
      return verdict === 'skip' ? 'skip' : 'proceed';
    },
    // 一群一会话的权限收紧(D1 + 2026-07-30 review 修订): 除显式 Full access 外,
    // 所有群轮次都挂破坏性操作强确认 — 不只成员触发的。群窗口/引用块把成员可控文本注入
    // owner 触发的轮次, 提示注入可借 owner 轮次的宽松档执行危险操作; 统一
    // 强确认后确认卡只认 owner 点击, owner 多一次点按换掉这条注入通路。
    // DM(无 speaker)不挂, owner 私聊保持全速。
    turnPermissionPolicyFor: (event) => {
      if (!event.speaker) return undefined;
      // 伙伴自有 bot(2026-10-16 Chris 裁决): 伙伴设置里的权限档是唯一开关。主人触发
      // 的轮次不另挂策略; 成员 / 外部用户触发的轮次只在破坏性动作上要主人确认。
      if (companion) {
        return event.speaker.isOwner
          ? undefined
          : createTelegramGuestTurnPermissionPolicy(event.messageId, false);
      }
      const policy = createTelegramGuestTurnPermissionPolicy(event.messageId, event.speaker.isOwner);
      if (event.speaker.isOwner) ownerGroupTurnPolicies.add(policy);
      return policy;
    },
    // Full access 是 owner 对这条任务的明确授权。该档下各 Agent 的工具调用不会
    // 冒泡到 host，逐轮强确认策略无法兑现；owner 触发时取缔策略，避免 provider
    // 启动前报不支持。非 owner 仍保留策略并 fail-closed，不能借同一群任务的
    // Full access 直接驱动工具。这里仅负责新消息准入；主人对已受理轮次主动切档
    // 按普通任务立即生效(2026-10-23 Dash 裁决)，不在这里增加运行中限制。
    // 其它权限档与群上下文隔离都不受影响。
    // 伙伴自有 bot: 完全访问是主人对这个伙伴的明确授权, 三种 Agent 在该档下都
    // 无法兑现逐轮策略, 成员触发的轮次同样取缔策略而不是拒跑 —— 要成员动手前
    // 必须确认, 把伙伴设成 Auto 或 Ask。
    turnPolicyOptionalForMode: (mode, policy) =>
      mode === 'bypassPermissions' && (companion || ownerGroupTurnPolicies.has(policy)),
    groupHistoryAccessFor: (event): GroupHistoryAccessScope | undefined => {
      const lane = decodeTelegramLaneUserId(event.senderId);
      // Companion bots admit guest DMs too. Reuse the verified requester identity
      // used by channelToolScopeFor; a DM alone is not proof of ownership.
      if (
        !lane &&
        !(event.speaker ? event.speaker.isOwner : event.senderId === telegramIm.getOwnerUserId())
      ) return undefined;
      const provider = `telegram-personal:${event.contextId}`;
      return {
        // 跨 lane 检索只给通过主人身份检查的 DM。
        // 群轮次一律 lane-only —— 与上面 turnPermissionPolicyFor 的 2026-07-30
        // 裁决同一信任模型: 群窗口/引用块把成员可控文本注入 owner 触发的轮次,
        // 注入可借 owner 轮次把其它 lane 的历史检索出来回帖泄漏。owner 要跨
        // lane 查, 走私聊(检索类调用无强确认卡, 不能靠确认兜底)。
        access: lane ? 'lane' : 'owner',
        provider,
        readImage: (fileId) => telegramIm.readGroupHistoryImage(fileId),
        lane: lane ? { provider, chatId: lane.chatId, threadId: lane.threadId } : null,
      };
    },
    // 群里发言人已由 prepareAgentTurnText 的 `[发言人]` 行写明(含主人标记), 渠道说明不再重复。
    // 私聊按 lane 判定(不按 speaker 有无猜): 伙伴自有 bot 对外开放后外部用户的私聊也带
    // speaker, 说明里写明是谁、不是主人。末尾点一句本轮有 Bot API 工具可用。
    channelNoteSourceFor: (event) => ({
      ...(decodeTelegramLaneUserId(event.senderId)
        ? imChannelNoteSourceFromEvent(event, { omitSender: true })
        : imChannelNoteDirectSourceFromEvent(event)),
      toolsHint: TELEGRAM_TOOLS_HINT,
    }),
    // cindy_telegram_bot 的逐轮作用域: 目标 chat 就是触发消息所在的 chat; 触发者是不是主人
    // 由 Main 校验过的 speaker / owner id 决定(不来自模型参数)。transport 就是这条连接自己。
    channelToolScopeFor: (event): TelegramToolScope => {
      const lane = decodeTelegramLaneUserId(event.senderId);
      let triggerMessageId = '';
      try {
        triggerMessageId = decodeTelegramMessageId(event.messageId).messageId;
      } catch {
        triggerMessageId = '';
      }
      const requesterIsOwner = lane
        ? event.speaker?.isOwner === true
        : event.speaker
          ? event.speaker.isOwner
          : event.senderId === telegramIm.getOwnerUserId();
      return {
        channel: 'telegram',
        im: telegramIm,
        botId: event.contextId,
        laneUserId: event.senderId,
        chatId: lane ? lane.chatId : event.senderId,
        threadId: lane ? lane.threadId : '',
        chatKind: lane ? 'group' : 'direct',
        requesterIsOwner,
        triggerMessageId,
        companion,
      };
    },
    prepareAgentTurnText: async (event) => {
      const lane = decodeTelegramLaneUserId(event.senderId);
      const replyBlock = event.replyContext
        ? buildTelegramReplyContextBlock(event.replyContext)
        : '';
      const persona = companion ? '' : personaBlock();
      if (!lane) {
        // DM: 无群窗口, 但人格块与引用注入(回复某条消息触发)同样生效。
        if (!replyBlock && !persona) return null;
        return {
          agentText: `${persona}${replyBlock}${event.text}`,
          contextSnapshot: captureImContext({ replyPrefix: replyBlock, replyMessageCount: 1 }),
          ...(event.replyContext ? { replyContext: event.replyContext } : {}),
        };
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
      // 「先发视频/图片、再单独 @bot」: 群上下文里纳入的那些消息带的附件一并补齐,
      // 只进模型消息不落库(contextAttachments 语义, 与飞书群上下文同口径)。
      // 下载失败不阻断本轮 — 说明块会把原因交给模型。ambient(全响应)轮次不补:
      // 每条普通群消息都会起一轮, 逐轮下载群里的音视频代价过高, 仍只给文件名。
      const historyMedia = event.ambient
        ? { attachments: [], unavailable: [] }
        : await telegramIm
            .collectGroupHistoryMedia(
              lane.chatId,
              assembly.messageIds ?? [],
              // 触发消息的相册成员与被引消息已随本轮附件送达, 由 transport 排除。
              event.raw as Parameters<TelegramIM['collectGroupHistoryMedia']>[2],
            )
            .catch(() => ({ attachments: [], unavailable: [] }));
      const historyMediaNote = buildTelegramHistoryMediaNote({
        provided: historyMedia.attachments,
        unavailable: historyMedia.unavailable,
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
        agentText: `${persona}${ambientBlock}${assembly.prefix}${historyMediaNote}${replyBlock}${speakerLine}${event.text}`,
        contextSnapshot: captureImContext({
          groupPrefix: assembly.prefix,
          groupMessageCount: assembly.messageCount,
          replyPrefix: replyBlock,
          replyMessageCount: 1,
        }),
        ...(event.replyContext ? { replyContext: event.replyContext } : {}),
        ...(historyMedia.attachments.length > 0
          ? {
              contextAttachments: historyMedia.attachments.map((att) => ({
                kind: att.kind,
                absPath: att.absPath,
                originalName: att.originalName,
                mimeType: att.mimeType,
                ...(att.url ? { url: att.url } : {}),
              })),
            }
          : {}),
        commit: async () => {
          await assembly.commit();
        },
      };
    },
  };
}
