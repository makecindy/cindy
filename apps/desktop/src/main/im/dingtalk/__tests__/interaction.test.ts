import { describe, expect, it, vi } from 'vitest';
import type { DingTalkIM } from '@cindy/im';

import { __testing, handleDingTalkTextInteraction } from '../interaction';

describe('dingtalk text interactions', () => {
  it('parses explicit allow and deny replies', () => {
    const request = {
      kind: 'permission' as const,
      requestId: 'request-1',
      toolName: 'shell_command',
      input: {},
    };
    expect(__testing.parseInteractionReply(request, '允许')).toEqual({
      kind: 'permission',
      behavior: 'allow',
    });
    expect(__testing.parseInteractionReply(request, '拒绝')).toEqual({
      kind: 'permission',
      behavior: 'deny',
      reason: 'dingtalk_user_denied',
    });
  });

  it('自动审批故障时在钉钉确认提示里写明原因', () => {
    const ordinary = __testing.formatInteractionPrompt({
      kind: 'permission',
      requestId: 'request-1',
      toolName: 'shell_command',
      input: {},
    });
    expect(ordinary).toBe('需要确认操作：shell_command\n回复“允许”继续，或回复“拒绝”取消。');

    const unavailable = __testing.formatInteractionPrompt({
      kind: 'permission',
      requestId: 'request-1',
      toolName: 'shell_command',
      input: {},
      metadata: { autoReviewUnavailable: true },
    });
    expect(unavailable).toContain('自动审批没完成，请确认要不要允许这次操作。');
    expect(unavailable).toContain('需要确认操作：shell_command');
    expect(unavailable).toContain('回复“允许”继续');
  });

  it('maps a numbered answer to the matching option label', () => {
    const request = {
      kind: 'ask_user_question' as const,
      requestId: 'request-2',
      questions: [
        {
          question: '选择方向',
          options: [{ label: 'A' }, { label: 'B' }],
        },
      ],
    };
    expect(__testing.parseInteractionReply(request, '2')).toEqual({
      kind: 'ask_user_question',
      answers: { 选择方向: 'B' },
    });
  });

  it('asks multiple questions one at a time', async () => {
    const replies = ['2', 'custom'];
    const requestTextReply = vi.fn(
      async <T>(_userId: string, _prompt: string, parse: (text: string) => T | null) =>
        parse(replies.shift() ?? '') as T,
    );
    const im = { requestTextReply } as unknown as DingTalkIM;
    const request = {
      kind: 'ask_user_question' as const,
      requestId: 'request-3',
      questions: [
        { question: '方向', options: [{ label: 'A' }, { label: 'B' }] },
        { question: '备注' },
      ],
    };

    await expect(handleDingTalkTextInteraction(im, 'owner-1', request)).resolves.toEqual({
      kind: 'ask_user_question',
      answers: { 方向: 'B', 备注: 'custom' },
    });
    expect(requestTextReply).toHaveBeenCalledTimes(2);
  });
});
