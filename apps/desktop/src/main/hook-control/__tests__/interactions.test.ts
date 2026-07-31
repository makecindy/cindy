/**
 * hook-control/interactions 单测: 卡片合成语义(对齐 IM cardBuilders 的 v1
 * 简化)与挂起注册表(按钮回流 / 超时默认 / 收口取消)。纯逻辑, 无 mock。
 */

import { describe, expect, it, vi } from 'vitest';

import type { InteractionRequest } from '@cindy/maker-core';

import {
  cancelHookInteraction,
  composeInteractionCard,
  registerHookInteraction,
  resolveHookInteraction,
} from '../interactions';

const ASK: InteractionRequest = {
  kind: 'ask_user_question',
  requestId: 'int-1',
  questions: [
    {
      question: '用哪个方案实现?',
      header: '方案选择',
      options: [{ label: '方案 A' }, { label: '方案 B', description: '慢但稳' }],
    },
  ],
};

describe('composeInteractionCard', () => {
  it('ask: 只渲染第一道问题, 按钮->answers 用 question 全文做 key', () => {
    const composed = composeInteractionCard(ASK)!;
    expect(composed.card.title).toContain('方案选择');
    expect(composed.card.body).toBe('用哪个方案实现?');
    expect(composed.card.buttons.map((b) => b.id)).toEqual(['ask:0', 'ask:1']);
    expect(composed.decisions.get('ask:1')).toEqual({
      kind: 'ask_user_question',
      answers: { '用哪个方案实现?': '方案 B' },
    });
    expect(composed.defaultDecision).toEqual({ kind: 'ask_user_question', answers: {} });
  });

  it('ask: 无选项降级为单个"继续"按钮(空答案); 无问题返回 null', () => {
    const noOptions = composeInteractionCard({
      kind: 'ask_user_question',
      requestId: 'int-2',
      questions: [{ question: '继续吗?' }],
    })!;
    expect(noOptions.card.buttons.map((b) => b.id)).toEqual(['ask:continue']);
    expect(noOptions.decisions.get('ask:continue')).toEqual({
      kind: 'ask_user_question',
      answers: { '继续吗?': '' },
    });
    expect(
      composeInteractionCard({ kind: 'ask_user_question', requestId: 'int-3', questions: [] }),
    ).toBeNull();
  });

  it('ask: 选项超过 6 个截断(与 IM MAX_OPTIONS 一致)', () => {
    const many = composeInteractionCard({
      kind: 'ask_user_question',
      requestId: 'int-4',
      questions: [
        { question: 'q', options: Array.from({ length: 9 }, (_, i) => ({ label: `选项${i}` })) },
      ],
    })!;
    expect(many.card.buttons).toHaveLength(6);
  });

  it('plan_review: 批准/打回按钮, 正文截断 1500, 超时默认 deny+dismissed', () => {
    const composed = composeInteractionCard({
      kind: 'plan_review',
      requestId: 'int-5',
      plan: 'x'.repeat(2000),
    })!;
    expect(composed.card.buttons.map((b) => b.id)).toEqual(['plan:approve', 'plan:reject']);
    expect(composed.card.body.length).toBeLessThanOrEqual(1501); // 1500 + 省略号
    expect(composed.decisions.get('plan:approve')).toEqual({
      kind: 'plan_review',
      behavior: 'allow',
    });
    expect(composed.defaultDecision).toMatchObject({
      kind: 'plan_review',
      behavior: 'deny',
      dismissed: true,
    });
  });

  it('permission: 三按钮卡(允许一次/本任务总是允许/拒绝), 超时默认拒绝', () => {
    const composed = composeInteractionCard({
      kind: 'permission',
      requestId: 'int-6',
      toolName: 'Bash',
      input: { command: 'rm -rf dist' },
      displayName: '运行命令',
      description: '在工作目录执行 shell 命令',
    })!;
    expect(composed.card.title).toContain('运行命令');
    expect(composed.card.body).toContain('Bash');
    expect(composed.card.body).toContain('rm -rf dist');
    expect(composed.card.buttons).toEqual([
      { id: 'perm:allow', label: '允许一次', style: 'primary' },
      { id: 'perm:always', label: '本任务总是允许', style: 'default' },
      { id: 'perm:deny', label: '拒绝', style: 'danger' },
    ]);
    expect(composed.decisions.get('perm:allow')).toEqual({ kind: 'permission', behavior: 'allow' });
    // 「本任务总是允许」带会话级 addRules(claude 直接消费, codex 非空即会话放行)
    // 注:按钮文案用「任务」(产品术语,与应用内 permissions.alwaysAllowForSession 一致),
    // 但 addRules 的作用域仍是技术意义上的 agent session,两者刻意不同名。
    expect(composed.decisions.get('perm:always')).toEqual({
      kind: 'permission',
      behavior: 'allow',
      permissionUpdates: [
        { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
      ],
    });
    expect(composed.decisions.get('perm:deny')).toEqual({
      kind: 'permission',
      behavior: 'deny',
      reason: 'user_denied',
    });
    expect(composed.defaultDecision).toEqual({
      kind: 'permission',
      behavior: 'deny',
      reason: 'hook_interaction_timeout',
    });
  });

  it('permission: 标题优先级 displayName > title > toolName; 入参摘要截断', () => {
    const byTitle = composeInteractionCard({
      kind: 'permission',
      requestId: 'int-7',
      toolName: 'Bash',
      input: {},
      title: '要跑命令',
    })!;
    expect(byTitle.card.title).toContain('要跑命令');
    const byTool = composeInteractionCard({
      kind: 'permission',
      requestId: 'int-8',
      toolName: 'Bash',
      input: {},
    })!;
    expect(byTool.card.title).toContain('Bash');
    // 空 input 不渲染摘要行
    expect(byTool.card.body).not.toContain('```');
    // 超长入参截断(600 + 省略号), 卡片不被巨型 JSON 撑爆
    const huge = composeInteractionCard({
      kind: 'permission',
      requestId: 'int-9',
      toolName: 'Write',
      input: { content: 'x'.repeat(5000) },
    })!;
    expect(huge.card.body.length).toBeLessThan(700);
  });

  it('permission: 超时按默认拒绝并回调 fallback', async () => {
    vi.useFakeTimers();
    try {
      const composed = composeInteractionCard({
        kind: 'permission',
        requestId: 'int-10',
        toolName: 'Bash',
        input: {},
      })!;
      const fallback = vi.fn();
      const p = registerHookInteraction({
        interactionId: 'int-perm-t',
        composed,
        onFallback: fallback,
        timeoutMs: 1000,
      });
      await vi.advanceTimersByTimeAsync(1000);
      await expect(p).resolves.toEqual({
        kind: 'permission',
        behavior: 'deny',
        reason: 'hook_interaction_timeout',
      });
      expect(fallback).toHaveBeenCalledWith('等待授权超时, 已拒绝该权限请求');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('挂起注册表', () => {
  it('按钮回流: resolveHookInteraction 配对成功, 未知按钮保持挂起', async () => {
    const composed = composeInteractionCard(ASK)!;
    const fallback = vi.fn();
    const p = registerHookInteraction({
      interactionId: 'int-a',
      composed,
      onFallback: fallback,
    });
    expect(resolveHookInteraction('int-a', 'ask:nope')).toBe(false); // 未知按钮不消费
    expect(resolveHookInteraction('int-a', 'ask:0')).toBe(true);
    expect(resolveHookInteraction('int-a', 'ask:0')).toBe(false); // 已消费
    await expect(p).resolves.toEqual({
      kind: 'ask_user_question',
      answers: { '用哪个方案实现?': '方案 A' },
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('超时: 按默认自决并回调 fallback(发 interaction.cancel 用)', async () => {
    vi.useFakeTimers();
    try {
      const composed = composeInteractionCard(ASK)!;
      const fallback = vi.fn();
      const p = registerHookInteraction({
        interactionId: 'int-b',
        composed,
        onFallback: fallback,
        timeoutMs: 1000,
      });
      await vi.advanceTimersByTimeAsync(1000);
      await expect(p).resolves.toEqual({ kind: 'ask_user_question', answers: {} });
      expect(fallback).toHaveBeenCalledWith(composed.fallbackReason);
      expect(resolveHookInteraction('int-b', 'ask:0')).toBe(false); // 迟到按压被忽略
    } finally {
      vi.useRealTimers();
    }
  });

  it('收口取消: cancelHookInteraction 按默认自决, reason 用调用方文案', async () => {
    const composed = composeInteractionCard(ASK)!;
    const fallback = vi.fn();
    const p = registerHookInteraction({
      interactionId: 'int-c',
      composed,
      onFallback: fallback,
    });
    expect(cancelHookInteraction('int-c', '任务已结束')).toBe(true);
    expect(cancelHookInteraction('int-c', '任务已结束')).toBe(false); // 幂等
    await expect(p).resolves.toEqual({ kind: 'ask_user_question', answers: {} });
    expect(fallback).toHaveBeenCalledWith('任务已结束');
  });
});
