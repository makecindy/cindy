import { describe, expect, it } from 'vitest';
import {
  buildMessageLoadEarlierAction,
  buildSearchLoadEarlierAction,
  evaluateMessageWindowUpdate,
  isNearMessageListBottom,
  isNearMessageListTop,
  shouldAutoFollowMessages,
  shouldShowNewMessageIndicator,
} from '../messageWindow';

describe('messageWindow', () => {
  it('treats short content and threshold-close scroll as near bottom', () => {
    expect(isNearMessageListBottom({ contentHeight: 500, offsetY: 0, viewportHeight: 600 })).toBe(true);
    expect(isNearMessageListBottom({ contentHeight: 1000, offsetY: 850, viewportHeight: 100 })).toBe(true);
    expect(isNearMessageListBottom({ contentHeight: 1000, offsetY: 600, viewportHeight: 100 })).toBe(false);
  });

  it('treats top threshold and overscroll as load-earlier range', () => {
    expect(isNearMessageListTop({ offsetY: -24 })).toBe(true);
    expect(isNearMessageListTop({ offsetY: 80 })).toBe(true);
    expect(isNearMessageListTop({ offsetY: 140 })).toBe(false);
  });

  it('auto-follows initial load and new messages only when already near bottom', () => {
    expect(shouldAutoFollowMessages({
      previousLastKey: null,
      nextLastKey: 'm1',
      wasNearBottom: false,
    })).toBe(true);
    expect(shouldAutoFollowMessages({
      previousLastKey: 'm1',
      nextLastKey: 'm2',
      wasNearBottom: true,
    })).toBe(true);
    expect(shouldAutoFollowMessages({
      previousLastKey: 'm1',
      nextLastKey: 'm2',
      wasNearBottom: false,
    })).toBe(false);
  });

  it('shows the new-message indicator only for new tail messages while away from bottom', () => {
    expect(shouldShowNewMessageIndicator({
      previousLastKey: null,
      nextLastKey: 'm1',
      wasNearBottom: false,
    })).toBe(false);
    expect(shouldShowNewMessageIndicator({
      previousLastKey: 'm1',
      nextLastKey: 'm1',
      wasNearBottom: false,
    })).toBe(false);
    expect(shouldShowNewMessageIndicator({
      previousLastKey: 'm1',
      nextLastKey: 'm2',
      wasNearBottom: false,
    })).toBe(true);
  });

  it('auto-follows the initial visible window without showing a new-message chip', () => {
    expect(evaluateMessageWindowUpdate({
      previousKeys: [],
      nextKeys: ['m80', 'm81'],
      wasNearBottom: false,
    })).toEqual({
      kind: 'initial',
      anchorKey: null,
      autoFollowTarget: 'content-end',
      preserveVisibleAnchor: false,
      shouldAutoFollow: true,
      showNewMessageIndicator: false,
    });
  });

  it('auto-follows tail appends only when the user was already near bottom', () => {
    expect(evaluateMessageWindowUpdate({
      previousKeys: ['m1', 'm2'],
      nextKeys: ['m1', 'm2', 'm3'],
      wasNearBottom: true,
    })).toMatchObject({
      kind: 'appended-tail',
      autoFollowTarget: 'content-end',
      shouldAutoFollow: true,
      showNewMessageIndicator: false,
    });

    expect(evaluateMessageWindowUpdate({
      previousKeys: ['m1', 'm2'],
      nextKeys: ['m1', 'm2', 'm3'],
      wasNearBottom: false,
    })).toMatchObject({
      kind: 'appended-tail',
      autoFollowTarget: 'none',
      shouldAutoFollow: false,
      showNewMessageIndicator: true,
    });
  });

  it('preserves the current first visible key when older history is prepended', () => {
    expect(evaluateMessageWindowUpdate({
      previousKeys: ['m81', 'm82', 'm83'],
      nextKeys: ['m1', 'm2', 'm81', 'm82', 'm83'],
      wasNearBottom: true,
    })).toEqual({
      kind: 'prepended-older',
      anchorKey: 'm81',
      autoFollowTarget: 'none',
      preserveVisibleAnchor: true,
      shouldAutoFollow: false,
      showNewMessageIndicator: false,
    });
  });

  it('keeps the old anchor and still signals new tail content when both ends expand', () => {
    expect(evaluateMessageWindowUpdate({
      previousKeys: ['m81', 'm82', 'm83'],
      nextKeys: ['m1', 'm2', 'm81', 'm82', 'm83', 'm84'],
      wasNearBottom: false,
    })).toEqual({
      kind: 'expanded-both-ends',
      anchorKey: 'm81',
      autoFollowTarget: 'none',
      preserveVisibleAnchor: true,
      shouldAutoFollow: false,
      showNewMessageIndicator: true,
    });
  });

  it('treats unrelated key sets as a replacement and follows only near-bottom readers', () => {
    expect(evaluateMessageWindowUpdate({
      previousKeys: ['old-1', 'old-2'],
      nextKeys: ['new-1', 'new-2'],
      wasNearBottom: true,
    })).toMatchObject({
      kind: 'replaced',
      autoFollowTarget: 'content-end',
      preserveVisibleAnchor: false,
      shouldAutoFollow: true,
      showNewMessageIndicator: false,
    });
  });

  it('does not flag new messages when a replacement empties the list away from bottom', () => {
    // 不在底部时替换成另一批消息仍提示;替换成空列表没有可跳转的新消息。
    expect(evaluateMessageWindowUpdate({
      previousKeys: ['old-1'],
      nextKeys: ['new-1'],
      wasNearBottom: false,
    }).showNewMessageIndicator).toBe(true);
    expect(evaluateMessageWindowUpdate({
      previousKeys: ['m1'],
      nextKeys: [],
      wasNearBottom: false,
    })).toMatchObject({ kind: 'replaced', shouldAutoFollow: false, showNewMessageIndicator: false });
  });

  it('builds the load-earlier action state from window availability', () => {
    expect(buildMessageLoadEarlierAction({
      hasOlderMessages: true,
      loading: false,
      visibleMessageCount: 3,
    })).toEqual({
      accessibilityLabel: '加载更早消息',
      disabled: false,
      label: '加载更早消息',
      visible: true,
    });

    expect(buildMessageLoadEarlierAction({
      hasOlderMessages: true,
      loading: true,
      visibleMessageCount: 3,
    })).toMatchObject({
      disabled: true,
      label: '加载中',
      visible: true,
    });

    expect(buildMessageLoadEarlierAction({
      hasOlderMessages: true,
      loading: false,
      visibleMessageCount: 0,
    })).toMatchObject({ visible: false });
  });

  it('builds the search load-earlier action state from query and hit count', () => {
    expect(buildSearchLoadEarlierAction({
      hasHits: true,
      hasOlderMessages: true,
      loading: false,
      query: ' fix ',
    })).toEqual({
      accessibilityLabel: '加载更早消息继续搜索',
      disabled: false,
      label: '继续向前搜索',
      visible: true,
    });

    expect(buildSearchLoadEarlierAction({
      hasHits: false,
      hasOlderMessages: true,
      loading: false,
      query: 'fix',
    })).toMatchObject({
      label: '加载更早继续搜索',
      visible: true,
    });

    expect(buildSearchLoadEarlierAction({
      hasHits: false,
      hasOlderMessages: true,
      loading: true,
      query: 'fix',
    })).toMatchObject({
      disabled: true,
      label: '搜索更早中',
      visible: true,
    });

    expect(buildSearchLoadEarlierAction({
      hasHits: true,
      hasOlderMessages: true,
      loading: false,
      query: '   ',
    })).toMatchObject({ visible: false });
  });
});
