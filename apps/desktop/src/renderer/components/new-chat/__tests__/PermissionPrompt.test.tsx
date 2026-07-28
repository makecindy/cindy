// @vitest-environment jsdom
/**
 * PermissionPrompt.test.tsx — 「本对话都允许」按钮的范围表达。
 *
 * 这个按钮加的是 agent 给的一条具体规则,范围远小于「总是允许」的字面。原文案既没说
 * 允许的是哪一类,也容易被读成「什么都允许」。这里锁死:能描述规则时范围出现在按钮上,
 * 描述不出来时退回原文案(而不是编一个范围),以及按钮的授权载荷一字不改地转发 agent
 * 建议 —— 文案怎么写都不该动实际授权内容。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PendingPermission } from '@/lib/makerChatStore';

// 仓库同款 i18n mock:t 返回 key(带参时拼上参数便于断言)。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: Record<string, unknown>) =>
      args && Object.keys(args).length > 0 ? `${key}:${JSON.stringify(args)}` : key,
  }),
}));

// Tip 是 Radix 浮层,这里只关心它包裹的按钮,直接透传 children。
vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { PermissionPrompt } from '../PermissionPrompt';

afterEach(cleanup);

const bashRule = {
  type: 'addRules',
  rules: [{ toolName: 'Bash', ruleContent: 'curl:*' }],
  behavior: 'allow',
  destination: 'session',
};

function permission(suggestions?: unknown[]): PendingPermission {
  return {
    requestId: 'req-1',
    toolName: 'Bash',
    input: { command: 'curl -s https://example.com' },
    ...(suggestions ? { suggestions } : {}),
  };
}

describe('PermissionPrompt 的会话级授权按钮', () => {
  it('把规则范围写进按钮文案', () => {
    render(<PermissionPrompt permission={permission([bashRule])} onRespond={vi.fn()} />);

    expect(
      screen.getByText('newChat.permissionPrompt.alwaysAllowScoped:{"scope":"Bash(curl:*)"}'),
    ).toBeTruthy();
  });

  it('规则描述不出来时退回原文案,不编造范围', () => {
    const unknownShape = { type: 'setMode', mode: 'bypassPermissions', destination: 'session' };
    render(<PermissionPrompt permission={permission([unknownShape])} onRespond={vi.fn()} />);

    expect(screen.getByText('agentIsland.native.alwaysAllowForSession')).toBeTruthy();
    expect(screen.queryByText(/alwaysAllowScoped/)).toBeNull();
  });

  it('没有会话级建议时整个按钮不出现', () => {
    render(<PermissionPrompt permission={permission()} onRespond={vi.fn()} />);

    expect(screen.queryByText('agentIsland.native.alwaysAllowForSession')).toBeNull();
    expect(screen.queryByText(/alwaysAllowScoped/)).toBeNull();
    // 另两个出口照常。
    expect(screen.getByText('agentIsland.native.allowOnce')).toBeTruthy();
    expect(screen.getByText('agentIsland.native.deny')).toBeTruthy();
  });

  // 文案是展示层的事,授权载荷必须原样转发 agent 的建议 —— 改文案不许改语义。
  it('点击后原样转发 agent 建议作为授权载荷', () => {
    const onRespond = vi.fn();
    render(<PermissionPrompt permission={permission([bashRule])} onRespond={onRespond} />);

    fireEvent.click(
      screen.getByText('newChat.permissionPrompt.alwaysAllowScoped:{"scope":"Bash(curl:*)"}'),
    );

    expect(onRespond).toHaveBeenCalledWith({
      behavior: 'allow',
      updatedPermissions: [bashRule],
      decisionClassification: 'user_permanent',
    });
  });

  it('Ctrl+Enter 与点击等价', () => {
    const onRespond = vi.fn();
    render(<PermissionPrompt permission={permission([bashRule])} onRespond={onRespond} />);

    fireEvent.keyDown(window, { key: 'Enter', code: 'Enter', ctrlKey: true });

    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({ decisionClassification: 'user_permanent' }),
    );
  });
});
