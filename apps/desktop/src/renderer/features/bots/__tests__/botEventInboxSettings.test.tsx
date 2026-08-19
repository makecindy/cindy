// @vitest-environment jsdom

/**
 * 「自动关注其它任务」这一节。
 *
 * 空头支票复核 2026-08-19:那颗开关的 disabled 条件里含 `bot.status !== 'active'`,
 * 而**归档伙伴的设置页基本只剩这一屏** —— 于是整节围着一颗用户无论如何都翻不动的
 * 开关转,既不解释为什么,也不指出怎么才能翻动它。摆一个点不动的开关不如说清现状:
 * 归档态改为一句状态陈述 + 恢复路径,下面的事件时间线仍然照常可读（真数据）。
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BotProfile } from '../botStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

import { BotEventInboxSettings } from '../BotEventInboxSettings';

function profile(status: BotProfile['status']): BotProfile {
  return { id: 'bot-1', name: '小柚', status } as unknown as BotProfile;
}

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: {
      maker: {
        botInbox: {
          listSubscriptions: vi.fn(async () => []),
          list: vi.fn(async () => []),
          onChanged: () => () => undefined,
          setSubscription: vi.fn(async () => undefined),
          retry: vi.fn(async () => undefined),
        },
      },
    },
  });
});

afterEach(() => cleanup());

describe('自动关注其它任务', () => {
  it('活跃伙伴身上是一颗真能翻的开关', async () => {
    render(<BotEventInboxSettings bot={profile('active')} />);

    const toggle = await screen.findByRole('switch');
    expect(toggle.getAttribute('data-disabled')).not.toBe('true');
    expect(toggle.hasAttribute('disabled')).toBe(false);
  });

  it('归档伙伴身上不摆点不动的开关，改说现状与恢复路径', async () => {
    render(<BotEventInboxSettings bot={profile('archived')} />);

    await waitFor(() =>
      expect(screen.getByText('bots.inbox.archivedNote')).toBeTruthy(),
    );
    expect(screen.queryByRole('switch')).toBeNull();
    // 这一节的标题与说明仍在——只是不再假装可操作。
    expect(screen.getByText('bots.inbox.title')).toBeTruthy();
  });
});
