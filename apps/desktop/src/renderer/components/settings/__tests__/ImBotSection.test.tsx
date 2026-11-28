// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果: ImBotSection 主页每个聊天软件只出现一次, 点进子页只显示该软件的官方卡与自己的机器人,
 *   返回回到主页; 设置搜索结果直接打开对应子页(含更深一层)。
 * - 规则依据: 2026-11-24 用户选定方案 A(一个聊天软件一行, 点进去设置); 设置搜索落点契约
 *   (settingsSearchCatalog.guard)。
 * - 现有覆盖为何不够: 旧用例断言的是 11 张折叠卡的分区布局, 结构已整体替换; 「服务器频道」搜索结果过去只滚到
 *   没展开的卡上(新结构改为直接打开那一页), 需要回归。
 * - 最小失败输入 / tier: jsdom unit; 子渠道组件以测试替身渲染, 官方组件替身回报各渠道可见。
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ImBotSection } from '../ImBotSection';
import { SettingsEscapeHarness } from './SettingsEscapeHarness';
import { SettingsSearchNavigationContext } from '../SettingsSearchNavigation';
import imBotSearch from '../ImBotSection.settings-search';

const authState = vi.hoisted(() => ({ mode: 'cloud' as 'signed-out' | 'local' | 'cloud' }));
const officialShows = vi.hoisted(() => [] as unknown[]);

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ mode: authState.mode, dataOwnerId: 'owner-1', user: null }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/features/bots/botStore', () => ({ useBotProfiles: () => [] }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn() }),
}));
vi.mock('../ImPluginEntrances', () => ({
  useImEntrancePlugins: () => [],
  ImPluginEntrancesCard: () => null,
}));
vi.mock('../HookConnectionsSection', () => ({
  HookConnectionsSection: ({ show, onSummary }: { show?: string; onSummary?: (summary: unknown) => void }) => {
    officialShows.push(show);
    useEffect(() => {
      const visible = { visible: true, enabled: false, linked: false, tone: 'attention', label: 'off' };
      onSummary?.({ slack: visible, telegram: visible, feishu: visible, discord: visible, x: visible });
    }, [onSummary]);
    return show && show !== 'list' ? <div data-testid={`official-${show}`} /> : null;
  },
}));
const offStatus = { configured: false, tone: 'off', labelKey: 'off' };
vi.mock('../WechatBotSection', () => ({
  WechatBotSettings: () => <div data-testid="personal-wechat" />,
  useWechatListStatus: () => ({ ...offStatus, companionBotId: null }),
}));
vi.mock('../WecomBotSection', () => ({ WecomBotSettings: () => null, useWecomListStatus: () => offStatus }));
vi.mock('../DingTalkBotSection', () => ({ DingTalkBotSettings: () => null, useDingTalkListStatus: () => offStatus }));
vi.mock('../TelegramBotSection', () => ({
  TelegramBotSettings: () => <div data-testid="personal-telegram" />,
  useTelegramListStatus: () => ({ configured: true, tone: 'connected', labelKey: 'settings.telegramBot.status.connected' }),
}));
vi.mock('../DiscordBotSection', async () => {
  const { useImBotNav } = await import('../ImBotPageParts');
  return {
    DiscordBotSettings: () => <div data-testid={`personal-discord-${useImBotNav().page ?? 'main'}`} />,
    useDiscordListStatus: () => offStatus,
  };
});
vi.mock('@/hooks/useFeishuBot', async () => {
  const { useState } = await import('react');
  return {
    useFeishuBot: () => {
      const [service, setService] = useState<'feishu' | 'lark'>('feishu');
      return {
        service, setService, appId: '', setAppId: vi.fn(), appSecret: '', setAppSecret: vi.fn(), status: 'idle',
        errorMessage: null, hasSavedCreds: false, hasLoadedState: true, ownerOpenId: null, validationError: null,
        isSaving: false, isClearing: false, isReconnecting: false, save: vi.fn(), reconnect: vi.fn(), clear: vi.fn(),
      };
    },
  };
});

function renderWithSearch(entryId?: string) {
  const entry = entryId ? imBotSearch.entries.find((item) => item.id === entryId)! : null;
  return render(
    <SettingsSearchNavigationContext.Provider value={{ entry, activation: entry ? 1 : 0 }}>
      <ImBotSection targetGroup={null} />
    </SettingsSearchNavigationContext.Provider>,
  );
}

const appRows = () => [...document.querySelectorAll('[data-im-bot-app]')].map((row) => row.getAttribute('data-im-bot-app'));

describe('ImBotSection', () => {
  beforeEach(() => {
    authState.mode = 'cloud';
    officialShows.length = 0;
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  });

  it('lists every chat app once, connected ones first, and opens an app page with only its own bots', () => {
    renderWithSearch();

    // Telegram 既有官方机器人又有自己的机器人, 主页只出现一次; 已连接的排在「已连接」组。
    expect(appRows()).toEqual(['telegram', 'wechat', 'feishu', 'wecom', 'dingtalk', 'slack', 'discord', 'x']);
    expect(screen.getByRole('heading', { name: 'settings.imBot.list.connected' })).toBeTruthy();

    fireEvent.click(document.querySelector('[data-im-bot-app="telegram"]')!);
    expect(screen.getByTestId('official-telegram')).toBeTruthy();
    expect(screen.getByTestId('personal-telegram')).toBeTruthy();
    expect(appRows()).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'settings.imBot.nav.backTo' }));
    expect(appRows()).toHaveLength(8);
    // 官方机器人始终只挂一份: 换页只换显示范围。
    expect(new Set(officialShows)).toEqual(new Set(['list', 'telegram']));
  });

  it('steps back one subpage on Escape instead of exiting settings, and surfaces existing companion-dedicated bots under Connected', async () => {
    const prevApi = (window as { electronAPI?: unknown }).electronAPI;
    (window as { electronAPI?: unknown }).electronAPI = {
      botImConnection: {
        list: vi.fn(async () => ({
          connections: [{
            id: 'a1b2c3d4e5f6',
            botId: 'bot-xiaoxue',
            channel: 'feishu',
            createdAt: 1,
            botContextId: 'cli_demo1234',
            status: { kind: 'connected' },
            identity: { username: null, ownerUserId: 'ou_1' },
          }],
        })),
        onChanged: () => () => {},
      },
    };
    try {
      render(
        <SettingsEscapeHarness>
          <SettingsSearchNavigationContext.Provider value={{ entry: null, activation: 0 }}>
            <ImBotSection targetGroup={null} />
          </SettingsSearchNavigationContext.Provider>
        </SettingsEscapeHarness>,
      );
      await act(async () => {});
      // 升级前在「伙伴 → 消息平台」配好的飞书机器人会出现在「已连接」组，不会误落到「还可以连接」。
      expect(appRows().slice(0, 2)).toEqual(['feishu', 'telegram']);
      fireEvent.click(document.querySelector('[data-im-bot-app="telegram"]')!);
      expect(screen.getByTestId('personal-telegram')).toBeTruthy();
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(appRows()).toHaveLength(8);
    } finally {
      (window as { electronAPI?: unknown }).electronAPI = prevApi;
    }
  });

  it('hides official-only apps in local mode', () => {
    authState.mode = 'local';
    renderWithSearch();

    expect(appRows()).not.toContain('slack');
    expect(appRows()).not.toContain('x');
    expect(appRows()).toContain('telegram');
  });

  it('opens the deeper page a search result points at', () => {
    renderWithSearch('imBot.discord.channels');

    expect(screen.getByTestId('personal-discord-channels')).toBeTruthy();
  });

  it('preselects Lark when opened from the Lark search result', () => {
    authState.mode = 'local';
    renderWithSearch('imBot.lark');

    expect(screen.getByRole('radio', { name: 'settings.feishuBot.services.lark' }).getAttribute('aria-checked')).toBe('true');
  });

  it('keeps the Lark choice for the setup page when the official Feishu bot is also offered', async () => {
    renderWithSearch('imBot.lark');

    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'settings.imBot.ways.setUp' }));
    expect(screen.getByRole('radio', { name: 'settings.feishuBot.services.lark' }).getAttribute('aria-checked')).toBe('true');
  });
});
