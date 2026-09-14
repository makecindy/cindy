// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderPrefsView, SlackHookView } from '../../../../shared/hookControlIpc';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: { provider?: string }) =>
      vars?.provider ? `${key}:${vars.provider}` : key,
  }),
}));

import { useHookWorkspacePrefs } from '../HookWorkspacePrefsEditor';

const BASE_HOOK: SlackHookView = {
  enabled: true,
  lifecycleAnnouncement: false,
  url: 'wss://im.example.test',
  workspaces: { cindy: '/repos/cindy' },
  status: 'connected',
  lastError: null,
  binding: null,
  bindings: [],
  pendingBind: null,
  serverMultiTeam: false,
  telegram: {
    enabled: false,
    url: 'wss://telegram-hook.example.test',
    status: 'disabled',
    lastError: null,
    available: true,
    capabilityPending: false,
    defaultWorkspace: null,
    binding: null,
  },
  x: {
    enabled: false,
    url: '',
    status: 'disabled',
    lastError: null,
    available: false,
    capabilityPending: false,
    defaultWorkspace: null,
    binding: null,
  },
};

const TELEGRAM_CONFIRMED: SlackHookView = {
  ...BASE_HOOK,
  telegram: {
    enabled: true,
    url: 'wss://telegram-hook.example.test',
    status: 'connected',
    lastError: null,
    available: true,
    capabilityPending: false,
    defaultWorkspace: null,
    binding: {
      provider: 'telegram',
      state: 'confirmed',
      attemptId: null,
      bindingId: 'binding-1',
      principalId: 'user-1',
      principalName: 'Cindy User',
      scopeId: 'bot-1',
      scopeName: 'cindy_example_bot',
      connectUrl: null,
      expiresAt: null,
      reason: null,
      remediationUrl: 'https://t.me/cindy_example_bot',
      actions: ['revoke'],
    },
  },
};

const X_CONFIRMED: SlackHookView = {
  ...BASE_HOOK,
  x: {
    enabled: true,
    url: 'wss://x-hook.example.test',
    status: 'connected',
    lastError: null,
    available: true,
    capabilityPending: false,
    defaultWorkspace: null,
    binding: {
      provider: 'x',
      state: 'confirmed',
      attemptId: null,
      bindingId: 'x-binding-1',
      principalId: 'x-user-1',
      principalName: '@dash',
      scopeId: 'bot-x',
      scopeName: 'CindyBot',
      connectUrl: null,
      expiresAt: null,
      reason: null,
      remediationUrl: 'https://x.com/CindyBot',
      actions: ['revoke'],
    },
  },
};

const TELEGRAM_REBOUND: SlackHookView = {
  ...TELEGRAM_CONFIRMED,
  telegram: {
    ...TELEGRAM_CONFIRMED.telegram,
    binding: {
      ...TELEGRAM_CONFIRMED.telegram.binding!,
      bindingId: 'binding-2',
      principalId: 'user-2',
      principalName: 'Another Cindy User',
    },
  },
};

describe('useHookWorkspacePrefs provider isolation', () => {
  const getProviderWorkspacePrefs = vi.fn<
    (provider: 'telegram' | 'x') => Promise<{ prefs: ProviderPrefsView }>
  >(async () => ({
    prefs: {
      provider: 'telegram' as const,
      bindingId: 'binding-1',
      scopeId: null,
      bound: true,
      prefs: [],
    },
  }));
  const getWorkspacePrefs = vi.fn(async () => ({
    prefs: { bound: true, prefs: [] as Array<{
      workspace: string;
      model: string | null;
      effort: string | null;
      agentKind: string | null;
      permissionMode: string | null;
    }> },
  }));

  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      hookControl: {
        getProviderWorkspacePrefs,
        getWorkspacePrefs,
        onProviderPrefsChanged: vi.fn(() => () => {}),
        onPrefsChanged: vi.fn(() => () => {}),
        setProviderWorkspacePrefs: vi.fn(),
        setWorkspacePrefs: vi.fn(),
        getWorkspaceProviderSources: vi.fn(async () => ({ entries: [] })),
        setWorkspaceProviderSource: vi.fn(async () => ({ entries: [] })),
        onWorkspaceProviderSourcesChanged: vi.fn(() => () => {}),
      },
      maker: {
        imDefaultSettingsGet: vi.fn(async () => ({ agentKind: 'codex', agents: {} })),
      },
    };
  });

  it('Telegram 未连接时不发起 provider prefs 请求，绑定确认后沿 ready 边沿首次拉取', async () => {
    const { result, rerender } = renderHook(({ hook }) => useHookWorkspacePrefs(hook, 'telegram'), {
      initialProps: { hook: BASE_HOOK },
    });

    // Telegram disabled/unbound: 不发起无意义的 provider prefs IPC(issue #279)——
    // 否则会以 HOOK_NOT_CONNECTED 失败并在 Main 侧打出误导性的 Slack ERROR。
    // 用 effect 侧信号(imDefaultSettingsGet 在挂载 effect 内无条件调用)确认 effect
    // 已 flush 再做否定断言 —— editable 首帧即为 false, 直接 waitFor 它会在 effect
    // 跑之前 resolve, 捕捉不到「挂载即发 IPC」的回归(issue #279 review)。
    await waitFor(() =>
      expect(window.electronAPI.maker.imDefaultSettingsGet).toHaveBeenCalled(),
    );
    expect(getProviderWorkspacePrefs).not.toHaveBeenCalled();
    expect(getWorkspacePrefs).not.toHaveBeenCalled();
    expect(result.current.editable).toBe(false);

    rerender({ hook: TELEGRAM_CONFIRMED });
    await waitFor(() => expect(getProviderWorkspacePrefs).toHaveBeenCalledTimes(1));
    expect(getWorkspacePrefs).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.editable).toBe(true));
    expect(result.current.hint).toBeNull();
  });

  it('Slack 已连接时挂载即拉取偏好，不触碰 Telegram 通道', async () => {
    renderHook(() => useHookWorkspacePrefs(BASE_HOOK, 'slack'));
    await waitFor(() => expect(getWorkspacePrefs).toHaveBeenCalledTimes(1));
    expect(getProviderWorkspacePrefs).not.toHaveBeenCalled();
  });

  it('Slack 开关开着但 hook 掉线时仍拉取本机偏好，可编辑', async () => {
    getWorkspacePrefs.mockResolvedValue({
      prefs: {
        bound: true,
        prefs: [
          {
            workspace: 'cindy',
            model: 'claude-opus-4-8',
            effort: null,
            agentKind: 'claude-code',
            permissionMode: null,
          },
        ] as Array<{
          workspace: string;
          model: string | null;
          effort: string | null;
          agentKind: string | null;
          permissionMode: string | null;
        }>,
      },
    });
    const { result } = renderHook(() =>
      useHookWorkspacePrefs({ ...BASE_HOOK, status: 'error', lastError: 'offline' }, 'slack'),
    );
    await waitFor(() => expect(getWorkspacePrefs).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.editable).toBe(true));
    expect(result.current.prefsFor('cindy').model).toBe('claude-opus-4-8');
    expect(result.current.hint).toBe('settings.tina.prefs.offlineLocal:settings.tina.prefs.providerSlack');
  });

  it('离线时仍按缓存的 Slack multi-team 绑定写入 teamId', async () => {
    getWorkspacePrefs.mockResolvedValue({ prefs: { bound: true, prefs: [] } });
    vi.mocked(window.electronAPI.hookControl.setWorkspacePrefs).mockResolvedValue({
      prefs: { bound: true, prefs: [] },
    });
    const { result } = renderHook(() =>
      useHookWorkspacePrefs(
        {
          ...BASE_HOOK,
          status: 'error',
          lastError: 'offline',
          serverMultiTeam: false,
          bindings: [
            {
              teamId: 'T1',
              teamName: 'acme',
              slackUserId: 'U1',
              slackUserName: 'dash',
              displaced: false,
            },
          ],
        },
        'slack',
      ),
    );
    await waitFor(() => expect(result.current.editable).toBe(true));
    expect(result.current.selectedTeamId).toBe('T1');
    act(() => {
      result.current.applyPatch('cindy', { model: 'claude-opus-4-8' });
    });
    await waitFor(() =>
      expect(window.electronAPI.hookControl.setWorkspacePrefs).toHaveBeenCalledWith(
        'cindy',
        { model: 'claude-opus-4-8' },
        'T1',
      ),
    );
  });

  it('Telegram 换绑时立即隔离旧偏好，直到新 binding 的快照返回', async () => {
    let resolveBinding2!: (value: {
      prefs: {
        provider: 'telegram';
        bindingId: string;
        scopeId: null;
        bound: boolean;
        prefs: [];
      };
    }) => void;
    const binding2Response = new Promise<{
      prefs: {
        provider: 'telegram';
        bindingId: string;
        scopeId: null;
        bound: boolean;
        prefs: [];
      };
    }>((resolve) => {
      resolveBinding2 = resolve;
    });
    getProviderWorkspacePrefs
      .mockResolvedValueOnce({
        prefs: {
          provider: 'telegram',
          bindingId: 'binding-1',
          scopeId: null,
          bound: true,
          prefs: [],
        },
      })
      .mockReturnValueOnce(binding2Response);

    const { result, rerender } = renderHook(({ hook }) => useHookWorkspacePrefs(hook, 'telegram'), {
      initialProps: { hook: TELEGRAM_CONFIRMED },
    });
    await waitFor(() => expect(result.current.editable).toBe(true));

    rerender({ hook: TELEGRAM_REBOUND });
    expect(result.current.editable).toBe(false);
    await waitFor(() => expect(getProviderWorkspacePrefs).toHaveBeenCalledTimes(2));

    resolveBinding2({
      prefs: {
        provider: 'telegram',
        bindingId: 'binding-2',
        scopeId: null,
        bound: true,
        prefs: [],
      },
    });
    await waitFor(() => expect(result.current.editable).toBe(true));
  });

  it('较晚返回的写入响应不会覆盖较新的 provider 推送', async () => {
    const staleResponse = {
      prefs: {
        provider: 'telegram' as const,
        bindingId: 'binding-1',
        scopeId: null,
        bound: true,
        prefs: [
          {
            workspace: 'cindy',
            model: 'stale-model',
            effort: null,
            agentKind: null,
            permissionMode: null,
          },
        ],
      },
    };
    let resolveMutation!: (value: typeof staleResponse) => void;
    const mutationResponse = new Promise<typeof staleResponse>((resolve) => {
      resolveMutation = resolve;
    });
    let pushProviderPrefs!: (view: typeof staleResponse.prefs) => void;
    vi.mocked(window.electronAPI.hookControl.setProviderWorkspacePrefs).mockReturnValue(
      mutationResponse,
    );
    vi.mocked(window.electronAPI.hookControl.onProviderPrefsChanged).mockImplementation(
      (listener) => {
        pushProviderPrefs = listener;
        return () => {};
      },
    );

    const { result } = renderHook(() => useHookWorkspacePrefs(TELEGRAM_CONFIRMED, 'telegram'));
    await waitFor(() => expect(result.current.editable).toBe(true));

    act(() => {
      result.current.applyPatch('cindy', { model: 'stale-model' });
    });
    await waitFor(() =>
      expect(window.electronAPI.hookControl.setProviderWorkspacePrefs).toHaveBeenCalledOnce(),
    );

    act(() => {
      pushProviderPrefs({
        ...staleResponse.prefs,
        prefs: [
          {
            workspace: 'cindy',
            model: 'pushed-model',
            effort: null,
            agentKind: null,
            permissionMode: null,
          },
        ],
      });
    });
    expect(result.current.prefsFor('cindy').model).toBe('pushed-model');

    await act(async () => {
      resolveMutation(staleResponse);
      await mutationResponse;
    });
    expect(result.current.prefsFor('cindy').model).toBe('pushed-model');
    expect(result.current.pendingWs).toBeNull();
  });

  it('X 绑定确认后按 provider=x 拉取偏好，跨 provider 或跨 binding 的推送不落进 X', async () => {
    getProviderWorkspacePrefs.mockResolvedValue({
      prefs: { provider: 'x', bindingId: 'x-binding-1', scopeId: null, bound: true, prefs: [] },
    });
    let pushProviderPrefs!: (view: ProviderPrefsView) => void;
    vi.mocked(window.electronAPI.hookControl.onProviderPrefsChanged).mockImplementation(
      (listener) => {
        pushProviderPrefs = listener;
        return () => {};
      },
    );

    const { result } = renderHook(() => useHookWorkspacePrefs(X_CONFIRMED, 'x'));
    await waitFor(() => expect(getProviderWorkspacePrefs).toHaveBeenCalledWith('x'));
    await waitFor(() => expect(result.current.editable).toBe(true));
    expect(getWorkspacePrefs).not.toHaveBeenCalled();

    const entry = (model: string) => [
      { workspace: 'cindy', model, effort: null, agentKind: null, permissionMode: null },
    ];
    // 同 bindingId 但 provider=telegram: 订阅层按 provider 过滤, 不得写进 X 线。
    act(() => {
      pushProviderPrefs({
        provider: 'telegram',
        bindingId: 'x-binding-1',
        scopeId: null,
        bound: true,
        prefs: entry('telegram-model'),
      });
    });
    expect(result.current.prefsFor('cindy').model).toBeNull();
    // provider=x 但 bindingId 不匹配: applyIncoming 按 binding 围栏丢弃。
    act(() => {
      pushProviderPrefs({
        provider: 'x',
        bindingId: 'x-binding-2',
        scopeId: null,
        bound: true,
        prefs: entry('other-binding-model'),
      });
    });
    expect(result.current.prefsFor('cindy').model).toBeNull();
    // 完全匹配的 X 推送正常生效。
    act(() => {
      pushProviderPrefs({
        provider: 'x',
        bindingId: 'x-binding-1',
        scopeId: null,
        bound: true,
        prefs: entry('x-model'),
      });
    });
    expect(result.current.prefsFor('cindy').model).toBe('x-model');
  });
});
