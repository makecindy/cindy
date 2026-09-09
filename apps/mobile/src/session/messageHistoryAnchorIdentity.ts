import type {
  MobileMessageRenderItem,
  MobileWorkChildItem,
} from '@/session/messageRenderModel';

type MobileHistoryAnchorItem = MobileMessageRenderItem | MobileWorkChildItem;

/**
 * Aggregate rows are keyed by their first activity, so prepending an older activity from the same
 * turn legitimately replaces the outer key. A leaf message/tool identity survives that regrouping
 * and lets the history transaction recognize the replacement row without changing product grouping.
 */
export function mobileMessageHistoryAnchorIdentity(
  item: MobileHistoryAnchorItem,
): string | undefined {
  switch (item.type) {
    case 'work_group':
      for (const child of item.children) {
        const identity = mobileMessageHistoryAnchorIdentity(child);
        if (identity) return identity;
      }
      return item.key;
    case 'tool_group':
    case 'tool_media':
      return item.tools[0]?.key ?? item.key;
    case 'subagent_group':
      for (const child of item.childItems) {
        const identity = mobileMessageHistoryAnchorIdentity(child);
        if (identity) return identity;
      }
      return item.key;
    default:
      return item.key;
  }
}

/** Find the current top-level row that still contains a captured stable leaf identity. */
export function mobileMessageHistoryRowKeyByIdentity(
  items: readonly MobileMessageRenderItem[],
  identityKey: string,
): string | undefined {
  return items.find((item) => mobileMessageHistoryItemContainsIdentity(item, identityKey))?.key;
}

/**
 * A history page can consist only of earlier activities from the completed turn already shown as
 * the first collapsed `Worked for` row. Its outer key changes, but it remains the first rendered
 * row, so the page added no visible top-level history for the reader. Main continues paging in this
 * case; the app-owned anchor transaction must preserve that behavior after it finishes settling.
 */
export function mobileMessageHistoryOnlyExpandedFirstWorkGroup(
  previousItems: readonly MobileMessageRenderItem[],
  nextItems: readonly MobileMessageRenderItem[],
): boolean {
  const previousFirst = previousItems[0];
  const nextFirst = nextItems[0];
  if (
    previousFirst?.type !== 'work_group'
    || nextFirst?.type !== 'work_group'
    || previousFirst.key === nextFirst.key
  ) return false;
  const identityKey = mobileMessageHistoryAnchorIdentity(previousFirst);
  return identityKey !== undefined
    && mobileMessageHistoryItemContainsIdentity(nextFirst, identityKey);
}

function mobileMessageHistoryItemContainsIdentity(
  item: MobileHistoryAnchorItem,
  identityKey: string,
): boolean {
  if (item.key === identityKey) return true;
  switch (item.type) {
    case 'work_group':
      return item.children.some((child) => (
        mobileMessageHistoryItemContainsIdentity(child, identityKey)
      ));
    case 'tool_group':
    case 'tool_media':
      return item.tools.some((tool) => tool.key === identityKey);
    case 'subagent_group':
      return item.childItems.some((child) => (
        mobileMessageHistoryItemContainsIdentity(child, identityKey)
      ));
    default:
      return false;
  }
}
