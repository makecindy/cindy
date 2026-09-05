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

  it('uses the migrated interaction remaining timeout', async () => {
    const requestTextReply = vi.fn(
      async (
        _userId: string,
        _prompt: string,
        _parse: (text: string) => unknown,
        _timeoutMs?: number,
      ) => ({
        kind: 'permission' as const,
        behavior: 'allow' as const,
      }),
    );
    const im = { requestTextReply } as unknown as DingTalkIM;
    const request = {
      kind: 'permission' as const,
      requestId: 'request-timeout',
      toolName: 'shell_command',
      input: {},
    };

    await handleDingTalkTextInteraction(im, 'owner-1', request, { timeoutMs: 1_234 });

    expect(requestTextReply).toHaveBeenCalledWith(
      'owner-1',
      expect.any(String),
      expect.any(Function),
      expect.any(Number),
      'request-timeout',
    );
    expect(requestTextReply.mock.calls[0]?.[3]).toBeLessThanOrEqual(1_234);
    expect(requestTextReply.mock.calls[0]?.[3]).toBeGreaterThan(0);
  });

  it('returns the router cancellation decision instead of an interaction handler failure', async () => {
    const cancellation = Object.assign(new Error('DINGTALK_INTERACTION_CANCELLED'), {
      decision: { kind: 'permission' as const, behavior: 'deny' as const, reason: 'session_cleanup' },
    });
    const im = {
      requestTextReply: vi.fn(async () => Promise.reject(cancellation)),
    } as unknown as DingTalkIM;
    await expect(
      handleDingTalkTextInteraction(im, 'owner-1', {
        kind: 'permission',
        requestId: 'request-cancel',
        toolName: 'shell_command',
        input: {},
      }),
    ).resolves.toEqual(cancellation.decision);
  });
});
