import type { InteractionRequest } from '@cindy/maker-core';
import type { IMMessageEvent, IMStatus, WecomIM } from '@cindy/im';
import { describe, expect, it, vi } from 'vitest';

import { formatWecomInteractionPrompt, WecomTextInteractions } from '../textInteractions';

function permissionRequest(input: Record<string, unknown>): InteractionRequest {
  return {
    kind: 'permission',
    requestId: 'permission-1',
    toolName: 'Bash',
    displayName: '运行命令',
    input,
  };
}

describe('formatWecomInteractionPrompt', () => {
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
});
