export { isRemoteTextDelta, readRemoteTextSnapshot, reconcileRemoteText, consumeRemoteSessionSync } from './remoteTextStream.js';
export * from './historyView.js';
export { projectHistoryView, isHistoryDetailTool, hasVisibleHistoryResult } from './historyViewProjection.js';
export * from './historyViewController.js';
export { renderHistoryView } from './historyViewRender.js';
export { HistoryViewHandoff } from './historyViewHandoff.js';

export interface MessageScrollMetrics {
  contentHeight: number;
  offsetY: number;
  viewportHeight: number;
}

export const DEFAULT_NEAR_BOTTOM_THRESHOLD = 96;
export const DEFAULT_LOAD_EARLIER_THRESHOLD = 96;

export function isNearMessageListBottom(
  metrics: MessageScrollMetrics,
  threshold = DEFAULT_NEAR_BOTTOM_THRESHOLD,
): boolean {
  if (metrics.contentHeight <= metrics.viewportHeight) return true;
  return metrics.offsetY + metrics.viewportHeight >= metrics.contentHeight - threshold;
}

export function isNearMessageListTop(
  metrics: Pick<MessageScrollMetrics, 'offsetY'>,
  threshold = DEFAULT_LOAD_EARLIER_THRESHOLD,
): boolean {
  return metrics.offsetY <= threshold;
}

export function shouldAutoFollowMessages(args: {
  nextLastKey: string | null;
  previousLastKey: string | null;
  wasNearBottom: boolean;
}): boolean {
  if (!args.previousLastKey) return true;
  if (args.previousLastKey === args.nextLastKey) return false;
  return args.wasNearBottom;
}

export function shouldShowNewMessageIndicator(args: {
  nextLastKey: string | null;
  previousLastKey: string | null;
  wasNearBottom: boolean;
}): boolean {
  if (!args.previousLastKey || !args.nextLastKey) return false;
  if (args.previousLastKey === args.nextLastKey) return false;
  return !args.wasNearBottom;
}

export type MessageWindowChangeKind =
  | 'initial'
  | 'unchanged'
  | 'appended-tail'
  | 'prepended-older'
  | 'expanded-both-ends'
  | 'replaced';

export type MessageWindowAutoFollowTarget = 'none' | 'latest-item' | 'content-end';

export interface MessageWindowUpdateDecision {
  kind: MessageWindowChangeKind;
  anchorKey: string | null;
  autoFollowTarget: MessageWindowAutoFollowTarget;
  preserveVisibleAnchor: boolean;
  shouldAutoFollow: boolean;
  showNewMessageIndicator: boolean;
}

export interface MessageLoadEarlierActionPresentation {
  accessibilityLabel: string;
  disabled: boolean;
  label: string;
  visible: boolean;
}

export function evaluateMessageWindowUpdate(args: {
  previousKeys: readonly string[];
  nextKeys: readonly string[];
  wasNearBottom: boolean;
}): MessageWindowUpdateDecision {
  const previousKeys = args.previousKeys;
  const nextKeys = args.nextKeys;
  const previousLastKey = previousKeys[previousKeys.length - 1] ?? null;
  const nextLastKey = nextKeys[nextKeys.length - 1] ?? null;
  const tailChanged = previousLastKey !== nextLastKey;

  if (previousKeys.length === 0) {
    const shouldAutoFollow = nextKeys.length > 0;
    return {
      kind: nextKeys.length === 0 ? 'unchanged' : 'initial',
      anchorKey: null,
      autoFollowTarget: shouldAutoFollow ? 'content-end' : 'none',
      preserveVisibleAnchor: false,
      shouldAutoFollow,
      showNewMessageIndicator: false,
    };
  }

  if (arrayEquals(previousKeys, nextKeys)) {
    return {
      kind: 'unchanged',
      anchorKey: null,
      autoFollowTarget: 'none',
      preserveVisibleAnchor: false,
      shouldAutoFollow: false,
      showNewMessageIndicator: false,
    };
  }

  if (isPrefix(previousKeys, nextKeys)) {
    const shouldAutoFollow = args.wasNearBottom;
    return {
      kind: 'appended-tail',
      anchorKey: null,
      autoFollowTarget: shouldAutoFollow ? 'content-end' : 'none',
      preserveVisibleAnchor: false,
      shouldAutoFollow,
      showNewMessageIndicator: !args.wasNearBottom,
    };
  }

  if (isSuffix(previousKeys, nextKeys)) {
    return {
      kind: 'prepended-older',
      anchorKey: previousKeys[0] ?? null,
      autoFollowTarget: 'none',
      preserveVisibleAnchor: true,
      shouldAutoFollow: false,
      showNewMessageIndicator: false,
    };
  }

  if (containsContiguousSlice(nextKeys, previousKeys)) {
    const shouldAutoFollow = tailChanged && args.wasNearBottom;
    return {
      kind: 'expanded-both-ends',
      anchorKey: previousKeys[0] ?? null,
      autoFollowTarget: shouldAutoFollow ? 'content-end' : 'none',
      preserveVisibleAnchor: true,
      shouldAutoFollow,
      showNewMessageIndicator: tailChanged && !args.wasNearBottom,
    };
  }

  const shouldAutoFollow = tailChanged && args.wasNearBottom;
  return {
    kind: 'replaced',
    anchorKey: null,
    autoFollowTarget: shouldAutoFollow ? 'content-end' : 'none',
    preserveVisibleAnchor: false,
    shouldAutoFollow,
    showNewMessageIndicator: tailChanged && !args.wasNearBottom,
  };
}

export function buildMessageLoadEarlierAction(args: {
  hasOlderMessages: boolean;
  loading: boolean;
  visibleMessageCount: number;
}): MessageLoadEarlierActionPresentation {
  const visible = args.hasOlderMessages && args.visibleMessageCount > 0;
  return {
    accessibilityLabel: '加载更早消息',
    disabled: args.loading,
    label: args.loading ? '加载中' : '加载更早消息',
    visible,
  };
}

export function buildSearchLoadEarlierAction(args: {
  hasHits: boolean;
  hasOlderMessages: boolean;
  loading: boolean;
  query: string;
}): MessageLoadEarlierActionPresentation {
  const visible = args.query.trim().length > 0 && args.hasOlderMessages;
  return {
    accessibilityLabel: '加载更早消息继续搜索',
    disabled: args.loading,
    label: args.loading
      ? '搜索更早中'
      : args.hasHits
        ? '继续向前搜索'
        : '加载更早继续搜索',
    visible,
  };
}

function arrayEquals(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function isPrefix(prefix: readonly string[], full: readonly string[]): boolean {
  if (prefix.length >= full.length) return false;
  for (let index = 0; index < prefix.length; index++) {
    if (prefix[index] !== full[index]) return false;
  }
  return true;
}

function isSuffix(suffix: readonly string[], full: readonly string[]): boolean {
  if (suffix.length >= full.length) return false;
  const start = full.length - suffix.length;
  for (let index = 0; index < suffix.length; index++) {
    if (full[index + start] !== suffix[index]) return false;
  }
  return true;
}

function containsContiguousSlice(full: readonly string[], slice: readonly string[]): boolean {
  if (slice.length === 0 || slice.length >= full.length) return false;
  for (let start = 0; start <= full.length - slice.length; start++) {
    let matched = true;
    for (let index = 0; index < slice.length; index++) {
      if (full[start + index] !== slice[index]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}
