import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DingTalkIM } from '@cindy/im';

import { __testing, handleDingTalkTextInteraction } from '../interaction';
import { createSharedPermission } from '../../../maker-ipc/sharedPermission';
import { setMainLocale } from '../../../i18n.desktop';

// 断言中文控制文案:显式锁定界面语言,结束后还原默认。
beforeEach(() => setMainLocale('zh-CN'));
afterEach(() => setMainLocale('en'));

describe('dingtalk text interactions', () => {
  it('settles the shared permission when the text reply times out', async () => {
    const sharedPermission = createSharedPermission();
    const im = {
      requestTextReply: vi.fn(async () => { throw new Error('DINGTALK_INTERACTION_TIMEOUT'); }),
      sendText: vi.fn(async () => {}),
    } as unknown as DingTalkIM;
    await expect(handleDingTalkTextInteraction(im, 'owner', {
      kind: 'permission', requestId: 'timeout', toolName: 'Bash', input: {},
    }, { sharedPermission })).resolves.toMatchObject({ kind: 'permission', behavior: 'deny' });
    expect(sharedPermission.decide({ kind: 'permission', behavior: 'allow' })).toBe(false);
    await expect(sharedPermission.result).resolves.toMatchObject({ reason: 'dingtalk_interaction_timeout_or_cancelled' });
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

describe('dingtalk text interactions in other interface languages', () => {
  const request = {
    kind: 'permission' as const,
    requestId: 'request-en',
    toolName: 'shell_command',
    input: {},
  };

  it('writes the prompt in English and fills the tool name', () => {
    setMainLocale('en');
    expect(__testing.formatInteractionPrompt(request)).toBe(
      'Confirmation needed: shell_command\nReply “allow” to continue, or “deny” to cancel.',
    );
    expect(__testing.formatQuestionPrompt({ question: 'Which branch?' }, 0, 2))
      .toBe('I need more information (1/2): Which branch?\nReply with an option number or your answer.');
  });

  it('accepts the reply word shown in the current language alongside the fixed words', () => {
    setMainLocale('de');
    expect(__testing.formatInteractionPrompt(request)).toContain('„erlauben“');
    expect(__testing.parseInteractionReply(request, 'Erlauben')).toEqual({ kind: 'permission', behavior: 'allow' });
    expect(__testing.parseInteractionReply(request, 'ablehnen')).toMatchObject({ behavior: 'deny' });
    expect(__testing.parseInteractionReply(request, '允许')).toEqual({ kind: 'permission', behavior: 'allow' });
  });
});

// Exercise the actual prompt/parser handoff, also reused by iMessage.
it.each([
  ['permission', 'erlauben', 'allow'], ['permission', 'ablehnen', 'deny'],
  ['plan_review', 'genehmigen', 'allow'], ['plan_review', 'ablehnen', 'deny'],
] as const)('keeps %s reply %s valid after a language change', async (kind, reply, behavior) => {
  setMainLocale('de');
  const request = kind === 'permission'
    ? { kind, requestId: 'switch', toolName: 'Bash', input: {} }
    : { kind, requestId: 'switch', plan: 'Plan' };
  const im = {
    requestTextReply: vi.fn(async (_user: string, prompt: string, parse: (text: string) => unknown) => {
      expect(prompt).toContain(reply);
      setMainLocale('en');
      expect(parse('unrelated')).toBeNull();
      return parse(reply);
    }),
    sendText: vi.fn(),
  } as unknown as DingTalkIM;
  await expect(handleDingTalkTextInteraction(im, 'user', request)).resolves.toMatchObject({ kind, behavior });
});
