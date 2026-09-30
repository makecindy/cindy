// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { i18n, SUPPORTED_LOCALES } from '@/i18n';
import { SystemCard } from '../SystemCard';

// Unrelated card variants have their own integration tests.
vi.mock('@/features/bots/useRemoteBots', () => ({ useRemoteBots: () => [] }));
vi.mock('@/features/bots/BotCollaborationCard', () => ({
  BotSessionTaskCard: () => null,
  BotSessionTaskMessageTrace: () => null,
}));
vi.mock('@/features/learn/LearnStatusCard', () => ({ LearnStatusCard: () => null }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: () => null }));

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('en');
});

describe('command card localization boundaries', () => {
  it.each(SUPPORTED_LOCALES)('localizes card labels while preserving command data: %s', async (locale) => {
    await i18n.changeLanguage(locale);
    const workingDir = 'D:\\work\\原始目录';
    const commandDescription = 'User-defined description / 原始说明';
    const { container } = render(<>
      <SystemCard cardType="help" data={{ commands: [
        { name: 'help', source: 'desktop', description: commandDescription },
        { name: 'custom-command --flag', source: 'user', description: commandDescription },
        { name: 'status', source: 'agent-builtin', description: commandDescription },
      ] }} />
      <SystemCard cardType="cost" data={{ tokenUsage: 1234 }} />
      <SystemCard cardType="pwd" data={{ workingDir }} />
      <SystemCard cardType="status" data={{
        model: 'custom-model-v1', effort: 'high', permissionMode: 'bypassPermissions',
        workingDir, isRunning: true,
      }} />
    </>);
    for (const key of [
      'help.title', 'help.builtInCommands', 'help.projectCommands',
      'cost.title', 'cost.tokensUsed', 'pwd.title', 'status.title',
      'status.agent', 'status.model', 'status.effort', 'status.permissionMode', 'status.running',
    ]) {
      const fullKey = `chat.systemCard.${key}`;
      expect(i18n.exists(fullKey, { lng: locale, fallbackLng: false })).toBe(true);
      expect(screen.getAllByText(i18n.t(fullKey)).length).toBeGreaterThan(0);
    }
    expect(screen.getByText('/help')).toBeTruthy();
    expect(screen.getByText('/custom-command --flag')).toBeTruthy();
    expect(screen.getByText('/status')).toBeTruthy();
    expect(screen.getAllByText(commandDescription)).toHaveLength(3);
    expect(screen.getAllByText(workingDir)).toHaveLength(2);
    for (const value of ['custom-model-v1', 'high', 'bypassPermissions', '1.2k']) {
      expect(screen.getByText(value)).toBeTruthy();
    }
    expect(container.textContent).not.toContain('chat.systemCard.');
  });

  it('updates labels and empty states when the language changes', async () => {
    await i18n.changeLanguage('en');
    render(<>
      <SystemCard cardType="help" />
      <SystemCard cardType="pwd" />
      <SystemCard cardType="status" />
    </>);
    expect(screen.getByText('Available Commands')).toBeTruthy();
    expect(screen.getByText('Idle')).toBeTruthy();
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(screen.getByText('可用命令')).toBeTruthy();
    expect(screen.getByText('暂无可用命令')).toBeTruthy();
    expect(screen.getByText('空闲')).toBeTruthy();
    expect(screen.getAllByText('（未设置）')).toHaveLength(2);
    expect(screen.queryByText('Available Commands')).toBeNull();
  });

  it.each(SUPPORTED_LOCALES)('keeps shell command and output bytes unchanged: %s', async (locale) => {
    await i18n.changeLanguage(locale);
    const cmdLine = 'printf "hello" && echo 原样';
    const stdout = '  original output\n原始输出\t{{size}}\n';
    const stderr = ' error: --flag\n';
    const spawnError = 'ENOENT: original error';
    const { container } = render(<SystemCard cardType="cmd" data={{
      cmdLine, stdout, stderr, spawnError, cwd: '/repo/raw-path', exitCode: 1,
    }} />);
    expect([...container.querySelectorAll('pre')].map(node => node.textContent))
      .toEqual([cmdLine, spawnError, stdout, stderr]);
  });
});
