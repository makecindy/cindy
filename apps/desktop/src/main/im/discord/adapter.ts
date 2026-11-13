/**
 * main/im/discord/adapter.ts
 * ---------------------------------------------------------------------------
 * Discord 渠道的 ImChannelAdapter — 私聊 + 服务器频道 lane 双形态, 不启用 threadScoped:
 *   - 私聊: userId = Discord 数字 user id, 每 (bot, owner) 一个长期会话(既有路由不变);
 *   - 服务器频道 / thread: userId = lane id `g/{guild}/{channel}[/{thread}]`(见 @cindy/im
 *     discord/lane.ts), 每个 lane 一个独立会话与独立托管目录, 频道共享上下文、thread 独立。
 *     个人 bot 只认主人，伙伴连接可显式允许成员；公共频道不接入本机桌面任务。
 */

import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';
import { decodeDiscordLaneUserId, type DiscordIM, type DiscordLane } from '@cindy/im';

import type { ImChannelAdapter, ImOrchestratorConfig } from '../shared/types';
import type { GroupHistoryAccessScope } from '../shared/groupHistoryAccess';
import { receivedHistoryScope } from '../shared/receivedImageHistory';
import { claimLegacyImPath, ownerScopedImUserDataPath } from '../ownerScopedStorage';
import { createDiscordChannelTurnPermissionPolicy } from './permissionPolicy';
import { ui, PROCESSING_EMOJI } from './uiText';

/** 目录名 / 会话 id 里不放 lane 的 `/`。 */
function pathSafe(value: string): string {
  return value.replace(/\//g, '-');
}

/** lane 的托管目录叶子: bot 身份 + guild + channel [+ thread], 与私聊目录互不包含。 */
function laneLeaf(appId: string, lane: DiscordLane): string {
  return `discord-${appId}-g-${lane.guildId}-${lane.channelId}${lane.threadId ? `-${lane.threadId}` : ''}`;
}

function ensureWorkingDir(appId: string, userId?: string): string {
  const lane = userId ? decodeDiscordLaneUserId(userId) : null;
  const leaf = lane ? laneLeaf(appId, lane) : `discord-${appId}`;
  const dir = ownerScopedImUserDataPath('im-working-dir', leaf);
  // 私聊目录有历史位置要认领; lane 目录是新建的, 没有旧位置。
  if (!lane) claimLegacyImPath(path.join(app.getPath('userData'), 'im-working-dir', leaf), dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 发言人显示名是平台可改字段(不可信输入): 去控制字符与换行防注入, 截断。 */
function sanitizeSpeakerText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f\u200b]/g, ' ').trim().slice(0, 64);
}

export interface DiscordAdapterOptions {
  /** 伙伴自有连接：主人私聊进伙伴主任务，频道 / thread 进各自群专线。 */
  companionBotId?: string;
}

export function buildDiscordAdapter(
  discordIm: DiscordIM,
  config: ImOrchestratorConfig,
  options: DiscordAdapterOptions = {},
): ImChannelAdapter {
  const companion = Boolean(options.companionBotId);
  // 完全访问是主人对这条任务的明确授权: 只有主人触发的轮次取缔逐轮确认策略,
  // 对象身份记录这批 policy(WeakSet 不延长排队 policy 的生命周期)。
  const ownerTurnPolicies = new WeakSet<object>();
  return {
    channel: 'discord',
    im: discordIm,
    getBotContextId: () => discordIm.botContextId,
    output: { kind: 'rich-card', im: discordIm },
    config,
    ui,
    sessions: {
      source: 'discord',
      sessionIdFor: (appId, userId) => `discord_${appId}_${pathSafe(userId)}`,
      defaultTitle: (userId) =>
        decodeDiscordLaneUserId(userId) ? `Discord 频道 · ${userId.slice(-6)}` : `Discord · ${userId.slice(-6)}`,
      // 频道 lane 的正式标题: 服务器 #频道 [› thread]; 连接缓存里没有就保持默认标题。
      resolveSessionTitle: async (userId) => {
        const name = discordIm.describeLane(userId);
        return name ? `Discord · ${name}` : null;
      },
      skipOneshotTitleFor: (userId) => decodeDiscordLaneUserId(userId) !== null,
      generatedTitlePrefix: 'Discord · ',
      // Discord personal DMs use Cindy-managed working directories just like
      // Feishu/Telegram DMs. Keep them in the global "dialogue" bucket instead
      // of making `discord-{appId}` look like a user project.
      workspaceKind: 'dialogue',
      ensureWorkingDir,
      extraInsertColumns: (appId, userId) => ({
        imBotContextId: appId,
        imUserId: userId,
      }),
    },
    processingEmoji: PROCESSING_EMOJI,
    queuedEmoji: '👀',
    buildVendorOptions: (userId) => ({ discordChatId: userId, source: 'discord' }),
    // 伙伴自有连接: 只有填进去的主人能私聊(传输层丢弃其他人), 主人私聊进伙伴主任务;
    // 仍按 id 判一次, 不靠「传输层一定挡住」。
    // 频道 / thread 进入 group 专线，不能落到主人私聊主任务。
    companionLane: (userId) => {
      const lane = decodeDiscordLaneUserId(userId);
      if (lane) return { kind: 'group', chatId: lane.channelId, threadId: lane.threadId };
      const owner = discordIm.getOwnerUserId();
      return owner && userId === owner ? { kind: 'owner-dm' } : { kind: 'guest-dm', userId };
    },
    // 公共频道不接入本机桌面任务 / 项目(/ctr /session /project 及其卡片)。
    blocksLocalTaskAccess: (userId) => decodeDiscordLaneUserId(userId) !== null,
    // 频道轮次: 破坏性 / 不透明写走确认, 卡片点击只认主人(传输层已校验点击人)。
    // 伙伴自有连接(2026-10-16 裁决, 与 Telegram / 钉钉伙伴同口径): 伙伴设置里的权限档是唯一开关,
    // 主人触发的轮次不另挂策略, 成员 / 外部用户触发的轮次只在破坏性动作上要主人确认。
    turnPermissionPolicyFor: (event) => {
      if (!event.speaker || !decodeDiscordLaneUserId(event.senderId)) return undefined;
      if (companion) {
        return event.speaker.isOwner ? undefined : createDiscordChannelTurnPermissionPolicy(event.messageId, false);
      }
      const policy = createDiscordChannelTurnPermissionPolicy(event.messageId, event.speaker.isOwner);
      if (event.speaker.isOwner) ownerTurnPolicies.add(policy);
      return policy;
    },
    // 个人 bot: 只有主人轮次的策略在完全访问下可取缔; 伙伴: 完全访问是主人对伙伴的明确授权,
    // 三种 Agent 都无法兑现逐轮策略, 成员轮次同样取缔而不是拒跑(要成员动手前先确认, 把伙伴设成 Auto 或 Ask)。
    turnPolicyOptionalForMode: (mode, policy) =>
      mode === 'bypassPermissions' && (companion || ownerTurnPolicies.has(policy)),
    // 频道只给本 lane 的收图历史(access: 'lane'), 绝不给跨 lane / 私聊检索; 私聊走共享兜底。
    groupHistoryAccessFor: (event): GroupHistoryAccessScope | undefined => {
      const lane = decodeDiscordLaneUserId(event.senderId);
      return lane ? receivedHistoryScope('discord', event.contextId, lane.channelId, lane.threadId) : undefined;
    },
    // 频道里多人场景由发言人行写明谁在说话(含主人标记); 私聊保持原样。
    prepareAgentTurnText: async (event) => {
      if (!event.speaker || !decodeDiscordLaneUserId(event.senderId)) return null;
      const name = sanitizeSpeakerText(event.speaker.name) || 'user';
      return {
        agentText: `[发言人] ${name} · id:${event.speaker.id}${event.speaker.isOwner ? ' · 主人' : ''}\n${event.text}`,
      };
    },
  };
}
