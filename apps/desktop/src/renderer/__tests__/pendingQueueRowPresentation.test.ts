import { describe, expect, it } from 'vitest';

import {
  CONTINUE_AFTER_APP_EXIT_PROMPT,
  CONTINUE_AFTER_ERROR_PROMPT,
} from '../../shared/interruptedTurn';
import {
  getPendingQueueRowPresentation,
  resolvePendingQueueEditSubmission,
} from '@/components/new-chat/pendingQueueRowPresentation';
import type { QueuedMessage } from '@/lib/makerChatStore';

function queuedMessage(patch: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    clientId: 'client-1',
    text: 'queued text',
    persistedContent: 'queued text',
    model: 'claude-opus-4-7',
    effort: 'medium',
    permissionMode: 'default',
    workingDir: '/tmp/project',
    chatMessage: {
      clientId: 'client-1',
      role: 'user',
      content: 'queued text',
      isStreaming: false,
      createdAt: '2026-06-11T00:00:00.000Z',
    },
    createOpts: {
      agentKind: 'claude-code',
      workingDir: '/tmp/project',
      model: 'claude-opus-4-7',
      effort: 'medium',
      permissionMode: 'default',
      userPrompt: '',
      makerMemoryEnabled: true,
      displayReasoning: 'summarized',
    },
    ...patch,
  };
}

describe('getPendingQueueRowPresentation', () => {
  it('marks messages sent by another session as read-only rows with the sender title', () => {
    const presentation = getPendingQueueRowPresentation(
      queuedMessage({
        text: 'follow-up',
        persistedContent: 'follow-up',
        origin: {
          kind: 'session',
          senderSessionId: 'caller',
          displayText: 'follow-up',
          senderSessionTitle: 'Release checklist',
        },
      }),
    );

    expect(presentation).toMatchObject({
      isSession: true,
      isOrca: false,
      isScheduler: false,
      senderLabel: 'Release checklist',
      displayText: 'follow-up',
      canEdit: false,
      canSteer: false,
    });
    expect(
      getPendingQueueRowPresentation(
        queuedMessage({ origin: { kind: 'session', senderSessionId: 'caller', displayText: 'x' } }),
      ).senderLabel,
    ).toBeNull();
    expect(
      getPendingQueueRowPresentation(
        queuedMessage({
          origin: {
            kind: 'session',
            senderSessionId: 'bot-task',
            displayText: 'x',
            senderSessionTitle: 'Weekly feedback',
            senderBotId: 'bot-1',
            senderBotName: 'Cindy',
          },
        }),
      ),
    ).toMatchObject({ isSession: true, senderLabel: 'Cindy', senderBotId: 'bot-1' });
  });

  it('shows the message text, not the host envelope, for session items with attachments', () => {
    const origin = { kind: 'session' as const, senderSessionId: 'caller', displayText: 'see attached' };
    expect(
      getPendingQueueRowPresentation(
        queuedMessage({
          text: 'see attached',
          persistedContent: JSON.stringify({ text: 'see attached', images: [], files: [{ name: 'a.txt', path: '/a.txt' }] }),
          files: [{ name: 'a.txt', path: '/a.txt', category: 'file' } as never],
          origin,
        }),
      ).displayText,
    ).toBe('see attached');
    // Without attachments a literal JSON message stays verbatim.
    expect(
      getPendingQueueRowPresentation(
        queuedMessage({ text: '{"text":"x"}', persistedContent: '{"text":"x"}', origin }),
      ).displayText,
    ).toBe('{"text":"x"}');
  });

  it('uses orca sender and display text while disabling edit and steer actions', () => {
    const presentation = getPendingQueueRowPresentation(
      queuedMessage({
        text: '[orca protocol text]',
        origin: {
          kind: 'orca',
          senderLabel: 'reviewer',
          displayText: '请看一下这个结论',
        },
      }),
    );

    expect(presentation).toEqual({
      isOrca: true,
      isScheduler: false,
      isSession: false,
      senderBotId: null,
      senderLabel: 'reviewer',
      displayText: '请看一下这个结论',
      isSyntheticTrigger: false,
      syntheticKind: null,
      canEdit: false,
      canSteer: false,
    });
  });

  it('marks scheduler heartbeat rows with schedule name, hides silent-run suffix, locks edit/steer', () => {
    // 撞忙排队的心跳:text 带隐藏静默协议后缀,展示用 persistedContent(原始 prompt);
    // 机器生成 → 保留重排/删除,禁编辑/steer(与 orca 同规)。
    const presentation = getPendingQueueRowPresentation(
      queuedMessage({
        text: 'PR #971 heartbeat prompt\n\n---\n[Silent scheduled run]\n...',
        persistedContent: 'PR #971 heartbeat prompt',
        origin: {
          kind: 'scheduler',
          scheduleId: 'sch-1',
          scheduleName: 'PR #971 心跳',
        },
      }),
    );

    expect(presentation).toEqual({
      isOrca: false,
      isScheduler: true,
      isSession: false,
      senderBotId: null,
      senderLabel: 'PR #971 心跳',
      displayText: 'PR #971 heartbeat prompt',
      isSyntheticTrigger: false,
      syntheticKind: null,
      canEdit: false,
      canSteer: false,
    });
  });

  it('falls back to queued text when orca display text is absent', () => {
    const presentation = getPendingQueueRowPresentation(
      queuedMessage({
        text: 'raw queued text',
        origin: {
          kind: 'orca',
          senderLabel: 'Lead',
        },
      }),
    );

    expect(presentation.displayText).toBe('raw queued text');
  });

  it('keeps regular queued messages editable and steerable', () => {
    const presentation = getPendingQueueRowPresentation(queuedMessage());

    expect(presentation).toMatchObject({
      isOrca: false,
      senderLabel: null,
      displayText: 'queued text',
      canEdit: true,
      canSteer: true,
      isSyntheticTrigger: false,
    });
  });

  it('hides private quote markers from quoted queue rows and their editor', () => {
    const entry = queuedMessage({
      text: '> <!-- cindy-composer-quote -->\n> quoted\n\nreply',
      chatMessage: {
        clientId: 'client-1',
        role: 'user',
        content: '> <!-- cindy-composer-quote -->\n> quoted\n\nreply',
        quotesEncoded: true,
      },
    });

    const presentation = getPendingQueueRowPresentation(entry);

    expect(presentation.displayText).toBe('> quoted\n\nreply');
    expect(resolvePendingQueueEditSubmission(entry, presentation.displayText)).toBeNull();
    expect(resolvePendingQueueEditSubmission(entry, '> quoted\n\nrevised reply'))
      .toBe('> quoted\n\nrevised reply');
  });

  it('masks a serialized pending welcome and offers no edit or steer', () => {
    const text = '[UI_ACTION_TRIGGER]Say hello using cached project/task hints.';
    const restored = JSON.parse(JSON.stringify(queuedMessage({ text, persistedContent: text })));
    expect(getPendingQueueRowPresentation(restored)).toMatchObject({
      isSyntheticTrigger: true, syntheticKind: 'generic', canEdit: false, canSteer: false,
    });
  });

  it('flags synthetic [UI_ACTION_TRIGGER] rows and locks edit/steer', () => {
    // error-tail-banner:coordinator 续跑分支入队的合成指令,面板按此标记显示
    // i18n 遮蔽标签,禁编辑/steer(改了指令就不是规范化续跑了)。
    const presentation = getPendingQueueRowPresentation(
      queuedMessage({ text: '[UI_ACTION_TRIGGER] The previous turn errored partway through.' }),
    );

    expect(presentation).toMatchObject({
      isSyntheticTrigger: true,
      canEdit: false,
      canSteer: false,
      // 非续跑常量的合成触发(如 Mivo 图片按钮)→ 中性「系统指令」标签,
      // 不得错标为「继续未完成的任务」(review P2)。
      syntheticKind: 'generic',
    });
  });

  it('labels exact continue prompts as continue-kind synthetic triggers', () => {
    for (const text of [CONTINUE_AFTER_APP_EXIT_PROMPT, CONTINUE_AFTER_ERROR_PROMPT]) {
      expect(getPendingQueueRowPresentation(queuedMessage({ text }))).toMatchObject({
        isSyntheticTrigger: true,
        syntheticKind: 'continue',
        canEdit: false,
        canSteer: false,
      });
    }
  });
});
