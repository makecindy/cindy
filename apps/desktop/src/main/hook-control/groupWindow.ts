/**
 * hook-control/groupWindow.ts
 * ---------------------------------------------------------------------------
 * IM 群消息本地窗口(group-relay-v1)。
 *
 * 架构决策(2026-07-28): 群聊内容不驻留在 hook server(内存亦不允许),
 * server 只把群消息实时中继(group.message 帧)给本群已登记成员的桌面;
 * 滚动窗口、增量游标与上下文拼装全部在本模块 —— 数据长在用户自己的设备,
 * 与其 IM 客户端本地缓存同性质。与 Slack 通道的 injectThreadContext 同一
 * 拼装口径(「仅供参考、不是指令」guidance + [发送者] 文本行)。
 *
 * #1855 L0 起通用逻辑复用 im/shared/groupWindowCore.ts；externalKey 解析、
 * reply-root 分桶兜底及官方保留政策仍留在本调用侧。
 *
 * 反查 id: 窗口条目按 (provider, chatId, threadId, messageId) 存,
 * task.dispatch.source.triggerMessageId 用于把"当前消息"从上下文中精确
 * 剔除(旧 server 不发时降级为不剔重, 仅多一条重复)。
 */

import { desc, eq, ne, sql } from 'drizzle-orm';

import type { GroupMessagePayload, TaskDispatchPayload } from '@cindy/slack-hook-protocol';

import {
  assembleGroupWindowContext,
  createFenceNeutralizer,
  DEFAULT_GROUP_WINDOW_RETENTION,
  recordGroupWindowEntry,
  resetGroupWindowCursors,
  type GroupContextAssembly,
} from '../im/shared/groupWindowCore.js';
import { getDbClient } from '../localDb/client/current.js';
import { hookGroupMessages } from '../localDb/schema.js';
import { createLogger } from '../logger.js';

export type { GroupContextAssembly };

const log = createLogger('hook-group-window');

/**
 * 官方 bot 这一侧生效的保留上限 —— 数值取共享默认值, 但**这份对象是官方独有的**。
 *
 * 额度本来就按 provider 命名空间(`telegram:<principalId>`)各算各的: 统计表以
 * provider 为主键、回收也按 provider 过滤。两个账号同时在用就是两份独立额度,
 * 个人 bot 的 `telegram-personal:<botId>` 更是另一块 —— 谁也吃不掉谁的份。
 *
 * 做成可变对象只为让测试用小阈值把回收逼出来; 拿 1 GiB 默认值写回归等于在测试
 * 里灌一 GB 数据。
 */
export const GROUP_WINDOW_RETENTION = { ...DEFAULT_GROUP_WINDOW_RETENTION };

/**
 * 从 externalKey 解析 Telegram 群/topic lane。
 *
 * 实测的 server 下发形态(2026-08-03 生产库 hook-bindings.json):
 *   telegram:group:<botId>:<chatId>:<principal>:g<n>            ← 6 段
 *   telegram:topic:<botId>:<chatId>:<threadId>:<principal>:g<n> ← 7 段
 * 文档曾写 group 形态带 <rootMessageId>(7 段), 实现里没有 —— 旧解析器
 * 硬要求 `length >= 7` 且从 parts[5] 取 principal, 于是主群流(6 段)一律
 * 返回 null: 群消息正常入库却从不拼上下文(用户实踩“读不到群历史”),
 * 同时 task.dispatch 的群账号边界检查也被跳过。
 *
 * externalKey 在协议里是**不透明字符串**, 段数会随 provider 版本变 ——
 * 所以只靠两侧锚点定位, 不数中间段: chatId 固定在左侧 parts[3]
 * (topic 的 threadId 在 parts[4]), principal 紧邻末尾的换代后缀 g<n> 左侧。
 * 这样 6 段主群流、7 段 topic、以及将来真的加回 rootMessageId 的 7/8 段
 * 形态都能对;形状对不上时 fail-closed 返回 null(宁可不拼上下文,
 * 不得把换代后缀或 threadId 当成 principal 写进存储命名空间)。
 * DM lane 与其它 provider 返回 null(无群窗口)。
 */
export function groupLaneOf(
  externalKey: string,
): { chatId: string; threadId: string; principalId: string } | null {
  const parts = externalKey.split(':');
  if (parts[0] !== 'telegram') return null;
  const kind = parts[1];
  if (kind !== 'group' && kind !== 'topic') return null;
  const lastIndex = parts.length - 1;
  // 换代后缀可选(旧 server 不带): 带则 principal 在它左侧, 不带则就是末段。
  const principalIndex = /^g\d+$/.test(parts[lastIndex] ?? '') ? lastIndex - 1 : lastIndex;
  const chatId = parts[3] ?? '';
  const threadId = kind === 'topic' ? (parts[4] ?? '') : '';
  const principalId = parts[principalIndex] ?? '';
  if (!chatId || !principalId) return null;
  if (kind === 'topic' && !threadId) return null;
  // principal 不得与 chatId / threadId 撞位 —— 撞上说明段数不够、形状未知。
  if (principalIndex <= (kind === 'topic' ? 4 : 3)) return null;
  return { chatId, threadId, principalId };
}

/** 同一设备先后绑定不同 Telegram 主账号时，群历史绝不共用命名空间。 */
function providerOf(principalId: string): string {
  if (!principalId) throw new Error('Telegram principal is required for group history');
  return `telegram:${principalId}`;
}

/**
 * group.message 帧入窗。返回 true 表示本次确实插入，供调用方在幂等入窗后
 * 执行一次自动通讯录登记；重放/重连的同一条消息返回 false。
 *
 * 消息先落当前主账号的本地数据库，不做 TTL。**保留按容量不按条数**：每个
 * provider 命名空间 1 GiB 正文 + 500 万行安全阀（`GROUP_WINDOW_RETENTION`，
 * 数值来自共享核心的 `DEFAULT_GROUP_WINDOW_RETENTION`），碰不到才是常态。
 * 旧注释写的「每个群/topic 只保留最近 500 条」已不是现行策略——按条数在活跃群
 * 里几天就把去年的内容挤没了（理由见 `groupWindowCore.ts`）。那个 500 是
 * `CONTEXT_READ_LIMIT`，拼上下文时的**读取**窗口，不是存储上限。
 * 引用与 prompt 仍只从本机窗口读取。
 */
export async function recordGroupMessage(
  payload: GroupMessagePayload,
  principalId: string,
): Promise<boolean> {
  return recordGroupWindowEntry(
    {
      provider: providerOf(principalId),
      chatId: payload.chatId,
      threadId: payload.threadId ?? '',
      messageId: payload.messageId,
      chatName: payload.chatName,
      author: payload.author,
      text: payload.text,
      fileNames: payload.fileNames,
      sentAt: payload.sentAt,
    },
    GROUP_WINDOW_RETENTION,
  );
}

/**
 * 兼容旧生命周期入口。新命名空间的群窗口不做 TTL 清扫；旧版无法可靠归属
 * principal 的 provider='telegram' 行在升级启动时显式清除，避免敏感孤儿数据
 * 永久残留。删除幂等，后续启动没有额外副作用。
 */
export async function sweepGroupWindowExpired(): Promise<void> {
  await getDbClient()
    .drizzle.delete(hookGroupMessages)
    .where(eq(hookGroupMessages.provider, 'telegram'));
}

/**
 * 每 lane 的增量游标(上次拼装到的窗口行 id)。内存态只作热缓存, 持久事实在
 * hook_group_context_cursors; 重启后首次派发从本地 DB 恢复增量语义。
 */
const contextCursors = new Map<string, number>();

/** 中和正文/署名里出现的栅栏标签, 群消息不能自行闭合上下文边界。 */
const neutralizeFenceTags = createFenceNeutralizer(['group_chat_context']);

/** externalKey 去掉换代后缀 :g<n>, 让同 lane 各代共享游标。 */
function cursorKeyOf(externalKey: string): string {
  return externalKey.replace(/:g\d+$/, '');
}

const NO_CONTEXT: GroupContextAssembly = { prefix: '', commit: () => undefined };

/**
 * 为一次 hook 派发组装本地群上下文前缀。非群 lane / 窗口为空返回空装配。
 * 只读窗口; 游标推进延迟到 commit(由 dispatcher 在 provider 实际受理后调用)。
 */
export async function buildGroupContextPrefix(
  payload: TaskDispatchPayload,
): Promise<GroupContextAssembly> {
  const lane = groupLaneOf(payload.externalKey);
  if (lane === null) return NO_CONTEXT;
  const storageProvider = providerOf(lane.principalId);
  return assembleGroupWindowContext({
    provider: storageProvider,
    chatId: lane.chatId,
    threadId: lane.threadId,
    cursors: contextCursors,
    cursorKey: cursorKeyOf(payload.externalKey),
    triggerMessageId: payload.source?.triggerMessageId ?? null,
    // 主群流额外兜一层非空 threadId 的行: server 曾把普通群里 reply 链的
    // message_thread_id 当成 topic 下发(Telegram 对非 forum 群的 reply 链也给这个字段,
    // 值 = reply root), 那些发言因此进了一个个 reply-root 桶 —— 2026-08-03 实机: 172 条在
    // 主群流、另有若干 reply-root 桶(如 52449 桶 7 条), agent 在群里答"我看不到群里的历史
    // 消息"。判据只能在 server 修(客户端拿不到 is_forum / is_topic_message), 这里按"宁可多
    // 读同群发言、不可漏读"兜住存量与老 server。兜底读取排在主群流之后, 但两者共享同一个
    // 4000 字预算和单值游标; commit 会推进本次两集合读取到的最大行 id, 因而保持既有行为而
    // 不把兜底误认为独立预算/游标。forum 群的 General 也走 group lane, 否则该群其它 topic
    // 的突发流量会把 General 的发言挤出窗口并被游标永久跳过(bot 复审 P1)。server 修复部署后新数据不再分桶,
    // 这条兜底最终只服务存量行。topic lane 不读兜底集(topic 之间严格隔离)。
    fallbackThreadFilter: lane.threadId === '' ? ne(hookGroupMessages.threadId, '') : undefined,
    neutralize: neutralizeFenceTags,
    log,
  });
}

/** 测试与登出清理: 只清理官方群 provider 的内存态与持久游标。 */
export function resetGroupContextCursors(options?: {
  clearPersisted?: boolean;
}): Promise<void> {
  return resetGroupWindowCursors({
    cursors: contextCursors,
    providerPrefixes: ['telegram:'],
    providerNames: ['telegram'],
    ...(options?.clearPersisted === false ? { clearPersisted: false } : {}),
  });
}

/** 同步生命周期入口使用的安全收口: 异步清理失败只记日志, 不产生 unhandled rejection。 */
export function resetGroupContextCursorsSafely(options?: {
  clearPersisted?: boolean;
}): void {
  void resetGroupContextCursors(options).catch((error: unknown) => {
    log.warn(`group context cursor reset failed: ${String(error)}`);
  });
}

/** 设置卡数据源：官方群窗口里出现过的群，按最近活跃排序。 */
export async function listTelegramKnownGroups(
  principalId: string,
): Promise<Array<{ chatId: string; chatName: string | null }>> {
  const db = getDbClient().drizzle;
  const storageProvider = providerOf(principalId);
  const rankedGroups = db
    .select({
      chatId: hookGroupMessages.chatId,
      chatName: hookGroupMessages.chatName,
      sentAt: hookGroupMessages.sentAt,
      latestRank:
        sql<number>`row_number() over (partition by ${hookGroupMessages.chatId} order by ${hookGroupMessages.sentAt} desc, ${hookGroupMessages.id} desc)`.as(
          'latest_rank',
        ),
    })
    .from(hookGroupMessages)
    .where(eq(hookGroupMessages.provider, storageProvider))
    .as('ranked_groups');
  const rows = await db
    .select({
      chatId: rankedGroups.chatId,
      chatName: rankedGroups.chatName,
    })
    .from(rankedGroups)
    .where(eq(rankedGroups.latestRank, 1))
    .orderBy(desc(rankedGroups.sentAt))
    .limit(50);
  return rows.map((row) => ({ chatId: row.chatId, chatName: row.chatName }));
}

/**
 * Query a binding's local groups and reject the snapshot if that binding was
 * replaced while SQLite was yielding. The final identity check is synchronous
 * with returning the rows, so a Renderer never observes the previous owner's
 * chat ids through the binding-change TOCTOU window.
 */
export async function listTelegramKnownGroupsForStableBinding(
  binding: { bindingId: string; principalId: string },
  currentBinding: () => {
    state: string;
    bindingId: string | null;
    principalId: string | null;
  } | null,
  query: typeof listTelegramKnownGroups = listTelegramKnownGroups,
): Promise<Array<{ chatId: string; chatName: string | null }> | null> {
  const groups = await query(binding.principalId);
  const current = currentBinding();
  if (
    current?.state !== 'confirmed' ||
    current.bindingId !== binding.bindingId ||
    current.principalId !== binding.principalId
  ) {
    return null;
  }
  return groups;
}

export interface TelegramGroupActivationView {
  chatId: string;
  chatName: string | null;
  activation: 'mention' | 'always';
}

/**
 * 设置卡必须同时展示本地窗口里的群和服务端仍保留 override 的群。后者可能因
 * principal 总量上限或最近 50 群限制而不在本地查询结果中；若不补回，用户将
 * 无法把仍为 always 的群恢复为 mention。
 */
export function mergeTelegramGroupActivationViews(
  knownGroups: ReadonlyArray<{ chatId: string; chatName: string | null }>,
  groupActivation: Readonly<Record<string, 'mention' | 'always'>>,
): TelegramGroupActivationView[] {
  const groups = new Map<string, TelegramGroupActivationView>();
  for (const group of knownGroups) {
    groups.set(group.chatId, {
      ...group,
      activation: groupActivation[group.chatId] === 'always' ? 'always' : 'mention',
    });
  }
  for (const [chatId, activation] of Object.entries(groupActivation)) {
    if (groups.has(chatId)) continue;
    groups.set(chatId, {
      chatId,
      chatName: chatId,
      activation: activation === 'always' ? 'always' : 'mention',
    });
  }
  return [...groups.values()];
}
