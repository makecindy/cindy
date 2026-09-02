/**
 * 伙伴记忆的展示分域:设置页「TA 记得的 / TA 学会的」两个列表的纯判定层。
 *
 * 分域已经由 Bot Memory 作用域做好:bot 会话的 `makerMemoryScopeKey` 恒为
 * `buildBotMemoryScopeKey(botId)`,所以这里看到的每一条分片都落在这个伙伴
 * 自己的记忆空间里,不会串到 workdir 记忆。
 */

import type { MemoryRecord } from '@cindy/maker-core';

/**
 * 「本事」的落点约定。
 *
 * makerMemory 有 type 概念(user / feedback / project / reference / digest),但
 * 没有一个语义等同于「TA 自己长出来的可复用做法」的类型:`feedback` 是用户给
 * 的反馈偏好,那属于「TA 记得的」。所以不新造存储、也不改 type 枚举,改用
 * **slug 前缀约定**:`learned-*` 的分片计入「TA 学会的」,其余计入「TA 记得的」。
 *
 * 前缀用连字符而不是下划线是有原因的:文件名是 `<type>_<slug>.md`,storage 的
 * `validateNoTypePrefix` 会拒绝以 `<type>_` 开头的 slug,连字符绕开该校验。
 */
export const LEARNED_MEMORY_SLUG_PREFIX = 'learned-';

export function isLearnedMemorySlug(slug: string): boolean {
  return slug.startsWith(LEARNED_MEMORY_SLUG_PREFIX);
}

/**
 * 把伙伴记忆分片切成设置页并排的两个列表。
 *
 * `digest` 两边都不进:它是系统内部压缩摘要,不进 MEMORY.md 索引,对用户既不是
 * 「记得的事」也不是「学会的本事」,但仍然继续被检索使用 —— 只是不展示。
 */
export function partitionBotMemoryRecords(records: readonly MemoryRecord[]): {
  memories: MemoryRecord[];
  learned: MemoryRecord[];
} {
  const memories: MemoryRecord[] = [];
  const learned: MemoryRecord[] = [];
  for (const record of records) {
    if (record.frontmatter.type === 'digest') continue;
    if (isLearnedMemorySlug(record.slug)) learned.push(record);
    else memories.push(record);
  }
  return { memories, learned };
}
