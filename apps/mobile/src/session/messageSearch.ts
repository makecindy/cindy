import {
  findMessageSearchHits,
  findTextSearchHit,
  type MessageSearchHit,
} from '@cindy/maker-shared/message-search';
import type { MobileMessageRenderItem, MobileSubagentGroupItem } from '@/session/messageRenderModel';

export {
  nextMessageSearchIndex,
  normalizeMessageSearchIndex,
  type MessageSearchHit as MobileMessageSearchHit,
} from '@cindy/maker-shared/message-search';

/**
 * 顶层搜索流:普通 render item 委托 shared 搜索;子 agent 嵌套卡(subagent_group,mobile-only)递归搜
 * 其 childItems / summary / 派活描述。子 agent 卡是折叠态、非顶层 FlatList 行,嵌套定位还不能精确跳子项,
 * 所以卡内任意命中统一把 itemKey 映射到父卡片 key,靠 scrollToIndex 跳到父卡(命中可见即可,精确定位留待后续)。
 * 每个 subagent_group 最多产一个 hit(与 shared "每个顶层项至多一个 hit" 语义一致),按文档顺序收集。
 */
export function findMobileMessageSearchHits(
  items: readonly MobileMessageRenderItem[],
  query: string,
): MessageSearchHit[] {
  if (!query.trim()) return [];
  const hits: MessageSearchHit[] = [];
  for (const item of items) {
    if (item.type === 'fork_origin') {
      continue;
    }
    // 待发送气泡不进搜索:它还不是会话记录,命中它无法定位/跳转(回流后正式消息会被索引)。
    if (item.type === 'pending_send') {
      continue;
    }
    if (item.type === 'subagent_group') {
      const hit = searchSubagentGroup(item, query);
      if (hit) hits.push(hit);
    } else {
      // 普通顶层项委托 shared(逐项调用以保持与子 agent 卡交错时的文档顺序)。
      const [hit] = findMessageSearchHits([item], query);
      if (hit) hits.push(hit);
    }
  }
  return hits;
}

/** 搜子 agent 卡内可见文本(childItems 递归 / summary / 派活描述),命中统一映射到父卡片 key。 */
function searchSubagentGroup(
  group: MobileSubagentGroupItem,
  query: string,
): MessageSearchHit | null {
  // 内层 render items(可含更深 subagent_group)递归;取第一处命中,itemKey 改写成父卡片 key。
  const [childHit] = findMobileMessageSearchHits(group.childItems, query);
  if (childHit) return { ...childHit, itemKey: group.key };

  // 子 agent 终稿(summary)。
  if (group.summary) {
    const summaryHit = findTextSearchHit(
      {
        itemKey: group.key,
        sourceKey: group.key,
        label: group.header.subagentType ?? 'subagent',
        text: group.summary,
      },
      query,
    );
    if (summaryHit) return summaryHit;
  }

  // 卡头的派活描述。
  if (group.header.description) {
    const headerHit = findTextSearchHit(
      {
        itemKey: group.key,
        sourceKey: group.key,
        label: group.header.subagentType ?? 'subagent',
        text: group.header.description,
      },
      query,
    );
    if (headerHit) return headerHit;
  }

  return null;
}
