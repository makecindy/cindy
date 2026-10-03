import type { InteractionRequest } from '@cindy/maker-core';
import type { IMMessageEvent, IMStatus, WecomIM } from '@cindy/im';
import { describe, expect, it, vi } from 'vitest';

import { formatWecomInteractionPrompt, WecomTextInteractions } from '../textInteractions';
import { createSharedPermission } from '../../../maker-ipc/sharedPermission';

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
    expect(prompt).toContain('"command": "pnpm test"');
    expect(prompt).toContain('"path": "D:\\\\workspace\\\\cindy"');
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
    }
    expect(sendText).not.toHaveBeenCalled();
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
    expect(sendText).not.toHaveBeenCalled();
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
