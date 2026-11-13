// @vitest-environment jsdom

/**
 * 设置 › 伙伴（功能级设置）。
 *
 * 空头支票复核 2026-08-19:这一屏原来摆着「新消息横幅 / 声音 / 勿扰时段」三行。
 * 前两行是真 Switch,第三行是只读文本 —— 但三者共同的问题是**没有任何消费方**:
 * 它们只写 `cindy.bots.preferences.v1` 这个 localStorage key,全仓再没有第二处
 * 读过它。伙伴现在复用全局 Session 通知链，不再维护另一套 Bot 专用开关。
 *
 * 于是三行连同无用状态文案整体删除。导入/导出(portability)整段能力随本轮砍削
 * 一并移除;这组用例只钉住剩下的两件事:
 *   1. 这一屏不许再出现任何没接运行时的设置(唯一的开关「显示回复对应的消息」由私聊气泡读取);
 *   2. 全局模型链入口已退役，逐伙伴配置保留。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resetBotGlobalModelChain: vi.fn(async (): Promise<void> => undefined),
  customized: true as boolean | null,
  setBotGlobalModelChain: vi.fn(async (_chain: unknown[]) => undefined),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));
vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelector: () => <div data-testid="model-selector" />,
}));
vi.mock('@/hooks/useProviders', () => ({ useProviders: () => ({}) }));
vi.mock('@/hooks/useAvailableAgents', () => ({ useAvailableAgents: () => ({}) }));
vi.mock('../BotModelChainEditor', () => ({
  BotModelChainEditor: ({ onChange, onRestoreDefault }: { onChange: (value: unknown[]) => void; onRestoreDefault?: () => void }) => (
    <>
    <button type="button" onClick={() => onChange([{
      harness: 'pi',
      model: 'z-ai/glm-5.3-flash',
      providerId: 'xd',
      effort: 'high',
      fastMode: false,
    }])}>model-chain-editor</button>
    {onRestoreDefault && <button onClick={onRestoreDefault}>restore-default</button>}
    </>
  ),
}));
vi.mock('../botStore', () => ({
  isBotGlobalModelChainCustomized: () => mocks.customized,
  resetBotGlobalModelChain: () => mocks.resetBotGlobalModelChain(),
  getEffectiveBotModelChain: () => [{
    harness: 'pi',
    model: 'z-ai/glm-5.3-flash',
    providerId: 'xd',
    effort: 'high',
    fastMode: false,
  }],
  setBotGlobalModelChain: (chain: unknown[]) => mocks.setBotGlobalModelChain(chain),
  subscribeBotGlobalModel: () => () => {},
}));

import { BotsGlobalSettingsSection } from '../BotsGlobalSettingsSection';

beforeEach(() => {
  mocks.setBotGlobalModelChain.mockClear();
  mocks.resetBotGlobalModelChain.mockReset();
  mocks.customized = true;
});

afterEach(() => cleanup());

describe('设置 › 伙伴', () => {
  it('不再摆没人消费的通知开关', () => {
    const { container } = render(<BotsGlobalSettingsSection />);

    // 唯一的开关是「显示回复对应的消息」:私聊气泡读它(BotChatReplyTarget),切换真的落到偏好里。
    const switches = screen.queryAllByRole('switch');
    expect(switches.map((item) => item.getAttribute('aria-label'))).toEqual(['bots.globalSettings.showReplyTarget']);
    fireEvent.click(switches[0]!);
    expect(localStorage.getItem('bots.chat.showReplyTarget')).toBe('true');
    fireEvent.click(switches[0]!);
    expect(localStorage.getItem('bots.chat.showReplyTarget')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    // 「勿扰时段」那一行连值都是假的（存了个默认串、既不可编辑也没人读），一并删掉。
    expect(container.textContent).not.toContain('quietHours');
    expect(container.textContent).not.toContain('notifications.banner');
    expect(container.textContent).not.toContain('notifications.sound');
  });

  it('连假的通知状态文案也不保留', () => {
    const { container } = render(<BotsGlobalSettingsSection />);

    expect(container.textContent).not.toContain('bots.globalSettings.notifications.title');
    expect(container.textContent).not.toContain('bots.globalSettings.notifications.note');
  });

  it('不再摆导入/导出(portability 已整段砍除)', () => {
    const { container } = render(<BotsGlobalSettingsSection />);

    expect(container.textContent).not.toContain('bots.globalSettings.portability');
    expect(container.textContent).not.toContain('bots.portability');
  });

  // Unit regression: render the real settings section. Global model editing was
  // removed by product decision; per-teammate model editors remain elsewhere.
  it('does not offer the retired global model chain or reset action', () => {
    render(<BotsGlobalSettingsSection />);
    expect(screen.queryByText('model-chain-editor')).toBeNull();
    expect(screen.queryByText('restore-default')).toBeNull();
    expect(mocks.setBotGlobalModelChain).not.toHaveBeenCalled();
  });
});
