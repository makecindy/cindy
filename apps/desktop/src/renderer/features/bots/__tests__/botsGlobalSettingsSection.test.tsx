// @vitest-environment jsdom

/**
 * 设置 › 伙伴（功能级设置）。
 *
 * 空头支票复核 2026-08-19:这一屏原来摆着「新消息横幅 / 声音 / 勿扰时段」三行。
 * 前两行是真 Switch,第三行是只读文本 —— 但三者共同的问题是**没有任何消费方**:
 * 它们只写 `cindy.bots.preferences.v1` 这个 localStorage key,全仓再没有第二处
 * 读过它。而且接不上:伙伴的 canonical Session 不在
 * `DESKTOP_VISIBLE_SESSION_SOURCES` 里,压根不经过
 * `useSessionRunningStatus → notificationShowSessionEvent` 那条系统通知链,横幅
 * 与声音对伙伴消息不会触发。
 *
 * 于是三行整体删除,改成一句真实状态陈述。这组用例钉住两件事:
 *   1. 这一屏不许再出现任何"开关样子"的东西（除非它真的接上了）;
 *   2. 真正能用的入口（导入 / 逐伙伴导出）必须还在,并且真的调到链路上。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  exportBotBundle: vi.fn(async (_botId: string) => ({ canceled: false, redactionCount: 0 })),
  profiles: [
    { id: 'bot-1', name: '小柚', status: 'active' },
    { id: 'bot-2', name: '归档的', status: 'archived' },
  ] as Array<{ id: string; name: string; status: string }>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('../BotAvatar', () => ({
  BotAvatar: ({ bot }: { bot: { name: string } }) => <span data-avatar={bot.name} />,
}));
vi.mock('../botStore', () => ({
  exportBotBundle: (...args: unknown[]) => mocks.exportBotBundle(...(args as [string])),
  useBotProfiles: () => mocks.profiles,
}));

import { BotsGlobalSettingsSection } from '../BotsGlobalSettingsSection';

beforeEach(() => {
  mocks.navigate.mockClear();
  mocks.exportBotBundle.mockClear();
  mocks.exportBotBundle.mockResolvedValue({ canceled: false, redactionCount: 0 });
});

afterEach(() => cleanup());

describe('设置 › 伙伴', () => {
  it('不再摆没人消费的通知开关', () => {
    const { container } = render(<BotsGlobalSettingsSection />);

    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    // 「勿扰时段」那一行连值都是假的（存了个默认串、既不可编辑也没人读），一并删掉。
    expect(container.textContent).not.toContain('quietHours');
    expect(container.textContent).not.toContain('notifications.banner');
    expect(container.textContent).not.toContain('notifications.sound');
  });

  it('改成一句能兑现的状态陈述', () => {
    const { container } = render(<BotsGlobalSettingsSection />);

    expect(container.textContent).toContain('bots.globalSettings.notifications.title');
    expect(container.textContent).toContain('bots.globalSettings.notifications.note');
  });

  it('导入走真实入口', () => {
    render(<BotsGlobalSettingsSection />);

    fireEvent.click(screen.getByText('bots.globalSettings.portability.importAction'));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots?import=1');
  });

  it('逐伙伴导出真的调到导出链路，且不列归档伙伴', async () => {
    render(<BotsGlobalSettingsSection />);

    expect(screen.getByText('小柚')).toBeTruthy();
    expect(screen.queryByText('归档的')).toBeNull();

    fireEvent.click(screen.getByText('bots.globalSettings.portability.exportAction'));
    await waitFor(() => expect(mocks.exportBotBundle).toHaveBeenCalledWith('bot-1'));
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
  });
});
