import { describe, expect, it } from 'vitest';

import {
  hookConnectionNameFromOrigin,
  isHookSchedulerOrigin,
  isRealAutomationOrigin,
  toMessageAutomationOrigin,
} from '@/lib/messageAutomationOrigin';

describe('toMessageAutomationOrigin', () => {
  // 回归：系统合批没有唯一发送方任务，不能跳转首个 Worker（unit）。
  it.each([undefined, 'worker-1'])('keeps batch count without a single-worker link (%s)', senderSessionId => {
    expect(toMessageAutomationOrigin({ kind: 'orca', senderLabel: 'A', senderSessionId,
      autoBridge: true, autoBridgeBatchCount: 2 })).toEqual({
      kind: 'session', orca: true, orcaAutoBridgeBatchCount: 2,
    });
  });

  it('keeps scheduler origins unchanged', () => {
    const origin = { kind: 'scheduler', scheduleId: 's1', scheduleName: 'Nightly', runId: 'r1' };
    expect(toMessageAutomationOrigin(origin)).toBe(origin);
  });

  it('projects tool-sent session origins with the sender title snapshot', () => {
    expect(
      toMessageAutomationOrigin({
        kind: 'session',
        senderSessionId: 'caller',
        displayText: 'follow-up',
        senderSessionTitle: ' Release checklist ',
      }),
    ).toEqual({
      kind: 'session',
      senderSessionId: 'caller',
      senderSessionTitle: 'Release checklist',
    });
  });

  it('carries the sender teammate identity when the source session belongs to one', () => {
    expect(
      toMessageAutomationOrigin({
        kind: 'session',
        senderSessionId: 'bot-task',
        senderSessionTitle: 'Weekly feedback',
        senderBotId: 'bot-1',
        senderBotName: 'Cindy',
      }),
    ).toEqual({
      kind: 'session',
      senderSessionId: 'bot-task',
      senderSessionTitle: 'Weekly feedback',
      senderBotId: 'bot-1',
      senderBotName: 'Cindy',
    });
  });

  // bot-group-chat.md §10: a member's words from a task card's Thread have no sending task, yet
  // must still name the speaker and group (not the redacted "another task" label).
  it('keeps the speaker and group of words passed in from a task card Thread', () => {
    const groupThread = { groupId: 'g1', groupName: 'Launch', speakerId: 'm1', speakerName: 'Ann' };
    expect(toMessageAutomationOrigin({ kind: 'session', senderSessionId: '', displayText: 'hi',
      senderBotId: 'bot-1', senderBotName: 'Cindy', groupThread })).toEqual({
      kind: 'session', senderBotId: 'bot-1', senderBotName: 'Cindy', groupThread });
  });

  // bot-group-chat.md「群里的 Cindy」: a request to the group's Cindy has no sending task either; the
  // bubble names the group and the speaker, as the model's [消息来源] does.
  it('keeps the group and speaker of a request to the group Cindy', () => {
    const groupRequest = { groupId: 'g1', groupName: 'Launch', speakerId: 'm1', speakerName: 'Chris' };
    expect(toMessageAutomationOrigin({ kind: 'session', senderSessionId: '', displayText: 'hi', groupRequest }))
      .toEqual({ kind: 'session', groupRequest });
  });

  it('links Orca messages to the sending session and keeps the sender role for the card title', () => {
    expect(
      toMessageAutomationOrigin({ kind: 'orca', senderLabel: 'Lead', senderSessionId: 'lead-1' }),
    ).toEqual({ kind: 'session', orca: true, senderSessionId: 'lead-1', orcaSenderLabel: 'Lead' });
    // 老数据 / 访客视图没有发送方任务：仍保留角色名给卡片标题，但不会出可跳转标签。
    expect(toMessageAutomationOrigin({ kind: 'orca', senderLabel: ' 前端 ' })).toEqual({
      kind: 'session',
      orca: true,
      orcaSenderLabel: '前端',
    });
    expect(toMessageAutomationOrigin({ kind: 'orca' })).toBeUndefined();
  });

  it('keeps a redacted scheduler origin (shared-task guest) without inventing an id', () => {
    expect(toMessageAutomationOrigin({ kind: 'scheduler' })).toEqual({ kind: 'scheduler' });
    expect(isRealAutomationOrigin({ kind: 'scheduler' })).toBe(true);
  });

  it('ignores missing, malformed, and unknown origins', () => {
    expect(toMessageAutomationOrigin(undefined)).toBeUndefined();
    expect(toMessageAutomationOrigin('scheduler')).toBeUndefined();
    expect(toMessageAutomationOrigin({ kind: 'desktop' })).toBeUndefined();
  });

  it('keeps a generic, non-navigable session origin when the host redacted the sender', () => {
    expect(toMessageAutomationOrigin({ kind: 'session' })).toEqual({ kind: 'session' });
    expect(toMessageAutomationOrigin({ kind: 'session', senderSessionId: '  ' })).toEqual({ kind: 'session' });
  });
});

describe('hook scheduler origins', () => {
  const hook = { kind: 'scheduler' as const, scheduleId: 'hook:slack-1', scheduleName: 'Hook · Team Slack' };

  it('recognises hook-control turns by their hook: schedule id', () => {
    expect(isHookSchedulerOrigin(hook)).toBe(true);
    expect(isHookSchedulerOrigin({ kind: 'scheduler', scheduleId: 'nightly' })).toBe(false);
    expect(isHookSchedulerOrigin({ kind: 'scheduler' })).toBe(false);
    expect(isHookSchedulerOrigin({ kind: 'session', senderSessionId: 'hook:x' })).toBe(false);
    expect(isHookSchedulerOrigin(undefined)).toBe(false);
  });

  it('does not treat hook turns as real automations (no 3-line collapse / short tick)', () => {
    expect(isRealAutomationOrigin(hook)).toBe(false);
    expect(isRealAutomationOrigin({ kind: 'scheduler', scheduleId: 'nightly' })).toBe(true);
    expect(isRealAutomationOrigin({ kind: 'session', senderSessionId: 's' })).toBe(false);
  });

  it('reads the connection name without the Hook prefix', () => {
    expect(hookConnectionNameFromOrigin(hook)).toBe('Team Slack');
    expect(hookConnectionNameFromOrigin({ kind: 'scheduler', scheduleId: 'hook:a', scheduleName: 'Hook · ' })).toBeUndefined();
    expect(hookConnectionNameFromOrigin({ kind: 'scheduler', scheduleId: 'hook:a' })).toBeUndefined();
  });
});
