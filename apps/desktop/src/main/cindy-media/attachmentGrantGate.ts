/**
 * attachmentGrantGate — ghost 附件过户的账本出生闸。
 * ---------------------------------------------------------------------------
 * 回答一个策略问题:"这个总仓 blob 允不允许被过户给意识、以什么出生记账"。
 * 独立于 ledger.ts:ledger 保持中性的记账/查询原语,过户策略绑定的是
 * capability-permissions §4 的授权模型,变更节奏不同。
 *
 * 闸的规则:总仓 blob 形态的附件必须有 session-attachment 引用(= 进过
 * 聊天流:用户发的媒体,或当前 Agent 的 Core 工具结果在返回前同步挂账)才可过户;纯画廊
 * 产物(别的意识的作品,从未进过聊天)与无账孤儿文件一律拒——媒体总仓
 * 不是公共相册,本模块不开放跨意识读取。过户行的出生按真实
 * 来源记:用户附件 'user'、会话内生成媒体 'tool';同内容多行时 'user' 优先
 * (被用户亲手发过 = 更高的授权语义);历史行 originKind 为空按 'user'
 * (与 commitChatImageUrls 的缺省语义一致)。
 */

import { and, eq } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current';
import { mediaRefs } from '../localDb/schema';
import type { LedgerDb } from './ledger.js';

function defaultDb(): LedgerDb {
  return getDbClient().drizzle;
}

/**
 * 查某指纹作为聊天流附件的出生;无 session-attachment 引用返回 null =
 * 调用方拒绝过户。
 */
export async function chatAttachmentOrigin(
  hash: string,
  db: LedgerDb = defaultDb(),
): Promise<'user' | 'tool' | null> {
  const rows = await db
    .select({ originKind: mediaRefs.originKind })
    .from(mediaRefs)
    .where(and(eq(mediaRefs.hash, hash), eq(mediaRefs.refKind, 'session-attachment')))
    .all();
  if (rows.length === 0) return null;
  if (rows.some((r) => r.originKind === 'user' || r.originKind == null)) return 'user';
  return 'tool';
}
