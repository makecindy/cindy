// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BotAiBadge } from '../BotAiBadge';
import { BotAiDisclosureDialog, BotAiDisclosureGate } from '../BotAiDisclosureDialog';
import { acknowledgeBotAiDisclosure, isBotAiDisclosureAcknowledged } from '../botAiDisclosure';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const STORAGE_KEY = 'cindy.bots.aiDisclosureAck.v1';

describe('botAiDisclosure storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('starts unacknowledged on a fresh device', () => {
    expect(isBotAiDisclosureAcknowledged()).toBe(false);
  });

  it('persists the acknowledgement and survives re-reads', () => {
    acknowledgeBotAiDisclosure();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('1');
    expect(isBotAiDisclosureAcknowledged()).toBe(true);
  });
});

describe('BotAiBadge', () => {
  it('renders the persistent AI label with accessible naming', () => {
    render(<BotAiBadge />);
    const badge = screen.getByTestId('bot-ai-badge');
    expect(badge).toBeTruthy();
    // 可见文案承载身份(不依赖图标或颜色)。
    expect(badge.textContent).toContain('bots.aiBadge.label');
    // 读屏与悬停提示一致。
    expect(badge.getAttribute('aria-label')).toBe('bots.aiBadge.ariaLabel');
    expect(badge.getAttribute('title')).toBe('bots.aiBadge.ariaLabel');
    cleanup();
  });
});

describe('BotAiDisclosureGate', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('shows the disclosure on first use and records the confirmation', () => {
    const { container } = render(
      <>
        <BotAiDisclosureGate />
        <button type="button">chat-content</button>
      </>,
    );
    // 未确认:弹窗出现,确认前无法完成交互(遮罩阻挡下方内容)。
    expect(screen.getByText('bots.aiDisclosure.title')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'bots.aiDisclosure.confirm' }));
    // 确认后:弹窗消失,ack 已持久化。
    expect(screen.queryByText('bots.aiDisclosure.title')).toBeNull();
    expect(isBotAiDisclosureAcknowledged()).toBe(true);
    expect(screen.getByText('chat-content')).toBeTruthy();
    expect(container).toBeTruthy();
    cleanup();
  });

  it('does not re-block after the acknowledgement is stored', () => {
    acknowledgeBotAiDisclosure();
    render(
      <>
        <BotAiDisclosureGate />
        <button type="button">chat-content</button>
      </>,
    );
    expect(screen.queryByText('bots.aiDisclosure.title')).toBeNull();
    expect(screen.getByText('chat-content')).toBeTruthy();
    cleanup();
  });

  it('disclosure dialog confirms through its own callback', () => {
    const onConfirm = vi.fn();
    render(<BotAiDisclosureDialog onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'bots.aiDisclosure.confirm' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(isBotAiDisclosureAcknowledged()).toBe(true);
    cleanup();
  });
});
