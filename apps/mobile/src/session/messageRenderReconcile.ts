import type { NormalizedRemoteMessage } from '@/session/messageNormalize';
import type {
  MobileMessageRenderItem,
  MobileWorkChildItem,
} from '@/session/messageRenderModel';
import type { RemoteMessage } from '@/session/types';
import { deepValueEqual } from '@/utils/valueEquality';

type ReconciledRenderItem = MobileMessageRenderItem | MobileWorkChildItem;

/**
 * Reuse semantically unchanged message-row view models between render-model rebuilds.
 *
 * The normalizer intentionally rebuilds the whole loaded window whenever the store
 * publishes a text delta. Without this reconciliation, every row receives a fresh
 * `item` (and fresh derived attachment arrays), so `RenderItemView`'s memo boundary is
 * defeated even though only the trailing assistant message changed.
 *
 * Matching is O(n) per sibling list. The common delta path compares unchanged source
 * messages by reference; deep comparison is only the fallback for authoritative window
 * refreshes that deserialize unchanged history into new objects.
 */
export function reconcileMobileMessageRenderItems(
  previous: readonly MobileMessageRenderItem[],
  next: readonly MobileMessageRenderItem[],
  stablePrefixItemCount = 0,
): readonly MobileMessageRenderItem[] {
  return reconcileRenderItemList(
    previous,
    next,
    stablePrefixItemCount,
  ) as readonly MobileMessageRenderItem[];
}

function reconcileRenderItemList<T extends ReconciledRenderItem>(
  previous: readonly T[],
  next: readonly T[],
  stablePrefixItemCount = 0,
): readonly T[] {
  if (next.length === 0) return previous.length === 0 ? previous : next;
  const trustedPrefixLength = Math.max(
    0,
    Math.min(stablePrefixItemCount, previous.length, next.length),
  );
  const previousByKey = new Map<string, T>();
  for (let index = trustedPrefixLength; index < previous.length; index += 1) {
    previousByKey.set(previous[index].key, previous[index]);
  }
  // Render-model builders hand this reconciler a fresh array. Reconcile its dirty tail in place so
  // a token update does not allocate another full-history array merely to reuse prior row objects.
  const reconciled = next as unknown as T[];
  for (let index = trustedPrefixLength; index < reconciled.length; index += 1) {
    const item = reconciled[index];
    reconciled[index] = reconcileRenderItem(previousByKey.get(item.key), item) as T;
  }
  let allReconciledItemsUnchanged = previous.length === reconciled.length;
  for (
    let index = trustedPrefixLength;
    allReconciledItemsUnchanged && index < reconciled.length;
    index += 1
  ) {
    if (reconciled[index] !== previous[index]) allReconciledItemsUnchanged = false;
  }
  if (allReconciledItemsUnchanged) {
    return previous;
  }
  return reconciled;
}

function reconcileRenderItem(
  previous: ReconciledRenderItem | undefined,
  next: ReconciledRenderItem,
): ReconciledRenderItem {
  if (!previous || previous.type !== next.type || previous.key !== next.key) return next;

  switch (next.type) {
    case 'message': {
      const prior = previous as Extract<ReconciledRenderItem, { type: 'message' }>;
      const message = reconcileNormalizedMessage(prior.message, next.message);
      return message === prior.message ? prior : { ...next, message };
    }
    case 'thinking': {
      const prior = previous as Extract<ReconciledRenderItem, { type: 'thinking' }>;
      const message = reconcileNormalizedMessage(prior.message, next.message);
      if (
        message === prior.message
        && prior.durationMs === next.durationMs
        && prior.redacted === next.redacted
      ) {
        return prior;
      }
      return message === next.message ? next : { ...next, message };
    }
    case 'tool_group': {
      const prior = previous as Extract<ReconciledRenderItem, { type: 'tool_group' }>;
      const tools = reconcileNormalizedMessageList(prior.tools, next.tools);
      return tools === prior.tools ? prior : { ...next, tools: [...tools] };
    }
    case 'tool_media': {
      const prior = previous as Extract<ReconciledRenderItem, { type: 'tool_media' }>;
      const tools = reconcileNormalizedMessageList(prior.tools, next.tools);
      return tools === prior.tools ? prior : { ...next, tools: [...tools] };
    }
    case 'todo': {
      const prior = previous as Extract<ReconciledRenderItem, { type: 'todo' }>;
      return prior.createdAt === next.createdAt
        && prior.isStreaming === next.isStreaming
        && deepValueEqual(prior.todos, next.todos)
        ? prior
        : next;
    }
    case 'agent_task': {
      const prior = previous as Extract<ReconciledRenderItem, { type: 'agent_task' }>;
      const toolCall = prior.toolCall && next.toolCall
        ? reconcileNormalizedMessage(prior.toolCall, next.toolCall)
        : next.toolCall;
      if (
        prior.createdAt === next.createdAt
        && toolCall === prior.toolCall
        && deepValueEqual(prior.update, next.update)
      ) {
        return prior;
      }
      return toolCall === next.toolCall ? next : { ...next, toolCall };
    }
    case 'work_group': {
      const prior = previous as Extract<ReconciledRenderItem, { type: 'work_group' }>;
      const children = reconcileRenderItemList(prior.children, next.children);
      if (
        children === prior.children
        && prior.durationMs === next.durationMs
        && prior.isStreaming === next.isStreaming
        && prior.startedAtMs === next.startedAtMs
      ) {
        return prior;
      }
      return children === next.children ? next : { ...next, children: [...children] };
    }
    case 'subagent_group': {
      const prior = previous as Extract<ReconciledRenderItem, { type: 'subagent_group' }>;
      const childItems = reconcileMobileMessageRenderItems(prior.childItems, next.childItems);
      if (
        childItems === prior.childItems
        && prior.header.description === next.header.description
        && prior.header.subagentType === next.header.subagentType
        && prior.summary === next.summary
        && prior.status === next.status
        && prior.durationMs === next.durationMs
      ) {
        return prior;
      }
      return childItems === next.childItems ? next : { ...next, childItems: [...childItems] };
    }
    case 'fork_origin': {
      const prior = previous as Extract<ReconciledRenderItem, { type: 'fork_origin' }>;
      return prior.parentSessionId === next.parentSessionId
        && prior.forkedAtMessageId === next.forkedAtMessageId
        ? prior
        : next;
    }
    default:
      // 防御未来新增 render item 类型:即使类型联合扩展后遗漏分支,也不能把
      // undefined 写入列表并让 LegendList 在渲染阶段崩溃。
      return next;
  }
}

function reconcileNormalizedMessageList(
  previous: readonly NormalizedRemoteMessage[],
  next: readonly NormalizedRemoteMessage[],
): readonly NormalizedRemoteMessage[] {
  if (next.length === 0) return previous.length === 0 ? previous : next;
  const previousByKey = new Map(previous.map((message) => [message.key, message] as const));
  const reconciled = next.map((message) => (
    reconcileNormalizedMessage(previousByKey.get(message.key), message)
  ));
  if (
    previous.length === reconciled.length
    && reconciled.every((message, index) => message === previous[index])
  ) {
    return previous;
  }
  return reconciled;
}

function reconcileNormalizedMessage(
  previous: NormalizedRemoteMessage | undefined,
  next: NormalizedRemoteMessage,
): NormalizedRemoteMessage {
  if (!previous || !normalizedMessageEqual(previous, next)) return next;
  return previous;
}

function normalizedMessageEqual(
  previous: NormalizedRemoteMessage,
  next: NormalizedRemoteMessage,
): boolean {
  // attachments / media / diff / modelMismatch / orcaCard / automationOrigin 都是
  // source.content 或 source.agentMeta 的确定性派生值;source 深比较覆盖它们的输入。
  // tool media 的外部结果由 secondaryBody 覆盖。这里不再逐字段 deep compare,避免
  // 每个 delta 对整段附件/媒体 payload 做重复序列化。
  return previous.key === next.key
    && previous.kind === next.kind
    && previous.role === next.role
    && previous.label === next.label
    && previous.body === next.body
    && previous.secondaryBody === next.secondaryBody
    && previous.systemCardType === next.systemCardType
    && previous.align === next.align
    && previous.createdAt === next.createdAt
    && previous.isStreaming === next.isStreaming
    && previous.turnCostUsd === next.turnCostUsd
    && previous.toolSettled === next.toolSettled
    && previous.isTurnFinalAssistant === next.isTurnFinalAssistant
    && previous.isSyntheticTrigger === next.isSyntheticTrigger
    && remoteMessageEqual(previous.source, next.source);
}

function remoteMessageEqual(previous: RemoteMessage, next: RemoteMessage): boolean {
  if (previous === next) return true;
  return previous.id === next.id
    && previous.clientId === next.clientId
    && previous.sessionId === next.sessionId
    && previous.role === next.role
    && previous.toolUseId === next.toolUseId
    && previous.createdAt === next.createdAt
    && previous.systemCardType === next.systemCardType
    && deepValueEqual(previous.content, next.content)
    && deepValueEqual(previous.agentMeta, next.agentMeta)
    && deepValueEqual(previous.mobileToolInputProjection, next.mobileToolInputProjection)
    && deepValueEqual(previous.systemCardData, next.systemCardData);
}
