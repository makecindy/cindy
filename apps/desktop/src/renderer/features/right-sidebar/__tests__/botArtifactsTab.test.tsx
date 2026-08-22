// @vitest-environment jsdom

/**
 * 「交付物」右栏 tab 的注册契约 + 面板过滤行为。
 *
 * 注册部分只验 registry 契约(kind / 单例 / 不进「+」菜单 / state 序列化),不启动
 * 真实 Shell;面板部分把投影 IPC 打桩,验 chip 过滤、空态分支与打开动作。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTabKind, listTabKindMenuMetas } from '../registry';
import { makeBotArtifact, type BotArtifactItem } from '../../../../shared/botArtifact';

const mocks = vi.hoisted(() => ({ openArtifact: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/features/bots/useBotArtifactOpen', () => ({
  useBotArtifactOpen: () => ({ openArtifact: mocks.openArtifact, artifactLightboxes: null }),
}));

// 注册是 import 副作用:静态引入一次,别在测试里重复 import(模块缓存不会二次执行)。
import '../plugins/bot-artifacts/index';
import { BotArtifactsBody } from '../plugins/bot-artifacts/BotArtifactsBody';
import type { TabKindHostContext } from '../types';

function item(target: string, createdAt: number): BotArtifactItem {
  return makeBotArtifact({ source: 'generated', target, isRef: false, createdAt });
}

const ITEMS = [
  item('/w/plan.md', 300),
  item('/w/data.csv', 200),
  item('/w/hero.png', 100),
];

function ctx(overrides: Partial<TabKindHostContext> = {}): TabKindHostContext {
  return {
    tabId: 'tab-1',
    sessionId: 'session-1',
    workdir: '/w',
    remoteHostId: null,
    deviceLinkDeviceId: null,
    patchState: vi.fn(),
    onVisibilityChange: vi.fn(),
    setCloseInterceptor: vi.fn(() => () => {}),
    ...overrides,
  };
}

function stubProjection(items: BotArtifactItem[], truncated = false): void {
  (globalThis as unknown as { window: Record<string, unknown> }).window.electronAPI = {
    localDb: {
      bots: { artifacts: vi.fn(async () => ({ botId: 'bot-a', items, truncated })) },
      messages: { onCreated: vi.fn(() => () => {}) },
    },
    maker: { onBotDelegationChanged: vi.fn(() => () => {}) },
  };
}

beforeEach(() => {
  mocks.openArtifact.mockClear();
  stubProjection(ITEMS);
});

afterEach(() => cleanup());

describe('bot-artifacts tab registration', () => {
  it('registers a per-task singleton that never shows up in the + menu', () => {
    const plugin = getTabKind('bot-artifacts');
    expect(plugin).not.toBeNull();
    expect(plugin!.menu.singleton).toBe(true);
    expect(plugin!.menu.hiddenFromMenu).toBe(true);
    // 只由伙伴会话自动创建 —— 用户不能从「+」菜单手动开一个。
    expect(listTabKindMenuMetas().some((meta) => meta.kind === 'bot-artifacts')).toBe(false);
  });

  it('persists the filter but never persists a one-shot highlight', () => {
    const plugin = getTabKind('bot-artifacts')!;
    expect(plugin.defaultState()).toEqual({ filter: 'all', focusArtifactId: null });
    expect(plugin.serializeState!({ filter: 'image', focusArtifactId: 'x' } as never)).toEqual({
      filter: 'image',
      focusArtifactId: null,
    });
    expect(plugin.hydrateState!({ filter: 'deck', focusArtifactId: 'x' })).toEqual({
      filter: 'deck',
      focusArtifactId: null,
    });
    // 垃圾 / 缺失 state 回落到「全部」,不把面板卡在一个不存在的分类上。
    expect(plugin.hydrateState!(null)).toEqual({ filter: 'all', focusArtifactId: null });
  });
});

describe('BotArtifactsBody', () => {
  it('lists every artifact under 全部 and counts them in the header', async () => {
    render(<BotArtifactsBody state={{ filter: 'all' }} ctx={ctx()} />);
    await waitFor(() => expect(screen.getAllByTestId('bot-artifact-grid-card')).toHaveLength(3));
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('narrows to one category when a chip is active', async () => {
    render(<BotArtifactsBody state={{ filter: 'sheet' }} ctx={ctx()} />);
    await waitFor(() => expect(screen.getAllByTestId('bot-artifact-grid-card')).toHaveLength(1));
    expect(screen.getByText('data.csv')).toBeTruthy();
  });

  it('asks the host to persist the chip the user clicked', async () => {
    const host = ctx();
    render(<BotArtifactsBody state={{ filter: 'all' }} ctx={host} />);
    await waitFor(() => expect(screen.getAllByTestId('bot-artifact-grid-card')).toHaveLength(3));
    fireEvent.click(screen.getByText('bots.artifacts.category.image'));
    expect(host.patchState).toHaveBeenCalledWith({ filter: 'image' });
  });

  it('separates 这一类还没有 from TA 还没交付过东西', async () => {
    render(<BotArtifactsBody state={{ filter: 'deck' }} ctx={ctx()} />);
    await waitFor(() => expect(screen.getByText('bots.artifacts.emptyFiltered')).toBeTruthy());
    cleanup();
    stubProjection([]);
    render(<BotArtifactsBody state={{ filter: 'all' }} ctx={ctx()} />);
    await waitFor(() => expect(screen.getByText('bots.artifacts.empty')).toBeTruthy());
  });

  it('opens the artifact through the shared opener', async () => {
    render(<BotArtifactsBody state={{ filter: 'all' }} ctx={ctx()} />);
    await waitFor(() => expect(screen.getAllByTestId('bot-artifact-grid-card')).toHaveLength(3));
    fireEvent.click(screen.getAllByTestId('bot-artifact-grid-card')[0]!);
    expect(mocks.openArtifact).toHaveBeenCalledWith(ITEMS[0]);
  });

  it('highlights the artifact a chat card jumped to', async () => {
    render(
      <BotArtifactsBody state={{ filter: 'all', focusArtifactId: ITEMS[1]!.id }} ctx={ctx()} />,
    );
    await waitFor(() => expect(screen.getAllByTestId('bot-artifact-grid-card')).toHaveLength(3));
    const cards = screen.getAllByTestId('bot-artifact-grid-card');
    expect(cards[1]!.className).toContain('border-[var(--focus-ring)]');
    expect(cards[0]!.className).toContain('border-[var(--border-default)]');
  });

  it('says so instead of showing a permanently empty library on a remote task', async () => {
    render(<BotArtifactsBody state={{ filter: 'all' }} ctx={ctx({ deviceLinkDeviceId: 'dev-1' })} />);
    expect(screen.getByText('bots.artifacts.remoteUnavailable')).toBeTruthy();
    expect(window.electronAPI.localDb.bots.artifacts).not.toHaveBeenCalled();
  });

  /*
    归属未解析时仍然 fail closed(不去读本机数据),但**不再说那句错话**。

    `undefined` 是「还没解析出来」,不是「在远端」。早前两者共用一条判定,于是
    冷启动瞬间会闪一句「远程任务暂不支持作品集」;分离出去的侧栏窗口若一直收不到
    context 推送,还会长期停在那句话上 —— 说了一个它并不知道的结论。
  */
  it('归属还没解析出来时不读数据,但也不说「远程不支持」', async () => {
    render(
      <BotArtifactsBody state={{ filter: 'all' }} ctx={ctx({ deviceLinkDeviceId: undefined })} />,
    );
    // fail closed 照旧:没解析出归属就不碰本机数据。
    expect(window.electronAPI.localDb.bots.artifacts).not.toHaveBeenCalled();
    // 但显示的是加载态,不是那句关于远端的结论。
    expect(screen.queryByText('bots.artifacts.remoteUnavailable')).toBeNull();
  });

  it('reports truncation so 200 件上限不被当成全部', async () => {
    stubProjection(ITEMS, true);
    render(<BotArtifactsBody state={{ filter: 'all' }} ctx={ctx()} />);
    await waitFor(() => expect(screen.getByText('bots.artifacts.truncated')).toBeTruthy());
  });
});
