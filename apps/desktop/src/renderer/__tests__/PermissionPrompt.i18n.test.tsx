// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
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

    expect(screen.getByText('允许 PowerShell？')).toBeTruthy();
    expect(screen.getByText('拒绝')).toBeTruthy();
    expect(screen.getByText('本任务总是允许')).toBeTruthy();
    expect(screen.getByText('允许一次')).toBeTruthy();
    expect(screen.queryByText('Allow Codex to run this command?')).toBeNull();
    expect(screen.getByText('Provider-supplied reason stays verbatim.')).toBeTruthy();
  });

  it('preserves an action-specific title when no display name is available', () => {
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

    expect(screen.getByText('Allow Codex to edit /tmp/example.txt?')).toBeTruthy();
    expect(screen.queryByText('允许 file_change？')).toBeNull();
  });

  it('localizes the tool fallback when no richer title is available', () => {
    render(
      <PermissionPrompt
        permission={{
          requestId: 'permission-3',
          toolName: 'Bash',
          input: { command: 'pwd' },
        }}
        onRespond={vi.fn()}
      />,
    );

    expect(screen.getByText('允许 Bash？')).toBeTruthy();
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
});
