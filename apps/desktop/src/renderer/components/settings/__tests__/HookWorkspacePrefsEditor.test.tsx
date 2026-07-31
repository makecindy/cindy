// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SlackHookView } from '../../../../shared/hookControlIpc';

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
  const getProviderWorkspacePrefs = vi.fn(async () => ({
    prefs: {
      provider: 'telegram' as const,
      bindingId: 'binding-1',
      scopeId: null,
      bound: true,
      prefs: [],
    },
  }));
  const getWorkspacePrefs = vi.fn(async () => ({ prefs: { bound: true, prefs: [] } }));

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
});
