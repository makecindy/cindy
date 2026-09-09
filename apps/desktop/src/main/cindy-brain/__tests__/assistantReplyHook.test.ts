/**
 * assistantReplyHook.test.ts — 出口钩子应用编排单测(纯 DI,无 Electron)。
 * 覆盖:no-hook / 不合格 / 空文本快路径不动;allow 不改;rewrite 落库+广播;
 * render 落卡;pending 开→关恒成对;screen 抛错吞掉仍关 pending。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  isSuccessfulAssistantReplyDoneData,
  runAssistantReplyHook,
  type AssistantReplyHookDeps,
} from '../assistantReplyHook';
import type { GhostAssistantScreenResult } from '../subscriptionGateway';

function makeDeps(overrides: Partial<AssistantReplyHookDeps> = {}) {
  const calls = {
    persistRewrite: vi.fn(async () => {}),
    applyRenderCard: vi.fn(async () => {}),
    broadcastRewritten: vi.fn(),
    setPending: vi.fn(),
  };
  const deps: AssistantReplyHookDeps = {
    hasHook: () => true,
    isEligible: async () => true,
    screen: async (): Promise<GhostAssistantScreenResult> => ({ action: 'allow' }),
    persistRewrite: calls.persistRewrite,
    applyRenderCard: calls.applyRenderCard,
    broadcastRewritten: calls.broadcastRewritten,
    setPending: calls.setPending,
    ...overrides,
  };
  return { deps, calls };
}

describe('isSuccessfulAssistantReplyDoneData', () => {
  it.each([
    [{ status: 'completed', result: 'answer' }, true],
    [{ result: 'legacy answer' }, true],
    [{ status: 'failed', result: 'partial' }, false],
    [{ status: 'cancelled', result: 'partial' }, false],
    [{ status: 'interrupted', result: 'partial' }, false],
    [{ is_error: true, result: 'provider failure' }, false],
  ])('classifies %j as %s', (data, expected) => {
    expect(isSuccessfulAssistantReplyDoneData(data)).toBe(expected);
  });
});

describe('runAssistantReplyHook', () => {
  it('no-hook 快路径:不查资格、不 screen、不动 pending', async () => {
    const screen = vi.fn();
    const isEligible = vi.fn();
    const { deps, calls } = makeDeps({ hasHook: () => false, screen, isEligible });
    await runAssistantReplyHook(deps, 's1', 'c1', 'AI 回复');
    expect(screen).not.toHaveBeenCalled();
    expect(isEligible).not.toHaveBeenCalled();
    expect(calls.setPending).not.toHaveBeenCalled();
  });

  it('空文本:跳过(纯 tool 轮 done.result 为空)', async () => {
    const screen = vi.fn();
    const { deps, calls } = makeDeps({ screen });
    await runAssistantReplyHook(deps, 's1', 'c1', '');
    expect(screen).not.toHaveBeenCalled();
    expect(calls.setPending).not.toHaveBeenCalled();
  });

  it('不合格会话(orca worker 等):不 screen、不亮 pending', async () => {
    const screen = vi.fn();
    const { deps, calls } = makeDeps({ isEligible: async () => false, screen });
    await runAssistantReplyHook(deps, 's1', 'c1', 'AI 回复');
    expect(screen).not.toHaveBeenCalled();
    expect(calls.setPending).not.toHaveBeenCalled();
  });

  it('allow:pending 开→关,不改消息不落卡', async () => {
    const { deps, calls } = makeDeps({ screen: async () => ({ action: 'allow' }) });
    await runAssistantReplyHook(deps, 's1', 'c1', 'AI 回复');
    expect(calls.setPending.mock.calls).toEqual([
      ['s1', 'c1', true],
      ['s1', 'c1', false],
    ]);
    expect(calls.persistRewrite).not.toHaveBeenCalled();
    expect(calls.applyRenderCard).not.toHaveBeenCalled();
  });

  it('rewrite:落库改写正文 + 广播 + pending 收尾', async () => {
    const { deps, calls } = makeDeps({
      screen: async () => ({ action: 'rewrite', ghostId: 'g', ghostName: '意识', text: '润色版' }),
    });
    await runAssistantReplyHook(deps, 's1', 'c1', '原文');
    expect(calls.persistRewrite).toHaveBeenCalledWith('s1', 'c1', '润色版');
    expect(calls.broadcastRewritten).toHaveBeenCalledWith({
      sessionId: 's1',
      clientId: 'c1',
      ghostId: 'g',
      ghostName: '意识',
      text: '润色版',
    });
    expect(calls.setPending).toHaveBeenLastCalledWith('s1', 'c1', false);
  });

  it('render:落自绘卡(净化/广播在 applyRenderCard 内),pending 收尾', async () => {
    const { deps, calls } = makeDeps({
      screen: async () => ({
        action: 'render',
        ghostId: 'g',
        ghostName: '意识',
        html: '<div>卡</div>',
        height: 200,
        text: '原文',
      }),
    });
    await runAssistantReplyHook(deps, 's1', 'c1', '原文');
    expect(calls.applyRenderCard).toHaveBeenCalledWith('s1', 'c1', {
      ghostId: 'g',
      ghostName: '意识',
      html: '<div>卡</div>',
      height: 200,
    });
    expect(calls.persistRewrite).not.toHaveBeenCalled();
    expect(calls.setPending).toHaveBeenLastCalledWith('s1', 'c1', false);
  });

  it('screen 抛错:吞掉,pending 仍被关闭(finally)', async () => {
    const { deps, calls } = makeDeps({
      screen: async () => {
        throw new Error('boom');
      },
    });
    await expect(runAssistantReplyHook(deps, 's1', 'c1', '原文')).resolves.toBeUndefined();
    expect(calls.setPending.mock.calls).toEqual([
      ['s1', 'c1', true],
      ['s1', 'c1', false],
    ]);
  });
});
