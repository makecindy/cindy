/**
 * main/im/shared/channelGroupWindow.ts
 * ---------------------------------------------------------------------------
 * 个人 IM 渠道的群消息本地窗口 —— 渠道无关的那一层。
 *
 * 存储、游标、预算与栅栏都在 groupWindowCore(与官方 hook 共用); 这里只把
 * 「一个渠道的个人 bot 怎么用这张表」收成一个工厂:
 *   - provider 按 bot 命名空间: `<渠道前缀>:<botContextId>`。换绑不同 bot、或两位伙伴
 *     各自的连接在同一个群里, 窗口互不掺杂; 与官方 hook 的 provider('telegram' 等)
 *     也不重叠。
 *   - 每个渠道一份内存游标热缓存, 持久事实在 hook_group_context_cursors。
 *
 * Telegram 最早落地(telegram/groupWindow.ts 是它的薄封装, 行为不变); 企业微信与钉钉
 * 复用同一张表、同一套游标语义, 只是 provider 前缀不同(见下方两个实例)。
 */

import type { Logger } from '@cindy/maker-core';
import type { createGroupWindowCore } from './groupWindowCore';
import {
  createFenceNeutralizer,
  DEFAULT_GROUP_WINDOW_RETENTION,
  type GroupContextAssembly,
  type GroupWindowRetentionPolicy,
} from './groupWindowCore';

/** 一条入窗消息(入站或 bot 自己的出站)。botId = 这条连接的 botContextId。 */
export interface ChannelGroupWindowEntry {
  botId: string;
  chatId: string;
  /** 话题 id; '' = 主群流。 */
  threadId: string;
  messageId: string;
  chatName?: string | null;
  author: { name: string; isBot?: boolean };
  text: string;
  fileNames?: string[];
  sentAt: number;
}

export interface ChannelGroupContextArgs {
  botId: string;
  chatId: string;
  /** 窗口维度(话题 id 或 '' 主群流)。 */
  threadId: string;
  /**
   * 游标命名空间(缺省 = threadId)。只能传稳定、低基数的 lane scope; 不得传
   * messageId/requestId/turnId 等逐消息高基数值, 否则会制造无界游标行。
   */
  cursorScope?: string;
  /** 触发消息的渠道原生 message id —— 从上下文中精确剔除「当前消息」。 */
  triggerMessageId: string;
}

export interface ChannelGroupWindow {
  /** provider 列值的渠道前缀(不含冒号)。 */
  readonly providerPrefix: string;
  /** 该 bot 的 provider 命名空间。 */
  providerOf(botId: string): string;
  /** 入窗(幂等: 同 (provider,chat,thread,message) 唯一键重复插入直接忽略)。 */
  record(entry: ChannelGroupWindowEntry): Promise<void>;
  /**
   * 为一次群 lane 触发组装本地群上下文前缀。窗口为空返回空前缀(commit 仍可能
   * 推进游标 —— 窗口里只剩触发消息自己时也要前移)。
   */
  buildContextPrefix(args: ChannelGroupContextArgs): Promise<GroupContextAssembly>;
  /** 清理本渠道 provider 的内存游标(默认连持久游标一起清)。 */
  resetCursors(options?: { clearPersisted?: boolean }): Promise<void>;
  /** 该 bot 见过的群(窗口表 distinct chat), 按最近活跃排序。 */
  listKnownGroups(botId: string): Promise<Array<{ chatId: string; chatName: string | null }>>;
}

/** 中和正文/署名里出现的栅栏标签, 消息内容不能自行闭合上下文边界。 */
const neutralizeFenceTags = createFenceNeutralizer(['group_chat_context', 'reply_context']);

export function createChannelGroupWindow(options: {
  providerPrefix: string;
  /**
   * 该渠道生效的容量安全阀。按引用读取 —— 测试可以就地改小阈值把回收逼出来。
   * 额度按 provider 命名空间独立计算, 不跨 bot、不跨渠道。
   */
  retention: GroupWindowRetentionPolicy;
  log: Pick<Logger, 'warn' | 'info'>;
}, host: {
  core: ReturnType<typeof createGroupWindowCore>;
  listKnownGroups(provider: string): Promise<Array<{ chatId: string; chatName: string | null }>>;
}): ChannelGroupWindow {
  const { providerPrefix, retention, log } = options;
  const { recordGroupWindowEntry, assembleGroupWindowContext, resetGroupWindowCursors } = host.core;
  const providerOf = (botId: string): string =>
    botId ? `${providerPrefix}:${botId}` : providerPrefix;
  /**
   * 每 lane 的增量游标(上次拼装到的窗口行 id)。内存态只作热缓存, 持久事实在
   * hook_group_context_cursors; 重启后首次触发从本地 DB 恢复增量语义。
   */
  const contextCursors = new Map<string, number>();

  return {
    providerPrefix,
    providerOf,
    async record(entry) {
      await recordGroupWindowEntry(
        {
          provider: providerOf(entry.botId),
          chatId: entry.chatId,
          threadId: entry.threadId,
          messageId: entry.messageId,
          chatName: entry.chatName,
          author: entry.author,
          text: entry.text,
          fileNames: entry.fileNames,
          sentAt: entry.sentAt,
        },
        retention,
      );
    },
    buildContextPrefix(args) {
      const cursorKey = `${args.botId}:${args.chatId}:${args.cursorScope ?? args.threadId}`;
      return assembleGroupWindowContext({
        provider: providerOf(args.botId),
        chatId: args.chatId,
        threadId: args.threadId,
        cursors: contextCursors,
        cursorKey,
        triggerMessageId: args.triggerMessageId,
        neutralize: neutralizeFenceTags,
        log,
      });
    },
    resetCursors(resetOptions) {
      return resetGroupWindowCursors({
        cursors: contextCursors,
        providerPrefixes: [`${providerPrefix}:`],
        providerNames: [providerPrefix],
        ...(resetOptions?.clearPersisted === false ? { clearPersisted: false } : {}),
      });
    },
    async listKnownGroups(botId) {
      if (!botId) return [];
      return host.listKnownGroups(providerOf(botId));
    },
  };
}

/** 渠道显示名(发言人/群名)消毒: 平台可改字段是不可信输入, 去控制字符与换行。 */
export function sanitizeGroupWindowName(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .trim()
    .slice(0, 64);
}
