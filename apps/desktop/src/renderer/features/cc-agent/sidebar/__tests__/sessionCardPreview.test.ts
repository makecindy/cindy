import { describe, expect, it } from 'vitest';

import { resolveSessionCardBody, shouldPromoteLivePreviewToSession } from '../sessionCardPreview';

describe('resolveSessionCardBody', () => {
  it('list 模式只用最近消息,即使有摘要', () => {
    expect(
      resolveSessionCardBody({
        variant: 'list',
        pinned: true,
        summary: 'PR 已提交并开启，相关单测通过。',
        preview: '不是键盘没插上，是同时有两份 Cindy 在抢同一块 HID。',
      }),
    ).toBe('不是键盘没插上，是同时有两份 Cindy 在抢同一块 HID。');
  });

  it('卡片 + 置顶才用摘要', () => {
    expect(
      resolveSessionCardBody({
        variant: 'card',
        pinned: true,
        summary: 'PR 已提交并开启，相关单测通过。',
        preview: '不是键盘没插上',
      }),
    ).toBe('PR 已提交并开启，相关单测通过。');
  });

  it('卡片但未置顶回退最近消息', () => {
    expect(
      resolveSessionCardBody({
        variant: 'card',
        pinned: false,
        summary: 'PR 已提交并开启，相关单测通过。',
        preview: '看一下我们现在的开发版',
      }),
    ).toBe('看一下我们现在的开发版');
  });

  it('摘要为空时卡片也回退 preview', () => {
    expect(
      resolveSessionCardBody({
        variant: 'card',
        pinned: true,
        summary: '  ',
        preview: '最近一条消息',
      }),
    ).toBe('最近一条消息');
  });
});

describe('shouldPromoteLivePreviewToSession', () => {
  it('实时活动消失、缓存仍是上一轮时,把最后一帧顶进列表预览', () => {
    expect(
      shouldPromoteLivePreviewToSession({
        previousSessionId: 's1',
        nextSessionId: 's1',
        previousLivePreview: '那就对上了——正是枚举到了但不发输入报告那个状态。',
        nextLivePreview: null,
        currentPreview: '不正常。但问题不在布局代码',
      }),
    ).toBe(true);
  });

  it('权威 preview 已是这一帧或更完整版时不盖回去', () => {
    expect(
      shouldPromoteLivePreviewToSession({
        previousSessionId: 's1',
        nextSessionId: 's1',
        previousLivePreview: '那就对上了',
        nextLivePreview: null,
        currentPreview: '那就对上了——正是枚举到了但不发输入报告那个状态。',
      }),
    ).toBe(false);
  });

  it('仍在跑、换了任务、或本来就没有实时文案时不写', () => {
    expect(
      shouldPromoteLivePreviewToSession({
        previousSessionId: 's1',
        nextSessionId: 's1',
        previousLivePreview: '那就对上了',
        nextLivePreview: '那就对上了——正是枚举到了',
      }),
    ).toBe(false);
    expect(
      shouldPromoteLivePreviewToSession({
        previousSessionId: 's1',
        nextSessionId: 's2',
        previousLivePreview: '那就对上了',
        nextLivePreview: null,
      }),
    ).toBe(false);
    expect(
      shouldPromoteLivePreviewToSession({
        previousSessionId: 's1',
        nextSessionId: 's1',
        previousLivePreview: null,
        nextLivePreview: null,
      }),
    ).toBe(false);
  });
});
