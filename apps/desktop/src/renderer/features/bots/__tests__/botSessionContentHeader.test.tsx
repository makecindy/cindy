// @vitest-environment jsdom

/**
 * 伙伴对话头部:名字/头像 + 设置齿轮,两个入口都跳设置页。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const navigate = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useLocation: () => ({ pathname: '/bots/bot-1/session/sess-1', search: '' }),
}));
vi.mock('../feature-context', () => ({ useRegisterContentHeader: () => undefined }));
vi.mock('../BotAvatar', () => ({ BotAvatar: () => <span data-testid="bot-avatar" /> }));

const { BotSessionContentHeader } = await import('../BotSessionContentHeader');

const bot = { id: 'bot-1', name: '小可' };

function appRegionOf(element: HTMLElement): string {
  return (
    (element.style as CSSStyleDeclaration & { WebkitAppRegion?: string }).WebkitAppRegion ?? ''
  );
}

afterEach(() => {
  cleanup();
  navigate.mockClear();
});

describe('BotSessionContentHeader', () => {
  it('leaves the header whitespace in the native window drag region', () => {
    render(<BotSessionContentHeader bot={bot} sessionId="sess-1" />);

    expect(appRegionOf(screen.getByTestId('bot-session-content-header'))).toBe('');
    expect(appRegionOf(screen.getByTitle('bots.settings'))).toBe('no-drag');
    expect(appRegionOf(screen.getByLabelText('bots.settings'))).toBe('no-drag');
  });

  it('opens settings from either the name lockup or the gear button', () => {
    render(<BotSessionContentHeader bot={bot} sessionId="sess-1" />);

    fireEvent.click(screen.getByTitle('bots.settings'));
    expect(navigate).toHaveBeenCalledWith('/bots/bot-1/session/sess-1?settings=1');

    fireEvent.click(screen.getByLabelText('bots.settings'));
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it('renders without a session id', () => {
    render(<BotSessionContentHeader bot={bot} sessionId={null} />);
    expect(screen.getByText('小可')).toBeTruthy();
  });

  it('keeps every colour on semantic tokens so both modes come out right', () => {
    render(<BotSessionContentHeader bot={bot} sessionId="sess-1" />);
    const className = screen.getByLabelText('bots.settings').className;
    expect(className).toMatch(/text-\[var\(--text-tertiary\)\]/);
    expect(className).toMatch(/hover:bg-\[var\(--surface-hover\)\]/);
    // 无渐变、无阴影;圆角走 8px 内控件档。
    expect(className).not.toMatch(/shadow|gradient/);
    expect(className).toMatch(/rounded-lg/);
  });
});
