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
 *   1. 这一屏不许再出现任何没接运行时的通知设置;
 *   2. 真正能用的模型链入口必须真的调到链路上。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
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
vi.mock('../BotModelChainEditor', () => ({
  BotModelChainEditor: ({ onChange }: { onChange: (value: unknown[]) => void }) => (
    <button type="button" onClick={() => onChange([{
      harness: 'pi',
      model: 'z-ai/glm-5.3-flash',
      providerId: 'xd',
      effort: 'high',
      fastMode: false,
    }])}>model-chain-editor</button>
  ),
}));
vi.mock('../botStore', () => ({
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

  it('模型链修改走主进程持久化入口', async () => {
    render(<BotsGlobalSettingsSection />);

    fireEvent.click(screen.getByText('model-chain-editor'));
    await waitFor(() => expect(mocks.setBotGlobalModelChain).toHaveBeenCalledWith([
      expect.objectContaining({ harness: 'pi', model: 'z-ai/glm-5.3-flash' }),
    ]));
  });
});
