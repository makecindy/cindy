/**
 * sessionDisplayTitle —— 会话标题「存储值 → 显示值」的单一来源。
 *
 * 会话的 `title` 列身兼两职:既是用户可见标题,又是「尚未起名」的哨兵
 * (`DEFAULT_DRAFT_SESSION_TITLE`)。哨兵必须保持 locale-independent 的英文字面量
 * (跨设备 / 跨语言逐字比对 + 条件写的期望值,详见 `@cindy/maker-shared/session-title`),
 * 所以**本地化只能发生在显示层** —— 也就是这里。
 *
 * 显示层此前散落着三份 `session.title === 'New Maker' && messages === 0` 的硬编码
 * 判定(侧边栏行 / 卡片 / 会话头),既容易漏,也让英文哨兵直接漏到界面上。
 */

import { isDefaultDraftSessionTitle } from '@cindy/maker-shared/session-title';

import type { Session } from '@/lib/ccAgent.types';

import {
  getAutomationSessionDisplayTitle,
  isScheduledSession,
  SCHEDULE_TITLE_PREFIX,
} from './scheduledSessionGrouping';

/**
 * 「空草稿会话」—— 标题仍是哨兵且一条消息都没有。
 *
 * 用于操作菜单收窄成 Draft 变体(Rename / Copy ID / Delete):没有内容的会话谈不上
 * 归档、导出、分享。**刻意要求零消息**,与显示兜底的判定口径不同(见
 * {@link getSessionDisplayTitle} 的说明)。
 */
export function isEmptyDraftSession(session: Session): boolean {
  return isDefaultDraftSessionTitle(session.title) && (session._count?.messages ?? 0) === 0;
}

/**
 * 会话在侧边栏 / 卡片 / 会话头 / tab 上应该显示的标题。
 *
 * `unnamedLabel` 传已解析的 i18n 文案(`ccAgent.common.unnamedSession`)——与
 * `autoTitleFallbackLabels()` 同款:纯函数不碰 i18n 实例,好测也好复用。
 *
 * 兜底条件**只看标题是不是哨兵、不看消息数**,比 {@link isEmptyDraftSession} 更宽:
 * 自动起名失败(离线 / 模型不可用)或纯附件首条消息连描述都合成不出来时,会话有消息
 * 但标题仍停在哨兵上。那种情况照样不能把英文哨兵漏给用户看。
 *
 * **已知代价(明确取舍,不是漏判)**:用户如果手动把标题改成字面量 `New Maker`,这里
 * 也会显示成兜底文案。要区分「用户写的这个串」与「建会话时的哨兵」,只能给标题带上
 * provenance —— 而 main 的 `manuallyRenamed` 是进程内存态、不落库、不过 device-link,
 * renderer 无从得知。真要支持得先持久化一个 `titleSource` 位,再把它透到桌面 / 共享列表 /
 * 搜索 / mobile 四处投影,并进跨端 wire protocol。换来的只是「有人刻意把对话命名为内部
 * 英文占位、且在意它逐字显示」这一种情形;而放宽条件换掉的是自动起名失败时英文哨兵
 * 直接漏给用户看 —— 那是本 PR 存在的理由。故按现状取舍(PR #1031 review,第 11 轮)。
 */
export function getSessionDisplayTitle(session: Session, unnamedLabel: string): string {
  if (isDefaultDraftSessionTitle(session.title)) return unnamedLabel;
  return getAutomationSessionDisplayTitle(session);
}

/**
 * 把用户在重命名输入框里编辑的结果还原成**可落库的存储标题**。
 *
 * 存在的理由:`getSessionDisplayTitle` 是**只读投影** —— 它对 legacy automation 会话
 * 剥掉了 `[Schedule] ` 前缀、对未起名会话把哨兵换成了兜底文案。重命名预填用的是这个
 * 投影值(否则输入框里会出现内部前缀或英文哨兵),因此提交时必须把变换还原回去,否则
 * 写进 DB 的是**投影后**的串:
 *
 *   - legacy automation 会话(只靠 `[Schedule] ` 前缀识别、没有 `source='scheduler'`)
 *     一旦被存成无前缀标题,`isAutomationGeneratedSession` 再也认不出它,会话就从
 *     automation 分组和相关 UI 里消失(PR #1031 review P1)。
 *   - 哨兵会话若被存成兜底文案,自动起名的哨兵匹配失效、永久跳过该会话。后者由调用方
 *     的「没改就不落库」判据挡住(编辑结果等于预填值时直接 return),这里只负责前缀。
 *
 * 新数据带 `source='scheduler'`,不依赖前缀,所以只需给仍带前缀的行补回去。
 */
export function toStoredSessionTitle(session: Session, editedTitle: string): string {
  if (!isScheduledSession(session)) return editedTitle;
  // 用户手动把前缀打回来了(或压根没删)→ 不重复叠加。
  if (editedTitle.startsWith(SCHEDULE_TITLE_PREFIX)) return editedTitle;
  return `${SCHEDULE_TITLE_PREFIX}${editedTitle}`;
}

/**
 * 模糊搜索命中高亮能否直接套在显示标题上。
 *
 * `matchIndices` 是搜索在**原始** `session.title` 上算出的下标
 * (见 `lib/sessionSearch.ts` 的 `fuzzyFilterAndRank`),显示串一旦与原串不同,下标
 * 就会错位、把高亮画到别的字上。两种情况必须关掉高亮:
 *
 *   - `[Schedule] xxx` 前缀被剥掉(既有 case);
 *   - 哨兵标题被换成本地化的「未命名对话」(本次新增,同一个坑)。
 */
export function canHighlightSessionDisplayTitle(session: Session): boolean {
  return !isScheduledSession(session) && !isDefaultDraftSessionTitle(session.title);
}
