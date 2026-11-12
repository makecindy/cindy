// @vitest-environment jsdom

/**
 * VisionBridgeSection 渲染测试。
 *
 * 回归目标：
 *   1. 默认关闭时总开关 off；
 *   2. 目标模型清单按三态标注渲染（已知无视觉 / 已知有视觉 / 未知）；
 *   3. 勾选目标模型 → IPC SET 携带 targetModels patch；
 *   4. 视觉后端主/备 ModelSelector 装配；
 *   5. 总开关关闭时隐藏目标模型/后端控件，重新开启保留已保存选择。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VisionBridgeSettingsState } from '../../../../shared/visionBridgeSettings';
import { VisionBridgeSection } from '../VisionBridgeSection';

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;

// The shared-quota rail observes auth; this component fixture has no auth host.
vi.mock('@/contexts/AuthContext', () => ({ useOptionalAuthUser: () => null }));
// Collapse 的动画帧不在 jsdom 自动推进；此组件回归验证 reduced-motion 终态。
vi.mock('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => true }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
}));

const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));

const settingsGetMock = vi.hoisted(() => vi.fn());
const settingsSetMock = vi.hoisted(() => vi.fn());
const settingsResetMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useModelPricing', () => ({
  useGatewayModelPricing: () => null,
  useReferenceModelPricing: () => null,
}));

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({
    providers: [
      {
        id: 'anthropic',
        name: 'Anthropic',
        source: 'builtin',
        auth: { method: 'oauth' },
        agents: ['claude-code', 'codex', 'pi'],
        connected: true,
        suspended: false,
        routing: { 'claude-code': { upstream: 'https://x', authStrategy: 'gateway-key' } },
        models: {
          'claude-code': [{ id: 'claude-opus-5', name: 'Claude Opus 5' }],
          codex: [],
          pi: [],
        },
      },
      {
        id: 'deepseek',
        name: 'DeepSeek',
        source: 'user',
        auth: { method: 'apiKey' },
        agents: ['claude-code', 'codex', 'pi'],
        connected: true,
        suspended: false,
        routing: { 'claude-code': { upstream: 'https://x', authStrategy: 'api-key-header' } },
        models: {
          'claude-code': [
            { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
            { id: 'deepseek/deepseek-v3', name: 'DeepSeek V3' },
            { id: 'mystery/m1', name: 'Mystery M1' },
          ],
          codex: [],
          pi: [],
        },
      },
    ],
    loading: false,
    providerOrder: [],
    ownerGeneration: 0,
    refetch: vi.fn(),
  }),
}));

(window as unknown as { electronAPI: unknown }).electronAPI = {
  maker: {
    visionBridgeSettingsGet: settingsGetMock,
    visionBridgeSettingsSet: settingsSetMock,
    visionBridgeSettingsReset: settingsResetMock,
    usage: {
      getModelPricing: vi.fn().mockResolvedValue(null),
      getReferenceModelPricing: vi.fn().mockResolvedValue(null),
      onModelPricingChanged: vi.fn().mockReturnValue(() => undefined),
      onReferenceModelPricingChanged: vi.fn().mockReturnValue(() => undefined),
    },
  },
};

function baseSettings(overrides: Partial<VisionBridgeSettingsState> = {}): VisionBridgeSettingsState {
  return {
    enabled: false,
    targetModels: [],
    primary: null,
    fallback: null,
    isCustomized: false,
    customizedKeys: [],
    defaults: {
      enabled: false,
      targetModels: [],
      primary: null,
      fallback: null,
    },
    ...overrides,
  };
}

beforeEach(() => {
  cleanup();
  vi.resetAllMocks();
  settingsGetMock.mockResolvedValue(baseSettings());
  settingsSetMock.mockResolvedValue(baseSettings());
  settingsResetMock.mockResolvedValue(baseSettings());
});

afterEach(() => {
  cleanup();
});

describe('VisionBridgeSection', () => {
  it('renders target models with capability labels', async () => {
    settingsGetMock.mockResolvedValue(baseSettings({ enabled: true }));
    render(<VisionBridgeSection />);
    await waitFor(() => expect(screen.getByText('Claude Opus 5')).toBeTruthy());
    // 已知有视觉
    expect(screen.getByText('Claude Opus 5')).toBeTruthy();
    // 已知无视觉（deepseek）
    expect(screen.getByText('DeepSeek V4 Flash')).toBeTruthy();
    // 未知
    expect(screen.getByText('Mystery M1')).toBeTruthy();
    // 三态标注（i18n key 直接当文案）
    expect(screen.getAllByText('settings.visionBridge.capability.vision').length).toBeGreaterThan(0);
    expect(screen.getAllByText('settings.visionBridge.capability.noVision').length).toBeGreaterThan(0);
    expect(screen.getAllByText('settings.visionBridge.capability.unknown').length).toBeGreaterThan(0);
  });

  it('toggle enabled writes enabled patch', async () => {
    render(<VisionBridgeSection />);
    await waitFor(() => expect(settingsGetMock).toHaveBeenCalled());
    const toggle = screen.getByLabelText('settings.visionBridge.enableAria');
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(settingsSetMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: true })),
    );
  });

  it('cancelling one default-checked no-vision model keeps the other default-checked ones', async () => {
    // 未自定义时 no-vision（deepseek-v4-flash / deepseek-v3）默认勾选（isTargetDefaultChecked），
    // 不在显式 targetModels。取消其中一个 → 显式列表必须 seed 全部当前有效勾选项再移除
    // 被点项——否则保存后 customized=true，其余默认勾选项全部消失（codex P2）。
    settingsGetMock.mockResolvedValue(baseSettings({ enabled: true }));
    render(<VisionBridgeSection />);
    const toggles = await screen.findAllByLabelText(
      'settings.visionBridge.targetModels.toggleAria',
    );
    // 排序后 no-vision 在前：deepseek-v3、deepseek-v4-flash、mystery-m1、claude-opus-5。
    fireEvent.click(toggles[0]);
    await waitFor(() =>
      expect(settingsSetMock).toHaveBeenCalledWith(
        expect.objectContaining({ targetModels: ['deepseek/deepseek-v4-flash'] }),
      ),
    );
  });

  it('checking a vision model adds it to targetModels, keeping default-checked no-vision ones', async () => {
    // 未自定义时 vision 模型默认不勾选；点击加入数组。首次 toggle 会 seed 当前有效
    // 勾选全集（两个默认 no-vision），再加被勾的 vision 模型——保存后其余默认勾选项
    // 不丢失（codex P2）。
    settingsGetMock.mockResolvedValue(baseSettings({ enabled: true }));
    render(<VisionBridgeSection />);
    const toggles = await screen.findAllByLabelText(
      'settings.visionBridge.targetModels.toggleAria',
    );
    // Claude Opus 5 是 vision，在 no-vision 之后（排序）。找到它的 Switch。
    const claudeRow = screen.getByText('Claude Opus 5');
    const claudeSwitch = claudeRow.closest('div')?.parentElement?.querySelector('[data-slot="switch"]') as HTMLElement | null;
    fireEvent.click(claudeSwitch ?? toggles[toggles.length - 1]);
    await waitFor(() =>
      expect(settingsSetMock).toHaveBeenCalledWith(
        expect.objectContaining({
          targetModels: ['deepseek/deepseek-v3', 'deepseek/deepseek-v4-flash', 'claude-opus-5'],
        }),
      ),
    );
  });

  // 生产入口：VisionBridgeSection；规则：配置分层 §1（关闭时隐藏详细配置）。
  // 旧用例只检查禁用态，未覆盖明细随总开关显示、隐藏且保留已保存选择。
  // 最小失败输入：关闭视觉桥但已有模型选择；tier：unit（真实组件 + jsdom）。
  it('shows model settings only while enabled and preserves saved choices', async () => {
    const saved = baseSettings({
      targetModels: ['deepseek/deepseek-v3'],
      primary: { providerId: 'anthropic', modelId: 'claude-opus-5' },
      isCustomized: true,
      customizedKeys: ['targetModels'],
    });
    const off = { ...saved, enabled: false };
    const on = { ...saved, enabled: true };
    settingsGetMock.mockResolvedValue(off);
    settingsSetMock.mockImplementation(async ({ enabled }) => enabled ? on : off);
    render(<VisionBridgeSection />);
    const toggle = await screen.findByLabelText('settings.visionBridge.enableAria');

    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByRole('switch', { name: 'settings.visionBridge.targetModels.toggleAria' })).toBeNull();
    expect(screen.queryByRole('button', { expanded: false })).toBeNull();

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    await screen.findByText('settings.visionBridge.targetModels.label');
    expect(screen.getByText('settings.visionBridge.backends.label')).toBeTruthy();
    expect(screen.getAllByRole('switch', { name: 'settings.visionBridge.targetModels.toggleAria' })[0].getAttribute('aria-checked')).toBe('true');

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    await waitFor(() => expect(screen.queryByRole('switch', { name: 'settings.visionBridge.targetModels.toggleAria' })).toBeNull());
    expect(screen.queryByRole('button', { expanded: false })).toBeNull();

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    await screen.findByText('settings.visionBridge.targetModels.label');
    expect(screen.getAllByRole('switch', { name: 'settings.visionBridge.targetModels.toggleAria' })[0].getAttribute('aria-checked')).toBe('true');
    expect(settingsSetMock.mock.calls).toEqual([[{ enabled: true }], [{ enabled: false }], [{ enabled: true }]]);
    expect(settingsResetMock).not.toHaveBeenCalled();
  });
});
