import type { InteractionRequest } from '@cindy/maker-core';
import type { IMMessageEvent, IMStatus, WecomIM } from '@cindy/im';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatWecomInteractionPrompt, WecomTextInteractions } from '../textInteractions';
import { createSharedPermission } from '../../../maker-ipc/sharedPermission';
import { setMainLocale } from '../../../i18n.desktop';

// 断言中文控制文案:显式锁定界面语言,结束后还原默认。
beforeEach(() => setMainLocale('zh-CN'));
afterEach(() => setMainLocale('en'));

function permissionRequest(
  input: Record<string, unknown>,
  extras: Partial<Extract<InteractionRequest, { kind: 'permission' }>> = {},
): InteractionRequest {
  return {
    kind: 'permission',
    requestId: 'permission-1',
    toolName: 'Bash',
    displayName: '运行命令',
    input,
    ...extras,
  };
}

it('Desktop confirmation clears the text reply waiter and sends the same result', async () => {
  let intercept!: (event: IMMessageEvent) => boolean;
  const sendText = vi.fn(async () => ({ messageId: 'result' }));
  const im = {
    onTextMessageIntercept: (handler: typeof intercept) => { intercept = handler; },
    onStatusChange: vi.fn(),
    sendMarkdownText: vi.fn(async () => ({ messageId: 'prompt' })),
    sendText,
  } as unknown as WecomIM;
  const interactions = new WecomTextInteractions(im);
  const sharedPermission = createSharedPermission();
  const result = interactions.handle('owner', permissionRequest({ command: 'ls' }), { sharedPermission });
  sharedPermission.decide({ kind: 'permission', behavior: 'allow' });
  await expect(result).resolves.toMatchObject({ behavior: 'allow' });
  expect(intercept({ senderId: 'owner', text: '拒绝' } as IMMessageEvent)).toBe(false);
  await vi.waitFor(() => expect(sendText).toHaveBeenCalledWith('owner', expect.stringContaining('已允许')));
});

describe('formatWecomInteractionPrompt', () => {
  it.each([
    { behavior: 'allow' as const, reason: undefined, outcome: '已允许' },
    { behavior: 'deny' as const, reason: 'user_denied', outcome: '已拒绝' },
    { behavior: 'deny' as const, reason: 'session_aborted', outcome: '已失效' },
  ])('only acknowledges a paused choice until the Host settles $outcome', async ({ behavior, reason, outcome }) => {
    let intercept!: (event: IMMessageEvent) => boolean;
    const sendText = vi.fn(async () => ({ messageId: 'result' }));
    const im = {
      onTextMessageIntercept: (handler: typeof intercept) => { intercept = handler; },
      onStatusChange: vi.fn(),
      sendMarkdownText: vi.fn(async () => ({ messageId: 'prompt' })),
      sendText,
    } as unknown as WecomIM;
    const interactions = new WecomTextInteractions(im);
    const sharedPermission = createSharedPermission();
    // The Host accepts the proposal but holds execution while paused.
    sharedPermission.decide = vi.fn(() => true);
    const result = interactions.handle('owner', permissionRequest({}), { sharedPermission });
    await Promise.resolve();
    expect(intercept({ senderId: 'owner', text: '允许' } as IMMessageEvent)).toBe(true);
    await Promise.resolve();
    expect(sharedPermission.decide).toHaveBeenCalledWith({ kind: 'permission', behavior: 'allow' });
    expect(sharedPermission.decision).toBeUndefined();
    expect(sendText.mock.calls).toEqual([['owner', '已收到你的选择。']]);
    sharedPermission.settle({ kind: 'permission', behavior, ...(reason ? { reason } : {}) });
    await expect(result).resolves.toMatchObject({ behavior });
    await vi.waitFor(() => expect(sendText).toHaveBeenLastCalledWith('owner', expect.stringContaining(outcome)));
    expect(sendText).toHaveBeenCalledTimes(2);
  });

  it('在允许用户审批前展示工具参数', () => {
    const prompt = formatWecomInteractionPrompt(
      permissionRequest({
        command: 'pnpm test',
        path: 'D:\\workspace\\cindy',
      }),
    );

    expect(prompt).toContain('需要确认工具“运行命令”');
    // Shell tools show the command itself, not a JSON envelope.
    expect(prompt).toContain('操作：\n```\npnpm test\n```');
    expect(prompt).toContain('回复“允许”执行一次');
    expect(prompt).not.toContain('自动审批没完成');
  });

  it('自动审批故障时在确认提示里写明原因', () => {
    const prompt = formatWecomInteractionPrompt(
      permissionRequest({ command: 'pnpm test' }, { metadata: { autoReviewUnavailable: true } }),
    );

    expect(prompt).toContain('自动审批没完成，请确认要不要允许这次操作。');
    expect(prompt).toContain('需要确认工具“运行命令”');
    expect(prompt).toContain('回复“允许”执行一次');
  });

  it('截断过长参数，避免审批提示无限增长', () => {
    const prompt = formatWecomInteractionPrompt(
      permissionRequest({ payload: 'x'.repeat(2_000) }),
    );

    expect(prompt).toContain('…（已截断）');
    expect(prompt).not.toContain('x'.repeat(1_000));
    expect(prompt.length).toBeLessThan(1_100);
  });

  it('参数无法序列化时显示明确占位', () => {
    const input: Record<string, unknown> = {};
    input.self = input;

    expect(formatWecomInteractionPrompt(permissionRequest(input))).toContain('<无法序列化>');
  });

  it('保留模板 Markdown，并阻止参数内容闭合代码围栏', () => {
    const prompt = formatWecomInteractionPrompt(
      permissionRequest({ command: '```markdown\n@all' }),
    );

    expect(prompt.match(/```/g)).toHaveLength(2);
    expect(prompt).toContain('\\u0060\\u0060\\u0060markdown');
  });

  it('通过 Markdown 通道发送审批模板，并在终止状态下拒绝待审批请求', async () => {
    const sendMarkdownText = vi.fn(async () => ({ messageId: 'message-1' }));
    const sendText = vi.fn(async () => ({ messageId: 'message-2' }));
    const onStatusChange = vi.fn((handler: (status: IMStatus) => void) => {
      void handler;
      return () => undefined;
    });
    const im = {
      onTextMessageIntercept: vi.fn(() => () => undefined),
      onStatusChange,
      sendMarkdownText,
      sendText,
    } as unknown as WecomIM;
    const interactions = new WecomTextInteractions(im);

    const statusHandler = onStatusChange.mock.calls[0]?.[0];
    expect(statusHandler).toBeDefined();
    const terminalStatuses: IMStatus[] = [
      { kind: 'idle' },
      { kind: 'conflict', appId: 'bot-1' },
      { kind: 'error', reason: 'connection_failed' },
    ];

    for (const [index, status] of terminalStatuses.entries()) {
      const result = interactions.handle('owner', permissionRequest({ command: 'pnpm test' }));
      await vi.waitFor(() => expect(sendMarkdownText).toHaveBeenCalledTimes(index + 1));
      statusHandler?.(status);
      await expect(result).resolves.toEqual({
        kind: 'permission',
        behavior: 'deny',
        reason: 'wecom_interaction_disconnected',
      });
      // 非共享确认也要在收口时给一句最终结果(尽力发送, 失败不影响决定)。
      await vi.waitFor(() =>
        expect(sendText).toHaveBeenLastCalledWith('owner', '❌ 已拒绝：Bash'),
      );
    }
    expect(sendText).toHaveBeenCalledTimes(terminalStatuses.length);
  });

  it('待审批时让 !stop 绕过拦截器并收口当前请求', async () => {
    let intercept: ((event: IMMessageEvent) => boolean) | undefined;
    const sendMarkdownText = vi.fn(async () => ({ messageId: 'message-1' }));
    const sendText = vi.fn(async () => ({ messageId: 'message-2' }));
    const im = {
      onTextMessageIntercept: vi.fn((handler: (event: IMMessageEvent) => boolean) => {
        intercept = handler;
        return () => undefined;
      }),
      onStatusChange: vi.fn(() => () => undefined),
      sendMarkdownText,
      sendText,
    } as unknown as WecomIM;
    const interactions = new WecomTextInteractions(im);

    const result = interactions.handle('owner', permissionRequest({ command: 'rm -rf build' }));
    await vi.waitFor(() => expect(sendMarkdownText).toHaveBeenCalledOnce());

    const consumed = intercept?.({
      channelName: 'wecom',
      senderId: 'owner',
      chatId: 'owner',
      contextId: 'bot-1',
      messageId: 'stop-1',
      text: ' !STOP ',
      attachments: [],
      unsupported: [],
    });

    expect(consumed).toBe(false);
    await expect(result).resolves.toEqual({
      kind: 'permission',
      behavior: 'deny',
      reason: 'wecom_interaction_cancelled_by_stop',
    });
    // 只发最终结果, 不发"已收到"(非共享没有暂停语义)。
    expect(sendText.mock.calls).toEqual([['owner', '❌ 已拒绝：Bash']]);
  });

  it('投递失败时用稳定系统码收口，不把 Error.message 当成拒绝原因', async () => {
    const sendMarkdownText = vi.fn(async () => {
      throw new Error('Request failed with status code 500');
    });
    const im = {
      onTextMessageIntercept: vi.fn(() => () => undefined),
      onStatusChange: vi.fn(() => () => undefined),
      sendMarkdownText,
      sendText: vi.fn(),
    } as unknown as WecomIM;
    const interactions = new WecomTextInteractions(im);

    await expect(interactions.handle('owner', permissionRequest({ command: 'pnpm test' })))
      .resolves.toEqual({
        kind: 'permission',
        behavior: 'deny',
        reason: 'wecom_interaction_send_failed',
      });
  });
});

/**
 * 模板卡片确认。
 *
 * 测试价值
 * - 生产入口与可观察结果: WecomTextInteractions.handle + 传输层 onCardAction —— 主人
 *   在企微里点“允许/拒绝”按钮, 与桌面/手机一样只提交 SharedPermission 决定。
 * - Bug／规则依据: im-permission-confirmation.md「暂停期间收到点击仅提交选择」；
 *   本轮要求回调不等模型、旧卡/重复点击/取消不串轮。
 * - 现有覆盖缺口: 文字回复路径已覆盖, 卡片入口是新增的。
 * - 最小失败输入: 桌面先给了决定, 卡片上再来一次点击（应当被忽略）。
 * - tier: unit(进程内 fake 传输层, 不发真实消息)。
 */
describe('wecom template card confirmation', () => {
  it('keeps a text decision when the in-flight prompt later fails', async () => {
    let rejectPrompt!: (error: Error) => void;
    let intercept!: (event: { senderId: string; text: string }) => boolean;
    const { im } = cardIm({
      onTextMessageIntercept: (handler: typeof intercept) => { intercept = handler; },
      sendMarkdownText: () => new Promise((_resolve, reject) => { rejectPrompt = reject; }),
    });
    const result = new WecomTextInteractions(im).handle('owner', permissionRequest({}));
    expect(intercept({ senderId: 'owner', text: '允许' })).toBe(true);
    rejectPrompt(new Error('prompt ACK lost'));
    await expect(result).resolves.toMatchObject({ behavior: 'allow' });
    expect(im.sendInteractiveCard).not.toHaveBeenCalled();
  });

  // PR #10190: a valid click can precede the send ACK (or its failure).
  // Unit: handle + authenticated card event must settle once, without accepting an old card.
  it.each([false, true])('accepts an early click even when the send ACK fails: %s', async (failAck) => {
    let finish!: () => void;
    const sendInteractiveCard = vi.fn((
      _userId: string,
      _spec: unknown,
      options?: { onRegistered?: (messageId: string) => void },
    ) => {
      options?.onRegistered?.('card-early');
      return new Promise<{ messageId: string }>((resolve, reject) => {
        finish = () => failAck ? reject(new Error('ACK lost')) : resolve({ messageId: 'card-early' });
      });
    });
    const { im, click } = cardIm({ sendInteractiveCard });
    const sharedPermission = createSharedPermission();
    const decide = vi.spyOn(sharedPermission, 'decide');
    const result = new WecomTextInteractions(im).handle('owner', permissionRequest({}), { sharedPermission });
    await Promise.resolve();
    const event = { senderId: 'owner', messageId: 'card-old', payload: { value: '允许' } };
    click(event);
    expect(decide).not.toHaveBeenCalled();
    click({ ...event, messageId: 'card-early' });
    click({ ...event, messageId: 'card-early' });
    const decisionBeforeAck = sharedPermission.decision;
    const choiceCount = decide.mock.calls.length;
    // Clean up the pending request even on the unfixed implementation.
    sharedPermission.settle({ kind: 'permission', behavior: 'deny' });
    finish();
    await result;
    expect(decisionBeforeAck).toMatchObject({ behavior: 'allow' });
    expect(choiceCount).toBe(1);
  });

  function cardIm(overrides: Record<string, unknown> = {}) {
    let cardHandler: ((event: unknown) => void) | undefined;
    const sentCards: Array<{ userId: string; spec: unknown }> = [];
    const updates: Array<{ messageId: string; spec: unknown }> = [];
    const im = {
      onTextMessageIntercept: vi.fn(() => () => undefined),
      onStatusChange: vi.fn(() => () => undefined),
      onCardAction: (handler: (event: unknown) => void) => {
        cardHandler = handler;
        return () => undefined;
      },
      supportsTemplateCards: true,
      sendInteractiveCard: vi.fn(async (userId: string, spec: unknown) => {
        sentCards.push({ userId, spec });
        return { messageId: 'card-1' };
      }),
      updateInteractiveCard: vi.fn(async (messageId: string, spec: unknown) => {
        updates.push({ messageId, spec });
      }),
      sendMarkdownText: vi.fn(async () => ({ messageId: 'prompt' })),
      sendText: vi.fn(async () => ({ messageId: 'ack' })),
      ...overrides,
    } as unknown as WecomIM;
    return { im, sentCards, updates, click: (event: unknown) => cardHandler?.(event) };
  }

  // #10202/r4558852226: actual cards and settled plan results were Chinese even
  // in non-Chinese locales. Unit through handle + authenticated card callback;
  // switch locale after presentation to also protect the stable button value.
  it.each(['permission', 'plan_review'] as const)('localizes %s cards and results across a language switch', async (kind) => {
    setMainLocale('de');
    const { im, sentCards, click } = cardIm();
    const interactions = new WecomTextInteractions(im);
    const request = kind === 'permission'
      ? permissionRequest({ command: 'pwd' }, { displayName: 'Bash' })
      : { kind: 'plan_review' as const, requestId: 'localized-plan', plan: 'Read logs.' };
    const result = interactions.handle('owner', request);
    await vi.waitFor(() => expect(sentCards).toHaveLength(1));
    const spec = sentCards[0]!.spec as { title: string; body: string; buttons: Array<{ label: string; payload: { value: string } }> };
    expect(spec.title).toContain(kind === 'permission' ? 'Aktion' : 'Plan');
    expect(spec.buttons[0]!.label).toBe(kind === 'permission' ? 'Einmal erlauben' : 'Plan genehmigen');
    expect(spec.buttons[1]!.label).toBe(kind === 'permission' ? 'Aktion ablehnen' : 'Plan ablehnen');
    expect(spec.body).not.toMatch(/[\u3400-\u9fff]/);
    setMainLocale('en');
    click({ senderId: 'owner', messageId: 'card-1', payload: spec.buttons[0]!.payload });
    await expect(result).resolves.toMatchObject({ kind, behavior: 'allow' });
    await vi.waitFor(() => expect(im.sendText).toHaveBeenCalledWith('owner',
      expect.stringContaining(kind === 'permission' ? 'Allowed' : 'Plan approved')));
  });

  it('submits the button choice to the shared permission without waiting for a model', async () => {
    const { im, sentCards, click } = cardIm();
    const interactions = new WecomTextInteractions(im);
    const sharedPermission = createSharedPermission();
    const result = interactions.handle('owner', permissionRequest({ command: 'ls' }), { sharedPermission });
    await vi.waitFor(() => expect(sentCards).toHaveLength(1));
    const spec = sentCards[0]!.spec as { buttons: Array<{ id: string; payload?: { value?: string } }> };
    // 按钮只带语义值; token 由传输层每次随机生成。
    expect(spec.buttons.map((button) => button.payload?.value)).toEqual(['允许', '拒绝']);

    click({
      channelName: 'wecom',
      senderId: 'owner',
      chatId: 'owner',
      messageId: 'card-1',
      buttonId: 'random-token',
      payload: { value: '允许' },
    });
    await expect(result).resolves.toMatchObject({ behavior: 'allow' });
    expect(sharedPermission.decision).toMatchObject({ behavior: 'allow' });
  });

  it('always sends the full operation before the approval card (short command)', async () => {
    const { im, sentCards } = cardIm();
    const interactions = new WecomTextInteractions(im);
    void interactions.handle('owner', permissionRequest({ command: 'ls' }));
    await vi.waitFor(() => expect(sentCards).toHaveLength(1));

    const prompt = vi.mocked(im.sendMarkdownText).mock.calls[0]?.[1] ?? '';
    // 「Bash + ls」这种短命令也必须让主人在按按钮前看到实际操作。
    expect(prompt).toContain('ls');
    expect(prompt).toContain('需要确认工具');
    const promptOrder = vi.mocked(im.sendMarkdownText).mock.invocationCallOrder[0]!;
    const cardOrder = vi.mocked(im.sendInteractiveCard).mock.invocationCallOrder[0]!;
    expect(promptOrder).toBeLessThan(cardOrder);
  });

  it('always sends the plan text before the approval card (short plan)', async () => {
    const { im, sentCards } = cardIm();
    const interactions = new WecomTextInteractions(im);
    void interactions.handle('owner', {
      kind: 'plan_review',
      requestId: 'plan-1',
      plan: '先读日志再改配置。',
    } as unknown as InteractionRequest);
    await vi.waitFor(() => expect(sentCards).toHaveLength(1));

    const prompt = vi.mocked(im.sendMarkdownText).mock.calls[0]?.[1] ?? '';
    expect(prompt).toContain('先读日志再改配置。');
  });

  it('does not expose an approval card when the full prompt cannot be sent', async () => {
    const sendMarkdownText = vi.fn(async () => {
      throw new Error('prompt delivery failed');
    });
    const { im } = cardIm({ sendMarkdownText });
    const interactions = new WecomTextInteractions(im);
    await expect(
      interactions.handle('owner', permissionRequest({ command: 'ls' })),
    ).resolves.toEqual({
      kind: 'permission',
      behavior: 'deny',
      reason: 'wecom_interaction_send_failed',
    });
    expect(vi.mocked(im.sendInteractiveCard)).not.toHaveBeenCalled();
  });

  it('reports a plan review result on the non-shared path', async () => {
    let intercept!: (event: { senderId: string; text: string }) => boolean;
    const sendText = vi.fn(async () => ({ messageId: 'x' }));
    const im = {
      onTextMessageIntercept: (handler: typeof intercept) => {
        intercept = handler;
        return () => undefined;
      },
      onStatusChange: vi.fn(() => () => undefined),
      sendMarkdownText: vi.fn(async () => ({ messageId: 'p' })),
      sendText,
    } as unknown as WecomIM;
    const interactions = new WecomTextInteractions(im);
    const handle = interactions.handle('owner', {
      kind: 'plan_review',
      requestId: 'plan-1',
      plan: '先读日志再改配置。',
    } as unknown as InteractionRequest);
    await vi.waitFor(() => expect(im.sendMarkdownText).toHaveBeenCalled());
    expect(intercept({ senderId: 'owner', text: '批准' })).toBe(true);
    await expect(handle).resolves.toMatchObject({ behavior: 'allow' });
    // 计划结论用计划口径, 不能拿 permission 文案说成“已拒绝”。
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledWith('owner', '✅ 已批准计划'));
  });

  it('marks a replaced plan review as expired instead of denied', async () => {
    let intercept!: (event: { senderId: string; text: string }) => boolean;
    const sendText = vi.fn(async () => ({ messageId: 'x' }));
    const im = {
      onTextMessageIntercept: (handler: typeof intercept) => {
        intercept = handler;
        return () => undefined;
      },
      onStatusChange: vi.fn(() => () => undefined),
      sendMarkdownText: vi.fn(async () => ({ messageId: 'p' })),
      sendText,
    } as unknown as WecomIM;
    const interactions = new WecomTextInteractions(im);
    const first = interactions.handle('owner', {
      kind: 'plan_review',
      requestId: 'plan-old',
      plan: '旧计划',
    } as unknown as InteractionRequest);
    await vi.waitFor(() => expect(im.sendMarkdownText).toHaveBeenCalledTimes(1));
    // 新的确认请求顶掉旧计划: 旧请求收口为失效, 新请求不受影响。
    void interactions.handle('owner', permissionRequest({ command: 'ls' }));
    await expect(first).resolves.toMatchObject({
      kind: 'plan_review',
      behavior: 'deny',
      reason: 'replaced_by_new_request',
    });
    await vi.waitFor(() =>
      expect(sendText).toHaveBeenCalledWith('owner', '⌛ 本次计划确认已失效'),
    );
    // 旧请求的收口不会清掉新请求。
    expect(intercept({ senderId: 'owner', text: '允许' })).toBe(true);
  });

  it('does not send a card when the decision lands while the prompt is still sending', async () => {
    let resolvePrompt!: () => void;
    const sendMarkdownText = vi.fn(
      () =>
        new Promise((resolve) => {
          resolvePrompt = () => resolve({ messageId: 'prompt' });
        }),
    );
    const { im, sentCards } = cardIm({ sendMarkdownText });
    const interactions = new WecomTextInteractions(im);
    const sharedPermission = createSharedPermission();
    const handle = interactions.handle('owner', permissionRequest({ command: 'ls' }), {
      sharedPermission,
    });
    await vi.waitFor(() => expect(sendMarkdownText).toHaveBeenCalled());
    // 桌面先给了最终决定: 提示发完后不能再出现可批准卡。
    sharedPermission.decide({ kind: 'permission', behavior: 'allow' });
    resolvePrompt();
    await expect(handle).resolves.toMatchObject({ behavior: 'allow' });
    expect(sentCards).toEqual([]);
    expect(vi.mocked(im.sendInteractiveCard)).not.toHaveBeenCalled();
  });

  it('expires a card that comes back after the decision already settled', async () => {
    let resolveCard!: (value: { messageId: string }) => void;
    const sendInteractiveCard = vi.fn(
      () =>
        new Promise<{ messageId: string }>((resolve) => {
          resolveCard = resolve;
        }),
    );
    const { im, updates, click } = cardIm({ sendInteractiveCard });
    const interactions = new WecomTextInteractions(im);
    const sharedPermission = createSharedPermission();
    const decide = vi.spyOn(sharedPermission, 'decide');
    const handle = interactions.handle('owner', permissionRequest({}), { sharedPermission });
    await vi.waitFor(() => expect(sendInteractiveCard).toHaveBeenCalled());

    // 卡片请求还在飞时桌面先决定。
    sharedPermission.settle({ kind: 'permission', behavior: 'allow' });
    resolveCard({ messageId: 'card-late' });
    await expect(handle).resolves.toMatchObject({ behavior: 'allow' });

    // 晚返回的卡必须被立即本地失效(平台允许时带撤按钮更新)。
    await vi.waitFor(() =>
      expect(updates).toContainEqual({
        messageId: 'card-late',
        spec: expect.objectContaining({ buttons: [] }),
      }),
    );
    // 迟到点击不能再提交第二份决定。
    const settleCalls = decide.mock.calls.length;
    click({
      channelName: 'wecom',
      senderId: 'owner',
      chatId: 'owner',
      messageId: 'card-late',
      buttonId: 'tok-late',
      payload: { value: '允许' },
    });
    expect(decide.mock.calls.length).toBe(settleCalls);
  });

  it('keeps the new entry intact when an old card resolves during replacement', async () => {
    const pendingCards: Array<(value: { messageId: string }) => void> = [];
    const sendInteractiveCard = vi.fn(
      () =>
        new Promise<{ messageId: string }>((resolve) => {
          pendingCards.push(resolve);
        }),
    );
    const { im, updates, click } = cardIm({ sendInteractiveCard });
    const interactions = new WecomTextInteractions(im);
    const first = interactions.handle('owner', permissionRequest({ requestId: 'first' }));
    await vi.waitFor(() => expect(sendInteractiveCard).toHaveBeenCalledTimes(1));
    // 新请求替换旧请求(旧卡还在飞): 旧请求按"已替换"收口。
    const second = interactions.handle('owner', permissionRequest({ requestId: 'second' }));
    await vi.waitFor(() => expect(sendInteractiveCard).toHaveBeenCalledTimes(2));

    pendingCards[0]!({ messageId: 'card-old' });
    await expect(first).resolves.toMatchObject({
      kind: 'permission',
      behavior: 'deny',
      reason: 'replaced_by_new_request',
    });
    // 旧卡被失效, 新 entry 不受影响。
    await vi.waitFor(() =>
      expect(updates).toContainEqual({
        messageId: 'card-old',
        spec: expect.objectContaining({ buttons: [] }),
      }),
    );
    // 旧卡点击无效; 新卡点击仍可提交。
    click({
      channelName: 'wecom',
      senderId: 'owner',
      chatId: 'owner',
      messageId: 'card-old',
      buttonId: 'tok-old',
      payload: { value: '允许' },
    });
    pendingCards[1]!({ messageId: 'card-new' });
    // 让发卡 promise 的后续微任务先记下 cardId。
    await Promise.resolve();
    await Promise.resolve();
    click({
      channelName: 'wecom',
      senderId: 'owner',
      chatId: 'owner',
      messageId: 'card-new',
      buttonId: 'tok-new',
      payload: { value: '拒绝' },
    });
    await expect(second).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('keeps the decision when the remote card update fails', async () => {
    const updateInteractiveCard = vi.fn(async () => {
      throw new Error('card update rejected');
    });
    const { im } = cardIm({ updateInteractiveCard });
    const interactions = new WecomTextInteractions(im);
    const sharedPermission = createSharedPermission();
    const handle = interactions.handle('owner', permissionRequest({}), { sharedPermission });
    await vi.waitFor(() => expect(im.sendInteractiveCard).toHaveBeenCalled());
    sharedPermission.settle({ kind: 'permission', behavior: 'deny', reason: 'desktop_denied' });
    await expect(handle).resolves.toMatchObject({ behavior: 'deny' });
    // 远端撤按钮失败不影响已经生效的决定。
    expect(sharedPermission.decision).toMatchObject({ behavior: 'deny' });
  });

  it('ignores a click on a stale card and on a card after the decision settled', async () => {
    const { im, sentCards, click } = cardIm();
    const interactions = new WecomTextInteractions(im);
    const sharedPermission = createSharedPermission();
    const result = interactions.handle('owner', permissionRequest({}), { sharedPermission });
    await vi.waitFor(() => expect(sentCards).toHaveLength(1));

    // 旧卡(不是本请求那张)的点击不生效。
    click({
      channelName: 'wecom',
      senderId: 'owner',
      chatId: 'owner',
      messageId: 'card-old',
      buttonId: 'token',
      payload: { value: '允许' },
    });
    expect(sharedPermission.decision).toBeUndefined();

    // 桌面先给了决定: 卡片远端收口, 之后的点击一律忽略。
    sharedPermission.settle({ kind: 'permission', behavior: 'deny', reason: 'desktop_denied' });
    await expect(result).resolves.toMatchObject({ behavior: 'deny' });
    click({
      channelName: 'wecom',
      senderId: 'owner',
      chatId: 'owner',
      messageId: 'card-1',
      buttonId: 'token',
      payload: { value: '允许' },
    });
    expect(sharedPermission.decision).toMatchObject({ behavior: 'deny' });
  });
});

it.each([
  ['permission', 'erlauben', 'allow'], ['permission', 'ablehnen', 'deny'],
  ['plan_review', 'genehmigen', 'allow'], ['plan_review', 'ablehnen', 'deny'],
] as const)('keeps pending %s reply %s valid after a language change', async (kind, reply, behavior) => {
  let intercept!: (event: IMMessageEvent) => boolean;
  const im = {
    onTextMessageIntercept: (handler: typeof intercept) => { intercept = handler; },
    onStatusChange: vi.fn(),
    sendMarkdownText: vi.fn(async (_user: string, prompt: string) => { expect(prompt).toContain(reply); }),
    sendText: vi.fn(async () => ({})),
  } as unknown as WecomIM;
  const interactions = new WecomTextInteractions(im);
  setMainLocale('de');
  const request: InteractionRequest = kind === 'permission' ? permissionRequest({})
    : { kind, requestId: 'switch', plan: 'Plan' };
  const result = interactions.handle('user', request);
  setMainLocale('en');
  intercept({ senderId: 'user', text: 'unrelated' } as IMMessageEvent);
  expect(im.sendText).toHaveBeenCalledWith('user', expect.stringContaining('erlauben'));
  intercept({ senderId: 'user', text: reply } as IMMessageEvent);
  await expect(result).resolves.toMatchObject({ kind, behavior });
});
