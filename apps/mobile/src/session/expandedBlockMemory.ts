/**
 * expandedBlockMemory (mobile)
 * ---------------------------------------------------------------------------
 * 会话消息流各折叠卡(thinking / tool_group / agent_task / work_group /
 * subagent_group)的展开态进程内记忆,与桌面 useExpandedBlockMemory 同一语义,
 * 核心实现在 `@cindy/maker-shared/expanded-block-memory`:
 *
 *   - 默认全部折叠;用户手动展开的卡在 App 运行期内被记住——FlatList 虚拟化
 *     把卡片滚出屏幕再滚回来、切会话往返、turn 收口后卡片被归入 work_group
 *     (render item 的 key 不变)都不丢。
 *   - 有意不持久化:App 重启即回到全折叠(与桌面一致,持久化会让工具块
 *     一开场就展开,太吵)。
 *
 * blockId 直接用 render item 的 key(`thinking-<clientId>` / `tools-<clientId>`
 * / `task-<id>` / `work-<childKey>` / subagent key),由 clientId 派生、跨重分组稳定。
 */

import { useCallback, useState, useSyncExternalStore } from 'react';
import { createExpandedBlockStore } from '@cindy/maker-shared/expanded-block-memory';

// 订阅者异常不静默吞掉(与桌面 log.warn 对齐);mobile 无统一 logger,
// 沿用既有 console.* + tag 前缀日志约定(见 assertNever.logUnhandledRenderItem)。
const store = createExpandedBlockStore({
  onSubscriberError: (error) => console.warn('[expanded-block-memory] subscriber error:', error),
});

/**
 * FoldablePanel 的展开态入口:传 blockId 走共享记忆(默认折叠、进程内记住),
 * 不传(null/undefined)回退本地 state(TodoCard / Orca 协同卡这类默认展开、
 * 无需记忆的卡)。两条路径都无条件走各自的 hook,规避条件调用。
 *
 * ⚠️ blockId 非空时 `defaultExpanded` 不参与:展开态完全由共享记忆决定
 * (未记忆过 = 折叠),该参数只服务于无 blockId 的本地 state 路径。
 * 需要"默认展开"的卡(Todo / Orca)不要传 blockId。
 */
export function useFoldableExpandedState(
  blockId: string | null | undefined,
  defaultExpanded: boolean,
): [boolean, () => void] {
  const [localExpanded, setLocalExpanded] = useState(defaultExpanded);
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(listener),
    [],
  );
  const rememberedExpanded = useSyncExternalStore(
    subscribe,
    () => (blockId ? store.isExpanded(blockId) : false),
  );
  const expanded = blockId ? rememberedExpanded : localExpanded;
  const toggleExpanded = useCallback(() => {
    if (blockId) {
      store.setExpanded(blockId, !store.isExpanded(blockId));
    } else {
      setLocalExpanded((value) => !value);
    }
  }, [blockId]);
  return [expanded, toggleExpanded];
}

export function isFoldableBlockExpanded(blockId: string): boolean {
  return store.isExpanded(blockId);
}

/**
 * 订阅一组折叠卡的展开态；只在这些 block 的布尔快照变化时触发消费方重渲染。
 * 空数组快照恒定，因此非分享态不会因任意卡片展开而重渲染会话页。
 */
export function useFoldableExpandedBlocksSnapshot(
  blockIds: readonly string[],
): string {
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(listener),
    [],
  );
  const getSnapshot = useCallback(
    () => blockIds.map((blockId) => (store.isExpanded(blockId) ? '1' : '0')).join(''),
    [blockIds],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ── Test internals ──────────────────────────────────────────────────────────
// 仅供单测使用,生产代码不要消费。

export const __test_internals = {
  reset(): void {
    store.reset();
  },
  setExpanded(blockId: string, expanded: boolean): void {
    store.setExpanded(blockId, expanded);
  },
  isExpanded(blockId: string): boolean {
    return store.isExpanded(blockId);
  },
};
