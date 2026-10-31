import { describe, expect, it, vi } from 'vitest';
import type { DingTalkIM } from '@cindy/im';

import { __testing, handleDingTalkTextInteraction } from '../interaction';
import { createSharedPermission } from '../../../maker-ipc/sharedPermission';

describe('dingtalk text interactions', () => {
  it('settles the shared permission when the text reply times out', async () => {
    const sharedPermission = createSharedPermission();
    const im = {
      getOwnerUserId: () => 'owner',
      requestTextReply: vi.fn(async () => { throw new Error('DINGTALK_INTERACTION_TIMEOUT'); }),
      sendText: vi.fn(async () => {}),
    } as unknown as DingTalkIM;
    await expect(handleDingTalkTextInteraction(im, 'owner', {
      kind: 'permission', requestId: 'timeout', toolName: 'Bash', input: {},
    }, { sharedPermission })).resolves.toMatchObject({ kind: 'permission', behavior: 'deny' });
    expect(sharedPermission.decide({ kind: 'permission', behavior: 'allow' })).toBe(false);
    await expect(sharedPermission.result).resolves.toMatchObject({ reason: 'dingtalk_interaction_timeout_or_cancelled' });
  });

  // Guest DM admission must not let the requester approve host tool permissions.
  // Exercise the production interaction entry, retaining ordinary guest answers.
  it('routes guest tool permission prompts and outcomes to the bound owner', async () => {
    const sharedPermission = createSharedPermission();
    const requestTextReply = vi.fn(async <T>(
      _userId: string, _prompt: string, parse: (text: string) => T | null,
      _timeout: number | undefined, shared?: { decide(value: T): boolean },
    ) => {
      const decision = parse('允许')!;
      shared?.decide(decision);
      return decision;
    });
    const sendText = vi.fn(async (_userId: string, _text: string) => {});
    const im = { getOwnerUserId: () => 'owner-1', requestTextReply, sendText } as unknown as DingTalkIM;
    await expect(handleDingTalkTextInteraction(im, 'guest-1', {
      kind: 'permission', requestId: 'guest-permission', toolName: 'file_change', input: {},
    }, { sharedPermission })).resolves.toMatchObject({ kind: 'permission', behavior: 'allow' });
    expect(requestTextReply.mock.calls[0][0]).toBe('owner-1');
    expect(sendText.mock.calls[0][0]).toBe('owner-1');

    await expect(handleDingTalkTextInteraction(im, 'guest-1', {
      kind: 'ask_user_question', requestId: 'guest-question', questions: [{ question: 'Which file?' }],
    })).resolves.toMatchObject({ kind: 'ask_user_question' });
    expect(requestTextReply.mock.calls[1][0]).toBe('guest-1');
  });

  it('denies tool permission when no owner is bound instead of asking the guest', async () => {
    const sharedPermission = createSharedPermission();
    const requestTextReply = vi.fn();
    const im = { getOwnerUserId: () => '', requestTextReply } as unknown as DingTalkIM;
    await expect(handleDingTalkTextInteraction(im, 'guest-1', {
      kind: 'permission', requestId: 'unbound-permission', toolName: 'file_change', input: {},
    }, { sharedPermission })).resolves.toMatchObject({ kind: 'permission', behavior: 'deny' });
    expect(requestTextReply).not.toHaveBeenCalled();
    expect(sharedPermission.decide({ kind: 'permission', behavior: 'allow' })).toBe(false);
  });

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

  // 2026-10-24 review: text channels showed only the tool name, so a safe and a destructive
  // Bash call looked identical. They now share the desktop/phone operation summary.
  it('确认提示显示要执行的具体操作和审核原因', () => {
    const prompt = __testing.formatInteractionPrompt({
      kind: 'permission',
      requestId: 'request-2',
      toolName: 'Bash',
      input: { command: 'xcrun simctl delete all' },
      metadata: { autoReviewReason: '这会删除所有模拟器。' },
    });
    expect(prompt).toContain('操作：xcrun simctl delete all');
    expect(prompt).toContain('自动审批需要你决定：这会删除所有模拟器。');
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
