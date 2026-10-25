/**
 * main/im/telegram/groupWindow.ts
 * ---------------------------------------------------------------------------
 * 个人 Telegram bot 的群消息本地窗口 — hook-control/groupWindow.ts
 * (group-relay-v1, PR #843)的直连版移植。最初为本地快速迭代沙盒而刻意
 * 保持独立副本; #1855 L0 收敛后, 窗口/游标/预算/栅栏复用 shared 核心,
 * 渠道差异仍留在本调用侧。
 *
 * 与官方版的差异(全部源于"直连没有 relay 帧"):
 *   - 数据来源: TelegramIM.onGroupWindowMessage(本地 getUpdates 直收 +
 *     自身出站回流), 不是 server 转发的 group.message 帧;
 *   - lane 定位: 直接用 chatId/threadId 字段, 无 externalKey 字符串解析;
 *   - 存储复用 hookGroupMessages 表, provider='telegram-personal' 与官方
 *     行(provider='telegram')隔离 — 同一个群里官方 bot 与个人 bot 并存时
 *     (调试期的常态)两套窗口互不污染。
 */

import type { TelegramGroupWindowEntry } from '@cindy/im';

import { createChannelGroupWindow } from '../shared/channelGroupWindow';
import {
  DEFAULT_GROUP_WINDOW_RETENTION,
  type GroupContextAssembly,
} from '../shared/groupWindowCore';
import { createLogger } from '../../logger';

const log = createLogger('telegram-group-window');

/** 窗口行的 provider 列值 — 与官方通道('telegram')隔离。 */
export const TELEGRAM_PERSONAL_WINDOW_PROVIDER = 'telegram-personal';

/**
 * 个人 bot 这一侧生效的保留上限 —— 数值与官方同源, 但**这份对象是个人独有的**。
 *
 * 个人 bot 的群里允许非主人使用(受限权限), 消息量只会比官方那边更大, 所以同样
 * 需要这道闸。额度按 provider 命名空间(`telegram-personal:<botId>`)独立计算, 与
 * 官方的 `telegram:<principalId>` 各是各的一块 —— 换绑不同 bot 也各自独立。
 *
 * 做成可变对象只为让测试用小阈值把回收逼出来。
 */
export const TELEGRAM_PERSONAL_GROUP_WINDOW_RETENTION = { ...DEFAULT_GROUP_WINDOW_RETENTION };

/**
 * provider 按 bot 命名空间(`telegram-personal:<botId>`): 换绑不同 bot 后,
 * 新 bot 的上下文注入与设置卡群清单不掺前任 bot 的历史(review P1)。
 * 官方 hook 通道的旧行清扫只精确删除 provider='telegram'，不会命中本命名空间。
 * 命名空间、游标与群清单查询由渠道无关的 shared/channelGroupWindow 承担。
 */
const telegramWindow = createChannelGroupWindow({
  providerPrefix: TELEGRAM_PERSONAL_WINDOW_PROVIDER,
  retention: TELEGRAM_PERSONAL_GROUP_WINDOW_RETENTION,
  log,
});

/**
 * 存储的保留边界(Chris 2026-07-30 定方向 / 2026-08-08 定判据)。**不是"永不删"**,
 * 准确说是两条:
 *
 *   1. **没有日常清理**: 不做 TTL, 也不按"每群保留最近 N 条"逐群裁剪。Telegram bot
 *      没有别的聊天记录来源, 本地群消息库就是它的记忆, 按条数裁会在活跃群里几天就
 *      把去年的内容挤没(与主流 agent 产品同理念)。
 *   2. **但有容量安全阀, 且它会自动删**: 下面确实向共享核心传了
 *      `TELEGRAM_PERSONAL_GROUP_WINDOW_RETENTION`。同一 provider 命名空间的正文超过
 *      1 GiB 或行数超过 500 万时, `recordGroupWindowEntry` 会**自动回收最旧的记录**
 *      (收敛到 90% 低水位)。日常量级碰不到它, 但"只在用户明确要求时才删"这句话是
 *      不成立的 —— 撞到阀值就是自动删, 不问用户。
 *
 * 单条正文截断与每轮 4000 字注入预算是 prompt 预算, 与上面两条无关, 不是存储上限。
 *
 * (本注释早期版本写的"永久保留, 通过不向共享核心传 retention 表达"已作废: 下一行
 * 就传了。)
 */

/** 入窗(幂等: 同 (provider,chat,thread,message) 唯一键重复插入直接忽略)。 */
export async function recordTelegramGroupMessage(entry: TelegramGroupWindowEntry): Promise<void> {
  await telegramWindow.record(entry);
}

export { buildTelegramReplyContextBlock, buildTelegramHistoryMediaNote } from '@cindy/im-runtime/channels/telegram/groupContext';

export type TelegramGroupContextAssembly = GroupContextAssembly;

/**
 * 为一次群 lane 触发组装本地群上下文前缀。窗口为空返回空前缀(commit 仍可能
 * 推进游标 — 窗口里只剩触发消息自己时也要前移)。
 */
export async function buildTelegramGroupContextPrefix(args: {
  botId: string;
  chatId: string;
  /** 窗口维度(topic id 或 '' 主群流) — 普通群 reply 链共享主群流窗口。 */
  threadId: string;
  /**
   * 游标命名空间(缺省 = threadId)。只能传稳定、低基数的 lane scope；不得传
   * messageId/requestId/turnId 等逐消息高基数值，否则会制造无界游标行。
   */
  cursorScope?: string;
  /** 触发消息的 Telegram 原生 message id — 从上下文中精确剔除"当前消息"。 */
  triggerMessageId: string;
}): Promise<TelegramGroupContextAssembly> {
  return telegramWindow.buildContextPrefix(args);
}

/** 测试与登出清理: 只清理个人 Telegram provider 的内存态与持久游标。 */
export function resetTelegramGroupContextCursors(options?: {
  clearPersisted?: boolean;
}): Promise<void> {
  return telegramWindow.resetCursors(options);
}

/**
 * 设置卡「群聊」节的数据源: **当前 bot** 见过的群(窗口表 distinct chat),
 * 按最近活跃排序。provider 按 bot 命名空间过滤 — 换绑后不列前任 bot 的群。
 */
export async function listTelegramKnownGroups(
  botId: string,
): Promise<Array<{ chatId: string; chatName: string | null }>> {
  return telegramWindow.listKnownGroups(botId);
}
