// @vitest-environment jsdom

/**
 * 伙伴对话头部的「交付物」入口。
 * ---------------------------------------------------------------------------
 * 真机验收:右栏交付物 tab 是静默注册的,用户只有右上角一个通用面板开关可点,
 * 找不到伙伴交出来的东西。这里锁住入口本身可见、点击走 userInitiated 打开(会
 * reveal 右栏),以及没有会话 id 时不渲染死按钮。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const openBotArtifactsTab = vi.fn(async () => undefined);

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/features/right-sidebar/lib/openBotArtifactsTab', () => ({ openBotArtifactsTab }));
vi.mock('../feature-context', () => ({ useRegisterContentHeader: () => undefined }));
vi.mock('../BotAvatar', () => ({ BotAvatar: () => <span data-testid="bot-avatar" /> }));

const { BotSessionContentHeader } = await import('../BotSessionContentHeader');

const bot = { id: 'bot-1', name: '小可' };

afterEach(() => {
  cleanup();
  openBotArtifactsTab.mockClear();
});

describe('BotSessionContentHeader', () => {
  it('shows a visible deliverables entry that opens the library on click', () => {
    render(<BotSessionContentHeader bot={bot} sessionId="sess-1" />);
    const entry = screen.getByTestId('bot-artifacts-header-entry');
    expect(entry.textContent).toContain('rightSidebar.tabs.kinds.botArtifacts');
    expect(entry.getAttribute('title')).toBe('bots.artifacts.openLibrary');

    fireEvent.click(entry);
    expect(openBotArtifactsTab).toHaveBeenCalledWith('sess-1', { userInitiated: true });
  });

  it('tells the user when opening deliverables fails', async () => {
    openBotArtifactsTab.mockRejectedValueOnce(new Error('not a singleton'));
    render(<BotSessionContentHeader bot={bot} sessionId="sess-1" />);
    fireEvent.click(screen.getByTestId('bot-artifacts-header-entry'));
    expect(await screen.findByTestId('bot-artifacts-header-error')).toBeTruthy();
    expect(screen.getByTestId('bot-artifacts-header-error').textContent).toBe(
      'bots.artifacts.openFailed',
    );
  });

  it('renders no entry without a session id', () => {
    render(<BotSessionContentHeader bot={bot} sessionId={null} />);
    expect(screen.queryByTestId('bot-artifacts-header-entry')).toBeNull();
  });

  it('keeps every colour on semantic tokens so both modes come out right', () => {
    render(<BotSessionContentHeader bot={bot} sessionId="sess-1" />);
    const className = screen.getByTestId('bot-artifacts-header-entry').className;
    expect(className).toMatch(/text-\[var\(--text-tertiary\)\]/);
    expect(className).toMatch(/hover:bg-\[var\(--surface-hover\)\]/);
    // 无渐变、无阴影;圆角走 8px 内控件档。
    expect(className).not.toMatch(/shadow|gradient/);
    expect(className).toMatch(/rounded-lg/);
  });
});
