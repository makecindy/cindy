import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateMessageWindowUpdate,
  evaluateMobileAnchorVerify,
  MOBILE_ANCHOR_VERIFY_MAX_ATTEMPTS,
  MOBILE_ANCHOR_VERIFY_MAX_WAIT_ROUNDS,
  MOBILE_ANCHOR_VERIFY_TOLERANCE,
  shouldPreserveMobileHistoryBrowseIntent,
} from '@/session/messageScroll';

// evaluateMessageWindowUpdate 是容器无关的纯函数,驱动「新消息红点 / 近底自动跟随」判定。
// 迁移到 LegendList 后仍由它决定 hasNewMessages(贴底跟随交给 maintainScrollAtEnd,防跳交给
// 应用层 key/offset 锚定);容器 prop 契约见 messageListVirtualization.test.ts。
describe('scrollWindowModel', () => {
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

  it.each(['\n', '\r\n'])('restores the load-earlier affordance after unchanged reopen with %j line endings', (lineEnding) => {
    const source = readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8').replace(/\r?\n/g, lineEnding);
    // 重开"无新内容"分支(metaChanged=false)也补设 hasOlderMessages,用服务端总数 vs in-store 推断。
    expect(source).toContain('hasOlderMessagesAfterReopen(sessionMeta._count?.messages, remoteSessionStore.getMessages(sessionId))');
    // 仍保留有新内容时的精确(page-based)判定。这个值现在同时喂给 store 的窗口连续性判据
    // (moreBeyondWindow,见 #1222):两者本就该同源 —— 「本页上沿之外还有历史」既决定是否点亮
    // 「加载更早」,也决定能不能信任早于本页的缓存段。
    expect(source).toContain('const moreBeyondWindow = shouldKeepOlderMessagesAffordance(history);');
    expect(source).toMatch(/setHasOlderMessages\(history !== null\s+\? shouldKeepOlderMessagesAffordance\(history\)/);
    expect(source).toMatch(
      /setLatestMessageWindow\(sessionId, historyPage, \{\s*authority: messageAuthority,\s*moreBeyondWindow,\s*\}\)/,
    );
  });
});

describe('history browse intent', () => {
  it('rejects passive anchor offsets but allows a real user-controlled return to latest', () => {
    expect(shouldPreserveMobileHistoryBrowseIntent({
      historyBrowseIntent: true,
      userControllingScroll: false,
    })).toBe(true);
    expect(shouldPreserveMobileHistoryBrowseIntent({
      historyBrowseIntent: true,
      userControllingScroll: true,
    })).toBe(false);
    expect(shouldPreserveMobileHistoryBrowseIntent({
      historyBrowseIntent: false,
      userControllingScroll: false,
    })).toBe(false);
  });
});

describe('evaluateMobileAnchorVerify (贴底锚定校验判定)', () => {
  const anchoredMetrics = { contentHeight: 2000, offsetY: 1200, viewportHeight: 800 };
  const base = {
    attempts: 0,
    listVisible: true,
    metrics: anchoredMetrics,
    preserveVisibleContentPosition: false,
    stickToLatest: true,
    waitRounds: 0,
  };

  it('settles when the offset already reached the content end (within tolerance)', () => {
    expect(evaluateMobileAnchorVerify(base)).toBe('settled');
    expect(evaluateMobileAnchorVerify({
      ...base,
      metrics: { ...anchoredMetrics, offsetY: 1200 - MOBILE_ANCHOR_VERIFY_TOLERANCE },
    })).toBe('settled');
    // iOS bounce 超滚(offset 超过 end)同样视为贴底。
    expect(evaluateMobileAnchorVerify({
      ...base,
      metrics: { ...anchoredMetrics, offsetY: 1210 },
    })).toBe('settled');
  });

  it('retries when the drop-to-bottom silently fell short of the content end', () => {
    // 典型落空:落底被尚未真正关闭的 mVCP 吸收,或落底一刻 metrics 陈旧,
    // 最新消息停在底部浮层后面(offset 距 end 一段距离且不再有事件纠正)。
    expect(evaluateMobileAnchorVerify({
      ...base,
      metrics: { ...anchoredMetrics, offsetY: 1000 },
    })).toBe('retry');
  });

  it('never fights the user or an intentional anchor: settled once stick is released or list hidden', () => {
    expect(evaluateMobileAnchorVerify({
      ...base,
      stickToLatest: false,
      metrics: { ...anchoredMetrics, offsetY: 0 },
    })).toBe('settled');
    expect(evaluateMobileAnchorVerify({
      ...base,
      listVisible: false,
      metrics: { ...anchoredMetrics, offsetY: 0 },
    })).toBe('settled');
  });

  it('waits (without scrolling) while maintainVisibleContentPosition is still on or metrics unknown', () => {
    expect(evaluateMobileAnchorVerify({
      ...base,
      preserveVisibleContentPosition: true,
      metrics: { ...anchoredMetrics, offsetY: 0 },
    })).toBe('wait');
    expect(evaluateMobileAnchorVerify({
      ...base,
      metrics: { contentHeight: 0, offsetY: 0, viewportHeight: 0 },
    })).toBe('wait');
  });

  it('treats sub-viewport content as anchored regardless of offset', () => {
    expect(evaluateMobileAnchorVerify({
      ...base,
      metrics: { contentHeight: 400, offsetY: 0, viewportHeight: 800 },
    })).toBe('settled');
  });

  it('gives up after the retry budget so an unreachable target can never spin forever', () => {
    expect(evaluateMobileAnchorVerify({
      ...base,
      attempts: MOBILE_ANCHOR_VERIFY_MAX_ATTEMPTS,
      metrics: { ...anchoredMetrics, offsetY: 1000 },
    })).toBe('give-up');
    // 预算耗尽但 offset 其实已到位:仍是 settled(give-up 只对"需要补滚却没额度"生效)。
    expect(evaluateMobileAnchorVerify({
      ...base,
      attempts: MOBILE_ANCHOR_VERIFY_MAX_ATTEMPTS,
    })).toBe('settled');
  });

  it('keeps the retry budget intact while waiting on mVCP, with a separate wait cap (review P1)', () => {
    // 等待不消耗补滚额度:mVCP 长开(open-settle cap 2s)期间即使补滚预算早已耗尽,
    // 环仍继续等待——窗口关闭后才有机会真正补滚,不会"烧光预算后遮挡残留"。
    expect(evaluateMobileAnchorVerify({
      ...base,
      attempts: MOBILE_ANCHOR_VERIFY_MAX_ATTEMPTS,
      preserveVisibleContentPosition: true,
      metrics: { ...anchoredMetrics, offsetY: 0 },
    })).toBe('wait');
    // 等待有独立上限,覆盖最长 mVCP 窗口后仍未就绪则结束环,不永转。
    expect(evaluateMobileAnchorVerify({
      ...base,
      preserveVisibleContentPosition: true,
      waitRounds: MOBILE_ANCHOR_VERIFY_MAX_WAIT_ROUNDS,
    })).toBe('give-up');
  });
});
