// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HookWorkspacePrefs, SharedProjectPrefsView } from '../../../../shared/hookControlIpc';
import { IM_DEFAULT_SETTINGS } from '../../../../shared/imDefaultSettings';

// The shared-quota rail observes auth; this component fixture has no auth host.
vi.mock('@/contexts/AuthContext', () => ({ useOptionalAuthUser: () => null }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { useHookWorkspacePrefs } from '../HookWorkspacePrefsEditor';

function row(workspace: string, patch: Partial<HookWorkspacePrefs> = {}): HookWorkspacePrefs {
  return { workspace, model: null, effort: null, agentKind: null, permissionMode: null, ...patch };
}

// 规则: 所有官方机器人(飞书 / Telegram / Slack / X)共用一套项目配置, 设置页只读写这一份。
// 这里通过真实的 hook 入口验证它与 main 的往来: 读哪一份、来源写到哪个键、迟到回执不回滚。
describe('useHookWorkspacePrefs 读写所有官方机器人共用的那一份', () => {
  const getSharedProjectPrefs = vi.fn(async (): Promise<{ prefs: SharedProjectPrefsView }> => ({
    prefs: { prefs: [] },
  }));

  beforeEach(() => {
    vi.clearAllMocks();
    getSharedProjectPrefs.mockResolvedValue({ prefs: { prefs: [] } });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      hookControl: {
        getSharedProjectPrefs,
        setSharedProjectPrefs: vi.fn(),
        onSharedProjectPrefsChanged: vi.fn(() => () => {}),
        getWorkspaceProviderSources: vi.fn(async () => ({ entries: [] })),
        setWorkspaceProviderSource: vi.fn(async () => ({ entries: [] })),
        onWorkspaceProviderSourcesChanged: vi.fn(() => () => {}),
      },
      maker: {
        imDefaultSettingsGet: vi.fn(async () => ({ agentKind: 'codex', agents: {} })),
      },
    };
  });

  // 现有覆盖缺口: 旧用例按渠道各读各的来源; 共用之后某个渠道残留的来源条目不得再影响显示,
  // 否则设置页显示的来源与实际派发用的(共用那份)不一致。最小失败输入: 同名项目同时有
  // 渠道残留条目与共用条目。tier: unit(jsdom)。
  it('来源只认共用那份的条目; 没有显式来源时整组继承所选引擎的默认来源与执行位置', async () => {
    vi.mocked(window.electronAPI.maker.imDefaultSettingsGet).mockResolvedValue({
      ...IM_DEFAULT_SETTINGS,
      agents: { ...IM_DEFAULT_SETTINGS.agents,
        'claude-code': { providerId: 'claude-owner', agentDeviceId: 'share:claude', model: 'claude-model', effort: 'high' },
        codex: { providerId: 'codex-owner', agentDeviceId: 'share:codex', model: 'codex-model', effort: 'high' },
      },
      defaults: IM_DEFAULT_SETTINGS, isCustomized: true, customizedKeys: [],
    });
    getSharedProjectPrefs.mockResolvedValue({ prefs: { prefs: [row('codex', { agentKind: 'codex' })] } });
    vi.mocked(window.electronAPI.hookControl.getWorkspaceProviderSources).mockResolvedValue({ entries: [
      { channel: 'shared', teamId: null, workspace: 'local', providerId: 'local-provider' },
      { channel: 'slack', teamId: null, workspace: 'inherited', providerId: 'stale-slack-provider' },
    ] });

    const { result } = renderHook(() => useHookWorkspacePrefs());
    await waitFor(() => expect(result.current.agentDeviceFor('codex')).toBe('share:codex'));
    expect(result.current.providerSourceFor('codex')).toBe('codex-owner');
    expect(result.current.agentDeviceFor('inherited')).toBe('share:claude');
    expect(result.current.providerSourceFor('inherited')).toBe('claude-owner');
    expect(result.current.agentDeviceFor('local')).toBeNull();
    expect(result.current.providerSourceFor('local')).toBe('local-provider');
    // 默认值与派发侧同源: 读 global 那份。
    expect(window.electronAPI.maker.imDefaultSettingsGet).toHaveBeenCalledWith(undefined);
    expect(result.current.editable).toBe(true);
  });

  // 现有覆盖缺口: 模型与来源是两个持久面, 写入必须落到同一个作用域(共用那份), 且先偏好后来源。
  // 最小失败输入: 一次同时带来源的模型选择。tier: unit(jsdom)。
  it('选模型时偏好与来源都写到共用那份, 来源在偏好写成功之后才落', async () => {
    const order: string[] = [];
    vi.mocked(window.electronAPI.hookControl.setSharedProjectPrefs).mockImplementation(async () => {
      order.push('prefs');
      return { prefs: { prefs: [row('cindy', { model: 'new-model' })] } };
    });
    vi.mocked(window.electronAPI.hookControl.setWorkspaceProviderSource).mockImplementation(async () => {
      order.push('source');
      return { entries: [{ channel: 'shared', teamId: null, workspace: 'cindy', providerId: 'p1' }] };
    });

    const { result } = renderHook(() => useHookWorkspacePrefs());
    await waitFor(() => expect(result.current.editable).toBe(true));
    await act(async () => {
      await result.current.applyPatch('cindy', { model: 'new-model' }, 'p1', null);
    });

    expect(order).toEqual(['prefs', 'source']);
    expect(window.electronAPI.hookControl.setSharedProjectPrefs).toHaveBeenCalledWith('cindy', { model: 'new-model' });
    expect(window.electronAPI.hookControl.setWorkspaceProviderSource).toHaveBeenCalledWith({
      channel: 'shared', teamId: null, workspace: 'cindy', providerId: 'p1', agentDeviceId: null,
    });
    expect(result.current.prefsFor('cindy').model).toBe('new-model');
    expect(result.current.providerSourceFor('cindy')).toBe('p1');
  });

  // 时序: 在 IM 里用 /model 改的值经推送先到, 之后才回来的旧写入回执不得把界面滚回去。
  // 最小失败输入: 写入在途时到达一次推送。tier: unit(jsdom)。
  it('较晚返回的写入回执不会覆盖较新的推送', async () => {
    const stale = { prefs: { prefs: [row('cindy', { model: 'stale-model' })] } };
    let resolveMutation!: (value: typeof stale) => void;
    const mutationResponse = new Promise<typeof stale>((resolve) => {
      resolveMutation = resolve;
    });
    let push!: (view: SharedProjectPrefsView) => void;
    vi.mocked(window.electronAPI.hookControl.setSharedProjectPrefs).mockReturnValue(mutationResponse);
    vi.mocked(window.electronAPI.hookControl.onSharedProjectPrefsChanged).mockImplementation((listener) => {
      push = listener;
      return () => {};
    });

    const { result } = renderHook(() => useHookWorkspacePrefs());
    await waitFor(() => expect(result.current.editable).toBe(true));

    act(() => {
      void result.current.applyPatch('cindy', { model: 'stale-model' });
    });
    await waitFor(() =>
      expect(window.electronAPI.hookControl.setSharedProjectPrefs).toHaveBeenCalledOnce(),
    );
    act(() => {
      push({ prefs: [row('cindy', { model: 'pushed-model' })] });
    });
    expect(result.current.prefsFor('cindy').model).toBe('pushed-model');

    await act(async () => {
      resolveMutation(stale);
      await mutationResponse;
    });
    expect(result.current.prefsFor('cindy').model).toBe('pushed-model');
    expect(result.current.pendingWs).toBeNull();
  });
});
