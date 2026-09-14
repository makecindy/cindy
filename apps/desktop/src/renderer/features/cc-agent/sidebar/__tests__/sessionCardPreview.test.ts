import { describe, expect, it } from 'vitest';

import { resolveSessionCardBody } from '../sessionCardPreview';

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
