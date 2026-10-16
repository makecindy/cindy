// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async () => {
  const { default: en } = await import('@/i18n/locales/en/common.json');
  const voice: Record<string, unknown> = en.bots.voiceMode;
  return {
    useTranslation: () => ({ t: (key: string) => {
      const value = key.startsWith('bots.voiceMode.') ? voice[key.slice('bots.voiceMode.'.length)] : null;
      return typeof value === 'string' ? value : key;
    } }),
  };
});

vi.mock('@/components/ui/tooltip', async (importOriginal) => ({
  // Keep Tip's real ref/event forwarding for the composed menu trigger.
  ...(await importOriginal<typeof import('@/components/ui/tooltip')>()),
  Tooltip: {
    Root: ({ children }: { children: ReactNode }) => <>{children}</>,
    Trigger: ({ children }: { children: ReactNode }) => <>{children}</>,
    Content: ({ children }: { children: ReactNode }) => <>{children}</>,
  },
}));

vi.mock('@/hooks/useRelativeTime', () => ({
  useRelativeTime: () => 'just now',
  formatAbsolute: () => '2026-07-22 10:00',
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), warning: vi.fn() },
}));

import { MessageActionBar } from '../MessageActionBar';
import { MessageReadAloudContext, type MessageReadAloud } from '../MessageReadAloudContext';

describe('companion message read-aloud', () => {
  const identity = { sessionId: 'companion-task', messageId: 'reply' };
  const capability = (patch: Partial<MessageReadAloud> = {}): MessageReadAloud => ({
    sessionId: identity.sessionId, available: true, disabled: false,
    messageId: null, phase: 'idle', canRead: () => true, toggle: vi.fn(), ...patch,
  });
  const bar = (value: MessageReadAloud | null, companion = true, eligible = true) => (
    <MessageReadAloudContext.Provider value={value}>
      <MessageActionBar copyText="Saved reply" align="left" hovered={false}
        simplifiedBotConversation={companion}
        readAloudMessage={eligible ? identity : undefined} />
    </MessageReadAloudContext.Provider>
  );

  it('shows an accessible persistent action only for eligible configured companion replies', () => {
    const value = capability();
    const { rerender } = render(bar(value));
    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }));
    expect(value.toggle).toHaveBeenCalledWith('reply', 'Saved reply');
    for (const unavailable of [null, capability({ available: false }), capability({ sessionId: 'other' }), capability({ canRead: () => false })]) {
      rerender(bar(unavailable));
      expect(screen.queryByRole('button', { name: 'Read aloud' })).toBeNull();
    }
    rerender(bar(value, false));
    expect(screen.queryByRole('button', { name: 'Read aloud' })).toBeNull();
    rerender(bar(value, true, false));
    expect(screen.queryByRole('button', { name: 'Read aloud' })).toBeNull();
  });

  it.each(['preparing', 'playing'] as const)('keeps the %s action cancellable', (phase) => {
    const value = capability({ messageId: 'reply', phase });
    render(bar(value));
    const stop = screen.getByRole('button', { name: 'Stop reading' });
    expect(stop.getAttribute('aria-pressed')).toBe('true');
    expect(stop.getAttribute('aria-busy')).toBe(String(phase === 'preparing'));
    fireEvent.click(stop);
    expect(value.toggle).toHaveBeenCalledOnce();
  });

  it('disables concurrent message playback during continuous voice mode', () => {
    const value = capability({ disabled: true });
    render(bar(value));
    const button = screen.getByRole('button', { name: 'Read aloud' });
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(button);
    expect(value.toggle).not.toHaveBeenCalled();
  });
});

describe('MessageActionBar', () => {
  const writeText = vi.fn(async () => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  });

  it('keeps fork beside copy and groups the remaining actions under ellipsis', async () => {
    const onFork = vi.fn(async () => undefined);
    const onAddToChat = vi.fn();
    const onRewind = vi.fn();
    const onDelete = vi.fn(async () => undefined);
    const deepLink = 'cindy://session/session-a?message=message-a';

    render(
      <MessageActionBar
        copyText="message body"
        copyLinkText={deepLink}
        align="right"
        hovered
        onFork={onFork}
        onAddToChat={onAddToChat}
        onRewind={onRewind}
        onDelete={onDelete}
      />,
    );

    const trigger = screen.getByRole('button', {
      name: 'chat.messageActionBar.moreActions',
    });
    expect(trigger).toBeTruthy();
    expect(screen.getByRole('button', {
      name: 'chat.messageActionBar.fork',
    })).toBeTruthy();
    expect(screen.queryByRole('button', {
      name: 'chat.messageActionBar.rewind',
    })).toBeNull();
    expect(screen.queryByRole('menuitem', {
      name: 'chat.messageActionBar.fork',
    })).toBeNull();

    expect(screen.getByRole('button', {
      name: 'chat.messageActionBar.fork',
    }).querySelector('.lucide-split')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'chat.messageActionBar.fork' }));
    await waitFor(() => expect(onFork).toHaveBeenCalledTimes(1));

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    expect(screen.getByRole('menuitem', {
      name: 'chat.quote.addToChat',
    }).querySelector('.lucide-message-square-plus')).toBeTruthy();
    expect(screen.getByRole('menuitem', {
      name: 'chat.messageActionBar.copyLink',
    }).querySelector('.lucide-link2')).toBeTruthy();
    expect(screen.getByRole('menuitem', {
      name: 'chat.messageActionBar.rewind',
    }).querySelector('.lucide-undo2')).toBeTruthy();
    expect(screen.getByRole('menuitem', {
      name: 'chat.messageActionBar.delete',
    }).querySelector('.lucide-trash2')).toBeTruthy();

    fireEvent.click(
      screen.getByRole('menuitem', {
        name: 'chat.quote.addToChat',
      }),
    );
    expect(onAddToChat).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(
      screen.getByRole('menuitem', {
        name: 'chat.messageActionBar.copyLink',
      }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(deepLink));

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(
      screen.getByRole('menuitem', {
        name: 'chat.messageActionBar.rewind',
      }),
    );
    expect(onRewind).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(
      screen.getByRole('menuitem', {
        name: 'chat.messageActionBar.delete',
      }),
    );
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
  });

  it.each(['left', 'right'] as const)('preserves edit and rewind callbacks with %s alignment', (align) => {
    const onEdit = vi.fn();
    const onRewind = vi.fn();
    render(<MessageActionBar copyText="body" align={align} hovered onEdit={onEdit} onRewind={onRewind} />);
    fireEvent.click(screen.getByRole('button', { name: 'chat.messageActionBar.edit' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'chat.messageActionBar.moreActions' }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole('menuitem', { name: 'chat.messageActionBar.rewind' }));
    expect(onRewind).toHaveBeenCalledTimes(1);
  });

  it.each(['left', 'right'] as const)('does not invent user actions without callbacks with %s alignment', (align) => {
    render(<MessageActionBar copyText="body" align={align} hovered />);
    expect(screen.queryByRole('button', { name: 'chat.messageActionBar.edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'chat.messageActionBar.moreActions' })).toBeNull();
  });

  it('keeps teammate actions visible, exposes Reply, and hides fork and usage', async () => {
    const onFork = vi.fn(async () => undefined);
    const onAddToChat = vi.fn();
    const onDelete = vi.fn(async () => undefined);
    const deepLink = 'cindy://session/session-a?message=message-a';

    const { container } = render(
      <MessageActionBar
        copyText="message body"
        copyLinkText={deepLink}
        align="left"
        hovered={false}
        simplifiedBotConversation
        onFork={onFork}
        onAddToChat={onAddToChat}
        onDelete={onDelete}
        turnMoney={{ amount: 1.5, currency: 'CNY', approximate: false, kind: 'actual-cost' }}
        turnUsageDetails={{
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          totalTokens: 15,
          cacheHitRate: 0,
        }}
      />,
    );

    const actionBar = container.firstElementChild;
    expect(actionBar?.classList.contains('opacity-100')).toBe(true);
    expect(actionBar?.classList.contains('pointer-events-none')).toBe(false);
    expect(screen.queryByRole('button', { name: 'chat.messageActionBar.fork' })).toBeNull();
    expect(screen.queryByText('¥1.50')).toBeNull();
    expect(screen.queryByText('chat.messageActionBar.turnTokens')).toBeNull();

    const reply = screen.getByRole('button', { name: 'chat.messageActionBar.reply' });
    expect(reply.querySelector('.lucide-message-square-reply')).toBeTruthy();
    fireEvent.click(reply);
    expect(onAddToChat).toHaveBeenCalledTimes(1);

    const trigger = screen.getByRole('button', {
      name: 'chat.messageActionBar.moreActions',
    });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    expect(screen.queryByRole('menuitem', { name: 'chat.quote.addToChat' })).toBeNull();
    expect(screen.getByRole('menuitem', {
      name: 'chat.messageActionBar.copyLink',
    })).toBeTruthy();
    expect(screen.getByRole('menuitem', {
      name: 'chat.messageActionBar.delete',
    })).toBeTruthy();
  });

  it('does not restore pointer focus to the ellipsis trigger after close', async () => {
    render(
      <MessageActionBar
        copyText="message body"
        align="left"
        hovered
        onAddToChat={vi.fn()}
      />,
    );

    const trigger = screen.getByRole('button', {
      name: 'chat.messageActionBar.moreActions',
    });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(
      screen.getByRole('menuitem', {
        name: 'chat.quote.addToChat',
      }),
    );

    await waitFor(() => expect(document.activeElement).not.toBe(trigger));
  });

  it('keeps the ellipsis icon static while the direct fork action is running', async () => {
    let resolveFork!: () => void;
    const onFork = vi.fn(
      () => new Promise<void>((resolve) => {
        resolveFork = resolve;
      }),
    );
    const onEdit = vi.fn();

    render(
      <MessageActionBar
        copyText="message body"
        align="right"
        hovered
        onFork={onFork}
        onAddToChat={vi.fn()}
        onEdit={onEdit}
      />,
    );

    const forkButton = screen.getByRole('button', {
      name: 'chat.messageActionBar.fork',
    });
    const moreButton = screen.getByRole('button', {
      name: 'chat.messageActionBar.moreActions',
    });
    const editButton = screen.getByRole('button', {
      name: 'chat.messageActionBar.edit',
    });

    fireEvent.click(forkButton);
    await waitFor(() => expect(forkButton.querySelector('.animate-spinner')).toBeTruthy());
    expect(moreButton.querySelector('.lucide-ellipsis')).toBeTruthy();
    expect(moreButton.querySelector('.lucide-loader-circle')).toBeNull();
    expect((moreButton as HTMLButtonElement).disabled).toBe(false);
    expect((editButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(editButton);
    expect(onEdit).not.toHaveBeenCalled();

    resolveFork();
    await waitFor(() => {
      expect(forkButton.querySelector('.animate-spinner')).toBeNull();
      expect((editButton as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('restores focus to the ellipsis trigger for keyboard users', async () => {
    render(
      <MessageActionBar
        copyText="message body"
        align="left"
        hovered
        onAddToChat={vi.fn()}
      />,
    );

    const trigger = screen.getByRole('button', {
      name: 'chat.messageActionBar.moreActions',
    });
    act(() => trigger.focus());
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const item = await screen.findByRole('menuitem', {
      name: 'chat.quote.addToChat',
    });
    fireEvent.keyDown(item, { key: 'Escape' });

    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('renders the user-turn total and aggregated details on separate lines', () => {
    render(
      <MessageActionBar
        copyText="message body"
        align="left"
        hovered
        userTurnMoney={{
          amount: 2,
          currency: 'CNY',
          approximate: false,
          kind: 'actual-cost',
        }}
        turnMoney={{
          amount: 1,
          currency: 'CNY',
          approximate: false,
          kind: 'actual-cost',
        }}
        turnUsageDetails={{
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          totalTokens: 15,
          cacheHitRate: 0,
          models: ['claude-fable-5[1m]', 'claude-opus-5[1m]'],
          perModelCost: [
            {
              model: 'claude-fable-5',
              money: { amount: 0.75, currency: 'CNY', approximate: false, kind: 'actual-cost' },
            },
            {
              model: 'claude-opus-5',
              money: { amount: 1.25, currency: 'CNY', approximate: false, kind: 'actual-cost' },
            },
          ],
        }}
      />,
    );

    const tooltip = screen.getByText(
      (_, element) =>
        element?.classList.contains('whitespace-pre-line') === true &&
        element.textContent?.includes('chat.messageActionBar.userTurnCostDetailsTitle') === true,
    );
    expect(tooltip.textContent).toBe(
      [
        'chat.messageActionBar.userTurnCostDetailsTitle',
        'usageDetails.costLine',
        'usageDetails.costBreakdownHeader',
        'usageDetails.modelCostLine',
        'usageDetails.modelCostLine',
        'usageDetails.tokenLine',
        'usageDetails.cacheLine',
      ].join('\n'),
    );
  });

  // 金额缺席时的回退:那一格显示本轮 token,而不是空着(2026-07-30 起网关目录整体
  // 不下发价格,消息底部只剩时间戳)。t 桩忽略插值,所以断言到 key 粒度;
  // 数值形态由 maker-shared 的 formatCompactTokens 单测覆盖。
  describe('token fallback when no money is available', () => {
    const details = {
      inputTokens: 12_400,
      outputTokens: 8_900,
      cacheReadTokens: 2_000_000,
      cacheCreateTokens: 86_400,
      totalTokens: 2_107_700,
      cacheHitRate: 0.95,
    };

    it('无金额 + 有 token 明细 → 显示 token,tooltip 说明取不到报价', () => {
      render(
        <MessageActionBar
          copyText="message body"
          align="left"
          hovered
          turnUsageDetails={details}
        />,
      );

      expect(screen.getByText('chat.messageActionBar.turnTokens')).toBeTruthy();
      const tooltip = screen.getByText(
        (_, element) =>
          element?.classList.contains('whitespace-pre-line') === true &&
          element.textContent?.includes('usageDetails.tokenLine') === true,
      );
      expect(tooltip.textContent).toBe(
        [
          'usageDetails.tokenLine',
          'usageDetails.cacheLine',
          'usageDetails.noBilledCost',
        ].join('\n'),
      );
      // 没有钱就不出现任何费用文案。
      expect(tooltip.textContent).not.toContain('usageDetails.costLine');
    });

    it('有金额 → 仍显示金额,不出现 token 回退', () => {
      render(
        <MessageActionBar
          copyText="message body"
          align="left"
          hovered
          turnMoney={{ amount: 1.5, currency: 'CNY', approximate: false, kind: 'actual-cost' }}
          turnUsageDetails={details}
        />,
      );

      expect(screen.queryByText('chat.messageActionBar.turnTokens')).toBeNull();
      expect(screen.getByText('¥1.50')).toBeTruthy();
    });

    it('金额为 0 → 视同无金额,走 token 回退(绝不显示 ¥0.00)', () => {
      render(
        <MessageActionBar
          copyText="message body"
          align="left"
          hovered
          turnMoney={{ amount: 0, currency: 'CNY', approximate: false, kind: 'actual-cost' }}
          turnUsageDetails={details}
        />,
      );

      expect(screen.getByText('chat.messageActionBar.turnTokens')).toBeTruthy();
      expect(screen.queryByText('¥0.00')).toBeNull();
    });

    it('既无金额也无明细 → 那一格不渲染', () => {
      render(<MessageActionBar copyText="message body" align="left" hovered />);
      expect(screen.queryByText('chat.messageActionBar.turnTokens')).toBeNull();
    });

    it('明细存在但 totalTokens 为 0 → 不渲染(没有可展示的事实)', () => {
      render(
        <MessageActionBar
          copyText="message body"
          align="left"
          hovered
          turnUsageDetails={{
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
            totalTokens: 0,
            cacheHitRate: null,
          }}
        />,
      );
      expect(screen.queryByText('chat.messageActionBar.turnTokens')).toBeNull();
    });

    it('user 侧(align=right)不出现 token 格', () => {
      render(
        <MessageActionBar
          copyText="message body"
          align="right"
          hovered
          turnUsageDetails={details}
        />,
      );
      expect(screen.queryByText('chat.messageActionBar.turnTokens')).toBeNull();
    });
  });
});
