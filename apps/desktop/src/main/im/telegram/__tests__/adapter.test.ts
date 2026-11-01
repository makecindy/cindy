import { describe, expect, it, vi } from 'vitest';
import type { IMMessageEvent } from '@cindy/im';

import { buildTelegramAdapter, TELEGRAM_TOOLS_HINT } from '../adapter';
import { ui } from '../uiText';
vi.mock('../groupWindow', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../groupWindow')>()),
  buildTelegramGroupContextPrefix: vi.fn(async () => ({
    prefix: '<group_chat_context>\n[Tom] (附件: IMG_80.MP4)\n</group_chat_context>\n',
    messageCount: 1,
    messageIds: ['80'],
    commit: vi.fn(),
  })),
}));
vi.mock('../behaviorStore', () => ({
  readTelegramPersona: () => ({ botName: 'Private persona', soul: 'Private instructions' }),
}));

describe('Telegram group history access scope', () => {
  const adapter = buildTelegramAdapter({ getOwnerUserId: () => '123' } as never, {} as never);

  it('clears successful and cancelled status reactions but retains an error signal', () => {
    expect(adapter.terminalReactionEmoji?.('done')).toBeNull();
    expect(adapter.terminalReactionEmoji?.('aborted')).toBeNull();
    expect(adapter.terminalReactionEmoji?.('error')).toBe('👎');
  });

  it('saves the actual quoted text but excludes persona and technical instructions', async () => {
    const result = await adapter.prepareAgentTurnText?.({
      senderId: '123',
      text: 'question',
      replyContext: { author: 'Alice', text: 'quoted text' },
    } as IMMessageEvent);
    expect(result?.agentText).toContain('Private instructions');
    expect(result?.contextSnapshot).toEqual({ replyContext: '[Alice] quoted text', replyMessageCount: 1 });
    // The same reply the model sees is the one Auto-review may use.
    expect(result?.replyContext).toEqual({ author: 'Alice', text: 'quoted text' });
  });

  it('drops the settings-page persona on a teammate-owned connection', async () => {
    const teammate = buildTelegramAdapter({ getOwnerUserId: () => '123' } as never, {} as never, {
      companionBotId: 'bot-mimi',
    });
    const bound = await teammate.prepareAgentTurnText?.({
      contextId: 'bot-1',
      senderId: '123',
      text: 'question',
      replyContext: { author: 'Alice', text: 'quoted text' },
    } as IMMessageEvent);
    expect(bound?.agentText).not.toContain('<bot_persona>');
    expect(bound?.agentText).not.toContain('Private instructions');
    expect(bound?.agentText).toContain('quoted text');
    // A teammate DM without a reply block needs no model-only rewrite at all.
    expect(
      await teammate.prepareAgentTurnText?.({ contextId: 'bot-1', senderId: '123', text: 'q' } as IMMessageEvent),
    ).toBeNull();
  });

  it('maps the owner DM, guest DMs and groups / topics to companion lanes', () => {
    expect(adapter.companionLane?.('123')).toEqual({ kind: 'owner-dm' });
    expect(adapter.companionLane?.('999')).toEqual({ kind: 'guest-dm', userId: '999' });
    expect(adapter.companionLane?.('g/-100')).toEqual({ kind: 'group', chatId: '-100', threadId: '' });
    expect(adapter.companionLane?.('g/-100/77')).toEqual({ kind: 'group', chatId: '-100', threadId: '77' });
  });

  it('only lets owner-triggered group turns omit the policy in Full access', () => {
    const groupEvent = {
      messageId: 'm-policy',
      speaker: { id: 'guest', name: 'Guest', isOwner: false },
    } as unknown as IMMessageEvent;
    const guestPolicy = adapter.turnPermissionPolicyFor?.(groupEvent);
    const ownerPolicy = adapter.turnPermissionPolicyFor?.({
      ...groupEvent,
      messageId: 'm-owner-policy',
      speaker: { id: 'owner', name: 'Owner', isOwner: true },
    } as unknown as IMMessageEvent);

    expect(guestPolicy).toMatchObject({
      origin: { kind: 'im', channel: 'telegram', taskId: 'm-policy' },
      confirmationSurface: 'channel',
    });
    expect(ownerPolicy).toBeDefined();
    expect(adapter.turnPolicyOptionalForMode?.('bypassPermissions', guestPolicy!)).toBe(false);
    expect(adapter.turnPolicyOptionalForMode?.('bypassPermissions', ownerPolicy!)).toBe(true);
    expect(adapter.turnPolicyOptionalForMode?.('auto', ownerPolicy!)).toBe(false);
    expect(adapter.turnPolicyOptionalForMode?.('ask', ownerPolicy!)).toBe(false);
  });

  it('teammate bot: owner turns carry no policy, guest turns confirm destructive calls only, Full access wins', () => {
    const teammate = buildTelegramAdapter({ getOwnerUserId: () => '123' } as never, {} as never, {
      companionBotId: 'bot-mimi',
    });
    const ownerPolicy = teammate.turnPermissionPolicyFor?.({
      messageId: 'm-owner',
      speaker: { id: 'owner', name: 'Owner', isOwner: true },
    } as unknown as IMMessageEvent);
    const guestPolicy = teammate.turnPermissionPolicyFor?.({
      messageId: 'm-guest',
      speaker: { id: 'guest', name: 'Guest', isOwner: false },
    } as unknown as IMMessageEvent);

    expect(ownerPolicy).toBeUndefined();
    expect(guestPolicy).toMatchObject({
      origin: { kind: 'im', channel: 'telegram', taskId: 'm-guest' },
      autoReviewContext: { requesterAuthority: 'guest', source: 'group' },
      confirmationSurface: 'channel',
    });
    // Destructive list only: Bash rm is confirmed, a plain Write is left to the teammate's own mode.
    expect(guestPolicy!.forceConfirmToolCall('Bash', { command: 'rm -rf dist' })).toBe(true);
    expect(guestPolicy!.forceConfirmToolCall('Write', { file_path: 'a.md', content: 'x' })).toBe(false);
    // The teammate's permission setting is the only switch: Full access drops the guest policy
    // instead of rejecting the turn; Auto / Ask keep it.
    expect(teammate.turnPolicyOptionalForMode?.('bypassPermissions', guestPolicy!)).toBe(true);
    expect(teammate.turnPolicyOptionalForMode?.('auto', guestPolicy!)).toBe(false);
    expect(teammate.turnPolicyOptionalForMode?.('ask', guestPolicy!)).toBe(false);
  });

  it('does not attach a group confirmation policy to DMs', () => {
    const groupEvent = {
      messageId: 'm-policy',
      speaker: { id: 'guest', name: 'Guest', isOwner: false },
    } as unknown as IMMessageEvent;
    expect(
      adapter.turnPermissionPolicyFor?.({
        ...groupEvent,
        speaker: undefined,
      } as unknown as IMMessageEvent),
    ).toBeUndefined();
  });

  it('explains an unsupported permission mode without exposing the internal error code', () => {
    const message = ui.error.permissionModeUnsupported;
    expect(message).toContain('自动审批');
    expect(message).toContain('/permission');
    expect(message).not.toContain('TURN_PERMISSION_POLICY_UNSUPPORTED');
  });

  it('keeps every group turn lane-only — owner-triggered included (injection hardening)', () => {
    const base = {
      contextId: 'bot-1',
      senderId: 'g/-100/77',
      messageId: 'm-1',
      chatId: '-100',
      text: 'hi',
      attachments: [],
      unsupported: [],
      speaker: { id: 'u-1', name: 'Guest', isOwner: false },
    } as unknown as IMMessageEvent;
    expect(adapter.groupHistoryAccessFor?.(base)).toEqual({
      access: 'lane',
      provider: 'telegram-personal:bot-1',
      readImage: expect.any(Function),
      lane: { provider: 'telegram-personal:bot-1', chatId: '-100', threadId: '77' },
    });
    // owner 在群里触发也不升权: 群窗口携带成员可控文本, 注入可借 owner 轮次
    // 跨 lane 检索并回帖泄漏(与 turnPermissionPolicyFor 同一裁决)。
    expect(
      adapter.groupHistoryAccessFor?.({
        ...base,
        speaker: { id: 'owner', name: 'Owner', isOwner: true },
      } as unknown as IMMessageEvent),
    ).toEqual({
      access: 'lane',
      provider: 'telegram-personal:bot-1',
      readImage: expect.any(Function),
      lane: { provider: 'telegram-personal:bot-1', chatId: '-100', threadId: '77' },
    });
  });

  it('keeps owner DM explicit: no implicit current lane', () => {
    expect(
      adapter.groupHistoryAccessFor?.({
        contextId: 'bot-1',
        senderId: '123',
        messageId: 'm-2',
        chatId: '12345',
        text: '查历史',
        attachments: [],
        unsupported: [],
      } as never),
    ).toEqual({
      access: 'owner',
      provider: 'telegram-personal:bot-1',
      readImage: expect.any(Function),
      lane: null,
    });
  });

  // #7756 security review: guest DMs on companion bots used to get owner history.
  // Unit: the real adapter must omit the lease for a non-owner DM (with/without speaker).
  it.each([undefined, { id: '999', name: 'Guest', isOwner: false }])(
    'does not grant history access to a guest DM: %j',
    (speaker) => {
      const teammate = buildTelegramAdapter({ getOwnerUserId: () => '123' } as never, {} as never, {
        companionBotId: 'bot-mimi',
      });
      expect(teammate.groupHistoryAccessFor?.({
        contextId: 'bot-1', senderId: '999', text: 'history', speaker,
      } as IMMessageEvent)).toBeUndefined();
    },
  );

  it('names the group in the channel note but leaves the speaker to the existing [发言人] line', async () => {
    expect(
      await adapter.channelNoteSourceFor?.({
        contextId: 'bot-1',
        senderId: 'g/-1001',
        messageId: 'm-3',
        chatId: '-1001',
        text: 'hi',
        speaker: { id: '7', name: 'Ann', isOwner: false },
        interactionSource: { chatName: 'Dev Group', senderName: 'Ann' },
        attachments: [],
        unsupported: [],
      } as never),
    ).toEqual({ chatKind: 'group', chatId: '-1001', chatName: 'Dev Group', toolsHint: TELEGRAM_TOOLS_HINT });
  });

  it('describes a guest DM as a direct chat from a non-owner instead of guessing a group from the speaker', async () => {
    expect(
      await adapter.channelNoteSourceFor?.({
        contextId: 'bot-1',
        senderId: '77',
        messageId: 'm-4',
        chatId: '77',
        text: 'hi',
        speaker: { id: '77', name: 'Bob', isOwner: false },
        attachments: [],
        unsupported: [],
      } as never),
    ).toEqual({ chatKind: 'direct', chatId: '77', senderIsOwner: false, senderId: '77', senderName: 'Bob', toolsHint: TELEGRAM_TOOLS_HINT });
    expect(
      await adapter.channelNoteSourceFor?.({ contextId: 'bot-1', senderId: '123', chatId: '123', text: 'hi' } as never),
    ).toEqual({ chatKind: 'direct', chatId: '123', toolsHint: TELEGRAM_TOOLS_HINT });
  });

  it('scopes the Bot API tools to the triggering chat and the verified requester identity', () => {
    const im = { getOwnerUserId: () => '123' } as never;
    const personal = buildTelegramAdapter(im, {} as never);
    const teammate = buildTelegramAdapter(im, {} as never, { companionBotId: 'bot-mimi' });
    const group = personal.channelToolScopeFor?.({
      contextId: 'bot-1', senderId: 'g/-100/7', messageId: '-100|81', chatId: '-100', text: 'hi',
      speaker: { id: '9', name: 'Guest', isOwner: false },
    } as never);
    expect(group).toMatchObject({
      channel: 'telegram', im, botId: 'bot-1', laneUserId: 'g/-100/7', chatId: '-100', threadId: '7',
      chatKind: 'group', requesterIsOwner: false, triggerMessageId: '81', companion: false,
    });
    expect(
      personal.channelToolScopeFor?.({
        contextId: 'bot-1', senderId: 'g/-100', messageId: '-100|82', chatId: '-100', text: 'hi',
        speaker: { id: '123', name: 'Owner', isOwner: true },
      } as never),
    ).toMatchObject({ threadId: '', requesterIsOwner: true, triggerMessageId: '82' });
    // Owner DM: the owner id is the lane, no speaker on a personal bot.
    expect(
      personal.channelToolScopeFor?.({ contextId: 'bot-1', senderId: '123', messageId: '123|5', chatId: '123', text: 'hi' } as never),
    ).toMatchObject({ chatKind: 'direct', chatId: '123', laneUserId: '123', requesterIsOwner: true, triggerMessageId: '5' });
    // Teammate guest DM carries a non-owner speaker and is never treated as the owner.
    expect(
      teammate.channelToolScopeFor?.({
        contextId: 'conn-1', senderId: '77', messageId: '77|6', chatId: '77', text: 'hi',
        speaker: { id: '77', name: 'Bob', isOwner: false },
      } as never),
    ).toMatchObject({ chatKind: 'direct', chatId: '77', requesterIsOwner: false, companion: true, botId: 'conn-1' });
    // An undecodable message id degrades to "no default target" instead of throwing.
    expect(
      personal.channelToolScopeFor?.({ contextId: 'bot-1', senderId: '123', messageId: 'weird', chatId: '123', text: 'hi' } as never),
    ).toMatchObject({ triggerMessageId: '' });
  });
});

/** codec 的 `${chatId}|${messageId}` 形态(decodeTelegramMessageId 的逆)。 */
const TRIGGER_MESSAGE_ID = '-100200|81';

describe('Telegram group history media', () => {
  it('supplies media from the included group messages to the model only', async () => {
    const collectGroupHistoryMedia = vi.fn(async () => ({
      attachments: [
        { kind: 'file' as const, absPath: '/tmp/IMG_80.MP4', originalName: 'IMG_80.MP4', mimeType: 'video/mp4', author: 'Tom' },
      ],
      unavailable: [],
    }));
    const adapter = buildTelegramAdapter({ collectGroupHistoryMedia } as never, {} as never);
    const result = await adapter.prepareAgentTurnText?.({
      contextId: 'bot-1',
      senderId: 'g/-100200',
      messageId: TRIGGER_MESSAGE_ID,
      chatId: '-100200',
      text: '能鉴定吗',
      attachments: [],
      unsupported: [],
      speaker: { id: '222', name: 'Tom', isOwner: false },
    } as never);
    expect(collectGroupHistoryMedia).toHaveBeenCalledWith('-100200', ['80'], undefined);
    expect(result?.contextAttachments).toEqual([
      { kind: 'file', absPath: '/tmp/IMG_80.MP4', originalName: 'IMG_80.MP4', mimeType: 'video/mp4' },
    ]);
    expect(result?.agentText).toContain('IMG_80.MP4（Tom）');
    expect(result?.agentText.indexOf('<group_chat_attachments>')).toBeGreaterThan(
      result!.agentText.indexOf('</group_chat_context>'),
    );
  });

  it('skips history media for ambient (always-respond) turns', async () => {
    const collectGroupHistoryMedia = vi.fn();
    const adapter = buildTelegramAdapter({ collectGroupHistoryMedia } as never, {} as never);
    const result = await adapter.prepareAgentTurnText?.({
      contextId: 'bot-1',
      senderId: 'g/-100200',
      messageId: TRIGGER_MESSAGE_ID,
      chatId: '-100200',
      text: 'chat',
      attachments: [],
      unsupported: [],
      ambient: true,
    } as never);
    expect(collectGroupHistoryMedia).not.toHaveBeenCalled();
    expect(result?.contextAttachments).toBeUndefined();
  });

  it('keeps the turn going when history media download throws', async () => {
    const adapter = buildTelegramAdapter(
      { collectGroupHistoryMedia: vi.fn(async () => Promise.reject(new Error('net'))) } as never,
      {} as never,
    );
    const result = await adapter.prepareAgentTurnText?.({
      contextId: 'bot-1',
      senderId: 'g/-100200',
      messageId: TRIGGER_MESSAGE_ID,
      chatId: '-100200',
      text: 'hi',
      attachments: [],
      unsupported: [],
    } as never);
    expect(result?.contextAttachments).toBeUndefined();
    expect(result?.agentText).toContain('hi');
  });
});

describe('Telegram ambient reply gate', () => {
  const groupEvent = {
    contextId: 'bot-1',
    senderId: 'g/-100',
    messageId: '-100:81',
    text: 'Mia, is the changelog ready?',
    ambient: true,
    invoked: false,
    speaker: { id: 'tom', name: 'Tom', username: 'tom', isOwner: false },
  } as unknown as IMMessageEvent;

  it('asks the judge with group background, speaker, message and the bot identity; skip wins', async () => {
    const judge = vi.fn(async () => 'skip' as const);
    const adapter = buildTelegramAdapter(
      { getOwnerUserId: () => '123', botName: 'mia_bot' } as never,
      {} as never,
      {
        companionBotId: 'bot-mimi',
        ambientReplyJudge: judge,
        describeSelfForAmbientJudge: async () => ({ name: 'Mia', description: 'Release helper' }),
      },
    );
    await expect(adapter.ambientTurnGate?.(groupEvent)).resolves.toBe('skip');
    expect(judge).toHaveBeenCalledTimes(1);
    const input = (judge.mock.calls[0] as unknown[])[0] as Record<string, string>;
    expect(input.botName).toBe('Mia');
    expect(input.botDescription).toBe('Release helper');
    expect(input.groupContext).toContain('<group_chat_context>');
    expect(input.speaker).toContain('Tom');
    expect(input.speaker).toContain('@tom');
    expect(input.text).toBe('Mia, is the changelog ready?');
  });

  it('proceeds on reply / unknown verdicts, without a judge, and for direct messages', async () => {
    for (const verdict of ['reply', 'unknown'] as const) {
      const adapter = buildTelegramAdapter({ getOwnerUserId: () => '123', botName: 'mia_bot' } as never, {} as never, {
        ambientReplyJudge: async () => verdict,
      });
      await expect(adapter.ambientTurnGate?.(groupEvent)).resolves.toBe('proceed');
    }
    const noJudge = buildTelegramAdapter({ getOwnerUserId: () => '123' } as never, {} as never);
    await expect(noJudge.ambientTurnGate?.(groupEvent)).resolves.toBe('proceed');
    const dmJudge = vi.fn(async () => 'skip' as const);
    const dm = buildTelegramAdapter({ getOwnerUserId: () => '123' } as never, {} as never, { ambientReplyJudge: dmJudge });
    await expect(dm.ambientTurnGate?.({ ...groupEvent, senderId: '999' } as IMMessageEvent)).resolves.toBe('proceed');
    expect(dmJudge).not.toHaveBeenCalled();
  });

  it('uses the settings-page persona as identity for the personal bot', async () => {
    const judge = vi.fn(async () => 'reply' as const);
    const adapter = buildTelegramAdapter({ getOwnerUserId: () => '123', botName: 'mia_bot' } as never, {} as never, {
      ambientReplyJudge: judge,
    });
    await adapter.ambientTurnGate?.(groupEvent);
    const input = (judge.mock.calls[0] as unknown[])[0] as Record<string, string>;
    expect(input.botName).toBe('Private persona');
    expect(input.botDescription).toBe('Private instructions');
  });
});
