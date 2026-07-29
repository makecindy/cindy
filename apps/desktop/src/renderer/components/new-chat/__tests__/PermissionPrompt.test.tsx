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

// Tip 是 Radix 浮层,这里不测浮层行为,但 text 必须落到 DOM 里 ——
// tooltip 正文也是授权文案,漏测就等于放过「说了没依据的话」这类问题。
vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children, text }: { children: React.ReactNode; text?: string }) => (
    <>
      {children}
      <span data-testid="tip-text">{text}</span>
    </>
  ),
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
    expect(screen.queryByText(/alwaysAllowScoped:/)).toBeNull();
  });

  // Codex 的会话级放行只给一个不带规则的标记(范围由 app-server 定),这条分支必然走到。
  // 此时 tooltip 不许说「只限这里列出的范围」—— 一条都没列出,那句话是虚假安心。
  it('列不出范围时提示只讲时效,不声称范围', () => {
    render(
      <PermissionPrompt
        permission={permission([{ type: 'codexSessionApproval', destination: 'session' }])}
        onRespond={vi.fn()}
      />,
    );

    expect(screen.getByTestId('tip-text').textContent).toBe(
      'newChat.permissionPrompt.alwaysAllowSessionHint',
    );
  });

  // 有范围时反过来:完整规则原文进 tooltip(按钮里长命令会被 truncate)。
  it('有范围时提示带上完整规则与范围限定', () => {
    render(<PermissionPrompt permission={permission([bashRule])} onRespond={vi.fn()} />);

    expect(screen.getByTestId('tip-text').textContent).toBe(
      'Bash(curl:*)\nnewChat.permissionPrompt.alwaysAllowScopedHint',
    );
  });

  // 点击会把 suggestions 里每一项都转发出去。混进一项没写进文案的授权(这里是 setMode)
  // 时必须退回原文案 —— 否则按钮一边宣称「只允许 Bash(curl:*)」,一边顺手改权限档位。
  it('授权项描述不全时不做范围声明', () => {
    render(
      <PermissionPrompt
        permission={permission([
          bashRule,
          { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
        ])}
        onRespond={vi.fn()}
      />,
    );

    expect(screen.getByText('agentIsland.native.alwaysAllowForSession')).toBeTruthy();
    expect(screen.queryByText(/alwaysAllowScoped:/)).toBeNull();
    // tooltip 也不许替按钮把范围声明补回来。
    expect(screen.getByTestId('tip-text').textContent).toBe(
      'newChat.permissionPrompt.alwaysAllowSessionHint',
    );
  });

  // 分隔符按语言取(中日顿号 / 英韩逗号),不能把顿号漏进英文句子。
  it('多条规则用当前语言的分隔符拼接', () => {
    render(
      <PermissionPrompt
        permission={permission([
          {
            type: 'addRules',
            rules: [
              { toolName: 'Bash', ruleContent: 'curl:*' },
              { toolName: 'Bash', ruleContent: 'git:*' },
            ],
            behavior: 'allow',
            destination: 'session',
          },
        ])}
        onRespond={vi.fn()}
      />,
    );

    // i18n mock 下 ruleSeparator 返回 key 本身,断言两条规则都在、且中间是分隔符 key。
    expect(
      screen.getByRole('button', { name: /alwaysAllowScoped:/ }).textContent,
    ).toContain('Bash(curl:*)newChat.permissionPrompt.ruleSeparatorBash(git:*)');
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
