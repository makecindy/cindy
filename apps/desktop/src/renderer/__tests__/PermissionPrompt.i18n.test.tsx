// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import i18n from '@/i18n';
import { PermissionPrompt } from '@/components/new-chat/PermissionPrompt';

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
});

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('en');
});

describe('PermissionPrompt i18n', () => {
  it('asks through the companion identity while retaining the exact operation and decision', () => {
    const onRespond = vi.fn();
    render(<PermissionPrompt companion={{ id: 'writer', name: '阿橘' }}
      permission={{ requestId: 'writer-permission', toolName: 'Bash', input: { command: 'git push origin draft' } }}
      onRespond={onRespond} />);
    expect(screen.getByText('阿橘 想请你确认一下')).toBeTruthy();
    expect(screen.getByText('git push origin draft')).toBeTruthy();
    expect(screen.queryByText('本任务总是允许')).toBeNull();
    fireEvent.click(screen.getByText('允许一次'));
    // P1: the component freezes and reports the requestId it was mounted for.
    expect(onRespond).toHaveBeenCalledExactlyOnceWith({ behavior: 'allow', requestId: 'writer-permission' });
  });

  it('uses the selected UI language for Cindy-owned permission copy', () => {
    render(
      <PermissionPrompt
        permission={{
          requestId: 'permission-1',
          toolName: 'exec',
          displayName: 'PowerShell',
          input: { command: 'Get-ChildItem' },
          title: 'Allow Codex to run this command?',
          description: 'Provider-supplied reason stays verbatim.',
          suggestions: [{ destination: 'session' }],
        }}
        onRespond={vi.fn()}
      />,
    );

    // Say what happens instead of the harness tool name or its English title.
    expect(screen.getByText('允许运行这条命令？')).toBeTruthy();
    expect(screen.getByText('Get-ChildItem')).toBeTruthy();
    expect(screen.getByText('拒绝')).toBeTruthy();
    expect(screen.getByText('本任务总是允许')).toBeTruthy();
    expect(screen.getByText('允许一次')).toBeTruthy();
    expect(screen.queryByText('Allow Codex to run this command?')).toBeNull();
    expect(screen.getByText('Provider-supplied reason stays verbatim.')).toBeTruthy();
  });

  it('replaces English harness file titles with a localized one and shows the path', () => {
    render(
      <PermissionPrompt
        permission={{
          requestId: 'permission-2',
          toolName: 'file_change',
          input: { path: '/tmp/example.txt' },
          title: 'Allow Codex to edit /tmp/example.txt?',
        }}
        onRespond={vi.fn()}
      />,
    );

    expect(screen.getByText('允许修改文件？')).toBeTruthy();
    expect(screen.getByText('/tmp/example.txt')).toBeTruthy();
    expect(screen.queryByText('Allow Codex to edit /tmp/example.txt?')).toBeNull();
  });

  it('localizes the tool fallback when no richer title is available', () => {
    render(
      <PermissionPrompt
        permission={{
          requestId: 'permission-3',
          toolName: 'WebFetch',
          input: { url: 'https://example.com' },
        }}
        onRespond={vi.fn()}
      />,
    );

    expect(screen.getByText('允许 WebFetch？')).toBeTruthy();
  });

  // 2026-10-24: Auto asks showed no reason, so users could not tell why they were asked.
  it('shows why Auto review asked and names the plugin being called', () => {
    render(
      <PermissionPrompt
        permission={{
          requestId: 'permission-ask',
          toolName: 'mcp:cindy:ghost_call',
          input: { ghost_id: 'cindy-github', tool: 'call_tool', args: { name: 'add_repo_collaborator', args: { username: 'octo' } } },
          autoReviewReason: '这会给 octo 开通仓库权限，你只让我查看协作者。',
        }}
        onRespond={vi.fn()}
      />,
    );

    expect(screen.getByText('允许使用插件「cindy-github」？')).toBeTruthy();
    expect(screen.getByText('自动审批需要你决定：这会给 octo 开通仓库权限，你只让我查看协作者。')).toBeTruthy();
    expect(screen.getByText('add_repo_collaborator {"username":"octo"}')).toBeTruthy();
  });

  it('keeps the session boundary explicit in the English approval label', async () => {
    await i18n.changeLanguage('en');

    render(
      <PermissionPrompt
        permission={{
          requestId: 'permission-4',
          toolName: 'exec',
          input: { command: 'pwd' },
          suggestions: [{ destination: 'session' }],
        }}
        onRespond={vi.fn()}
      />,
    );

    expect(screen.getByText('Always allow for this session')).toBeTruthy();
  });

  it('explains that auto-review failed and this click only confirms the current action', () => {
    render(
      <PermissionPrompt
        permission={{
          requestId: 'permission-unavailable',
          toolName: 'exec',
          input: { command: 'npx tsc --noEmit' },
          title: 'Allow Codex to run this command?',
          description: 'Automatic review could not finish, so this action needs your confirmation.',
          autoReviewUnavailable: true,
          sourceDescription: '来源：Telegram · 开发群\n原消息：检查仓库',
        }}
        onRespond={vi.fn()}
      />,
    );

    expect(screen.getByText('自动审批没完成，请确认要不要允许这次操作。')).toBeTruthy();
    expect(screen.getByText(/来源：Telegram · 开发群/)).toBeTruthy();
    expect(screen.queryByText('Automatic review could not finish, so this action needs your confirmation.')).toBeNull();
  });
});
