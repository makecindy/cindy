// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SlackHookView } from '../../../../shared/hookControlIpc';

const ipc = vi.hoisted(() => ({
  get: vi.fn(),
  onStatusChanged: vi.fn<(listener: (view: SlackHookView) => void) => () => void>(() => () => {}),
  setEnabled: vi.fn(),
  setLifecycleAnnouncement: vi.fn(),
  providerBindStart: vi.fn(),
  providerBindCancel: vi.fn(),
  providerBindRevoke: vi.fn(),
  cancelPendingBind: vi.fn(),
  revokeTeam: vi.fn(),
  openProviderAction: vi.fn(),
  openExternal: vi.fn(),
  setXDefaultWorkspace: vi.fn(),
}));
const dialog = vi.hoisted(() => ({ confirm: vi.fn() }));
const workspacePrefsEditor = vi.hoisted(() => ({ render: vi.fn() }));
const toast = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: dialog.confirm }),
}));

vi.mock('@/lib/toast', () => ({
  toast,
}));

vi.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    disabled,
    onCheckedChange,
    'aria-label': ariaLabel,
  }: {
    checked: boolean;
    disabled?: boolean;
    onCheckedChange: (checked: boolean) => void;
    'aria-label'?: string;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
}));

vi.mock('../HookWorkspacePrefsEditor', () => ({
  useHookWorkspacePrefs: () => ({
    prefsFor: vi.fn(),
    providerSourceFor: vi.fn(() => null),
    applyProviderSource: vi.fn(),
    editable: false,
    pendingWs: null,
    hint: null,
    retry: null,
    imDefaults: null,
    applyPatch: vi.fn(),
    teams: [],
    selectedTeamId: null,
    selectTeam: vi.fn(),
    showTeamChip: false,
  }),
  WorkspacePrefsEditor: (props: { alias: string; maxVisibleModelRows?: number }) => {
    workspacePrefsEditor.render(props);
    return null;
  },
}));

vi.mock('../ImDefaultSettingsSection', () => ({
  ImDefaultSettingsSection: ({ channel }: { channel?: string }) => (
    <div data-testid={`im-defaults-${channel ?? 'global'}`} />
  ),
}));

vi.mock('../TelegramBehaviorSettings', () => ({
  TelegramBehaviorSettings: ({ bindingId }: { bindingId?: string }) => (
    <div data-testid="telegram-behavior" data-binding-id={bindingId} />
  ),
  TelegramGroupActivationSettings: ({ bindingId }: { bindingId?: string }) => (
    <div data-testid="telegram-groups" data-binding-id={bindingId} />
  ),
}));

import { deriveAlias, HookConnectionsSection, workspaceRowsToMap } from '../HookConnectionsSection';
import { resetXUsageNoticeMemoryState } from '@/state/xUsageNotice';

/** 渠道卡收起时内容卸载(Collapse), 交互前先点开对应卡的头部行。 */
async function expandChannelCard(titleKey: RegExp) {
  fireEvent.click(await screen.findByRole('button', { name: titleKey }));
}
const SLACK_CARD = /settings\.tina\.prefs\.providerSlack/;
const TELEGRAM_CARD = /settings\.tina\.prefs\.providerTelegram/;
const X_CARD = /settings\.tina\.prefs\.providerX/;

const BASE_HOOK: SlackHookView = {
  enabled: false,
  lifecycleAnnouncement: false,
  url: 'wss://im.example.test',
  workspaces: {},
  status: 'disabled',
  lastError: null,
  binding: null,
  bindings: [],
  pendingBind: null,
  serverMultiTeam: false,
  telegram: {
    enabled: true,
    url: 'wss://telegram-hook.example.test',
    status: 'connected',
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

// 原名 'HookConnectionsSection Telegram binding actions' —— 本 suite 现在同时覆盖
// Telegram 绑定动作与 X 的用法告知/确认门, 名字得跟上, 否则失败用例的定位会误导人。
describe('HookConnectionsSection binding actions (Telegram / X)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // X 用法确认门按 principalId 记账在 localStorage 里, 而 jsdom 的 localStorage
    // 跨用例保留 —— 不清就会被前一条用例的记账吃掉, 后面的用例白绿。
    localStorage.clear();
    resetXUsageNoticeMemoryState();
    ipc.onStatusChanged.mockReturnValue(() => {});
    ipc.setEnabled.mockResolvedValue({ hook: BASE_HOOK });
    ipc.setLifecycleAnnouncement.mockResolvedValue({ hook: BASE_HOOK });
    ipc.providerBindRevoke.mockResolvedValue({ hook: BASE_HOOK });
    ipc.revokeTeam.mockResolvedValue({ hook: BASE_HOOK });
    ipc.openProviderAction.mockResolvedValue(undefined);
    dialog.confirm.mockResolvedValue(true);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      hookControl: {
        get: ipc.get,
        onStatusChanged: ipc.onStatusChanged,
        setEnabled: ipc.setEnabled,
        setLifecycleAnnouncement: ipc.setLifecycleAnnouncement,
        providerBindStart: ipc.providerBindStart,
        providerBindCancel: ipc.providerBindCancel,
        providerBindRevoke: ipc.providerBindRevoke,
        cancelPendingBind: ipc.cancelPendingBind,
        revokeTeam: ipc.revokeTeam,
        openProviderAction: ipc.openProviderAction,
        setXDefaultWorkspace: ipc.setXDefaultWorkspace,
      },
      openExternal: ipc.openExternal,
    };
  });

  afterEach(() => cleanup());

  it('never derives prototype or built-in chat aliases from a selected folder', () => {
    expect(deriveAlias('/tmp/chat', new Set())).toBe('chat-2');
    expect(deriveAlias('/tmp/__proto__', new Set())).toBe('__proto__-2');
    expect(deriveAlias('/tmp/prototype', new Set())).toBe('prototype-2');
    expect(deriveAlias('/tmp/constructor', new Set(['constructor-2']))).toBe('constructor-3');
  });

  it('rejects a partial workspace save for reserved or duplicate aliases', () => {
    expect(
      workspaceRowsToMap([
        { alias: 'safe', dir: '/tmp/safe' },
        { alias: '__proto__', dir: '/tmp/hidden' },
      ]),
    ).toBeNull();
    expect(
      workspaceRowsToMap([
        { alias: 'same', dir: '/tmp/one' },
        { alias: ' same ', dir: '/tmp/two' },
      ]),
    ).toBeNull();
    expect(workspaceRowsToMap([{ alias: ' repo ', dir: ' /tmp/repo ' }])).toEqual({
      repo: '/tmp/repo',
    });
  });

  it('limits only the Slack built-in chat model list to six visible rows', async () => {
    ipc.get.mockResolvedValue({
      hook: {
        ...BASE_HOOK,
        enabled: true,
        status: 'connected',
      },
    });

    render(<HookConnectionsSection />);
    await expandChannelCard(SLACK_CARD);
    await waitFor(() =>
      expect(workspacePrefsEditor.render).toHaveBeenCalledWith(
        expect.objectContaining({ alias: 'chat', maxVisibleModelRows: 6 }),
      ),
    );

    workspacePrefsEditor.render.mockClear();
    await expandChannelCard(TELEGRAM_CARD);
    await waitFor(() => expect(workspacePrefsEditor.render).toHaveBeenCalled());
    expect(workspacePrefsEditor.render).toHaveBeenCalledWith(
      expect.objectContaining({ alias: 'chat', maxVisibleModelRows: undefined }),
    );
  });

  it('shows the lifecycle notification switch only after Slack is bound and persists changes', async () => {
    const boundHook: SlackHookView = {
      ...BASE_HOOK,
      enabled: true,
      status: 'connected',
      binding: {
        state: 'confirmed',
        slackUserId: 'U1',
        slackUserName: 'alice',
        message: null,
        authorizeUrl: null,
        reason: null,
        installUrl: null,
        teamName: 'Acme',
      },
    };
    ipc.get.mockResolvedValue({ hook: boundHook });
    ipc.setLifecycleAnnouncement.mockResolvedValue({
      hook: { ...boundHook, lifecycleAnnouncement: true },
    });

    render(<HookConnectionsSection />);
    await expandChannelCard(SLACK_CARD);

    fireEvent.click(
      await screen.findByRole('switch', {
        name: 'settings.remoteControl.hook.lifecycleAnnouncement.label',
      }),
    );

    await waitFor(() => expect(ipc.setLifecycleAnnouncement).toHaveBeenCalledWith(true));
  });

  it('uses a localized fallback when persisting the lifecycle preference fails', async () => {
    const boundHook: SlackHookView = {
      ...BASE_HOOK,
      enabled: true,
      status: 'connected',
      binding: {
        state: 'confirmed',
        slackUserId: 'U1',
        slackUserName: 'alice',
        message: null,
        authorizeUrl: null,
        reason: null,
        installUrl: null,
        teamName: 'Acme',
      },
    };
    ipc.get.mockResolvedValue({ hook: boundHook });
    ipc.setLifecycleAnnouncement.mockRejectedValue(
      new Error('[INTERNAL] failed to persist Slack lifecycle notification preference'),
    );

    render(<HookConnectionsSection />);
    await expandChannelCard(SLACK_CARD);
    fireEvent.click(
      await screen.findByRole('switch', {
        name: 'settings.remoteControl.hook.lifecycleAnnouncement.label',
      }),
    );

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('settings.remoteControl.hook.toast.actionFailed'),
    );
  });

  it('offers an explicit link action when Telegram is enabled but unbound', async () => {
    ipc.get.mockResolvedValue({ hook: BASE_HOOK });
    ipc.providerBindStart.mockResolvedValue({ hook: BASE_HOOK });

    render(<HookConnectionsSection />);
    await expandChannelCard(TELEGRAM_CARD);

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'settings.remoteControl.hook.telegram.connect',
      }),
    );

    await waitFor(() => expect(ipc.providerBindStart).toHaveBeenCalledOnce());
  });

  it('keeps the deep-link actions visible while Telegram binding is pending', async () => {
    const hook: SlackHookView = {
      ...BASE_HOOK,
      telegram: {
        ...BASE_HOOK.telegram,
        binding: {
          provider: 'telegram',
          state: 'pending',
          attemptId: 'attempt-1',
          bindingId: null,
          principalId: 'telegram-user-1',
          principalName: 'Cindy User',
          scopeId: 'bot-1',
          scopeName: 'cindy_example_bot',
          connectUrl: 'https://t.me/cindy_example_bot?start=one-time-token',
          expiresAt: Date.now() + 60_000,
          reason: null,
          remediationUrl: null,
          actions: ['open_connect_url', 'copy_connect_url', 'cancel'],
        },
      },
    };
    ipc.get.mockResolvedValue({ hook });

    render(<HookConnectionsSection />);
    await expandChannelCard(TELEGRAM_CARD);

    const openButton = await screen.findByRole('button', {
      name: 'settings.remoteControl.hook.telegram.openApp',
    });
    expect(
      screen.getByRole('button', { name: 'settings.remoteControl.hook.binding.copyLink' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'settings.remoteControl.hook.telegram.cancel' }),
    ).toBeTruthy();

    fireEvent.click(openButton);
    await waitFor(() => expect(ipc.openProviderAction).toHaveBeenCalledWith('telegram', 'connect'));
  });

  it('hides the X card entirely while the endpoint manifest leaves xHookWsUrl empty', async () => {
    // BASE_HOOK 的 x.url 为空且未启用/不可用 —— 端点清单缺失即灰度关闭,
    // 设置页不得出现 X 入口(providerCardState.visible 语义)。
    // 这一条必须用空 url 的 BASE_HOOK 本体, 不能换成 xUnboundHook()。
    ipc.get.mockResolvedValue({ hook: BASE_HOOK });

    render(<HookConnectionsSection />);
    await screen.findByRole('button', { name: TELEGRAM_CARD });

    expect(screen.queryByRole('button', { name: X_CARD })).toBeNull();
  });

  it('keeps the OAuth deep-link actions visible while X binding is pending', async () => {
    const hook: SlackHookView = {
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
          state: 'pending',
          attemptId: 'attempt-x1',
          bindingId: null,
          principalId: null,
          principalName: null,
          scopeId: 'bot-x',
          scopeName: 'CindyBot',
          connectUrl:
            'https://x.com/i/oauth2/authorize?response_type=code&client_id=c1&redirect_uri=r&scope=s&state=st&code_challenge=cc&code_challenge_method=S256',
          expiresAt: Date.now() + 60_000,
          reason: null,
          remediationUrl: null,
          actions: ['open_connect_url', 'copy_connect_url', 'cancel'],
        },
      },
    };
    ipc.get.mockResolvedValue({ hook });

    render(<HookConnectionsSection />);
    await expandChannelCard(X_CARD);

    const openButton = await screen.findByRole('button', {
      name: 'settings.remoteControl.hook.x.openApp',
    });
    expect(
      screen.getByRole('button', { name: 'settings.remoteControl.hook.binding.copyLink' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'settings.remoteControl.hook.x.cancel' }),
    ).toBeTruthy();

    fireEvent.click(openButton);
    await waitFor(() => expect(ipc.openProviderAction).toHaveBeenCalledWith('x', 'connect'));
  });

  it('renders confirmed X actions from the wire action list and never a group action', async () => {
    const hook: SlackHookView = {
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
          actions: ['open_provider', 'revoke'],
        },
      },
    };
    ipc.get.mockResolvedValue({ hook });

    render(<HookConnectionsSection />);
    await expandChannelCard(X_CARD);

    fireEvent.click(
      await screen.findByRole('button', { name: 'settings.remoteControl.hook.x.openBot' }),
    );
    await waitFor(() => expect(ipc.openProviderAction).toHaveBeenCalledWith('x', 'provider'));

    // X 无群概念: server 不会下发 add_to_group, 按钮为数据驱动, 不得凭空渲染。
    expect(
      screen.queryByRole('button', { name: 'settings.remoteControl.hook.x.addToGroup' }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: 'settings.remoteControl.hook.x.unlink' }),
    ).toBeTruthy();
  });

  it('uses the latest Slack install URL after an async confirmation', async () => {
    let pushStatus: ((view: SlackHookView) => void) | undefined;
    let resolveConfirm: ((value: boolean) => void) | undefined;
    dialog.confirm.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveConfirm = resolve;
      }),
    );
    ipc.onStatusChanged.mockImplementation((listener: (view: SlackHookView) => void) => {
      pushStatus = listener;
      return () => {};
    });
    const awaitingInstall = (installUrl: string): SlackHookView => ({
      ...BASE_HOOK,
      enabled: true,
      status: 'connected',
      binding: {
        state: 'failed',
        slackUserId: null,
        slackUserName: null,
        message: 'not installed',
        authorizeUrl: null,
        reason: 'not-installed',
        installUrl,
        teamName: null,
      },
    });
    ipc.get.mockResolvedValue({
      hook: awaitingInstall('https://hook.example.test/slack/install?team=OLD'),
    });

    render(<HookConnectionsSection />);
    await waitFor(() => expect(dialog.confirm).toHaveBeenCalledOnce());
    act(() => {
      pushStatus?.(awaitingInstall('https://hook.example.test/slack/install?team=NEW'));
    });
    await act(async () => {
      resolveConfirm?.(true);
      await Promise.resolve();
    });

    expect(ipc.openExternal).toHaveBeenCalledWith(
      'https://hook.example.test/slack/install?team=NEW',
    );
  });

  it('does not apply an old install confirmation to another Slack target', async () => {
    let pushStatus: ((view: SlackHookView) => void) | undefined;
    let resolveConfirm: ((value: boolean) => void) | undefined;
    dialog.confirm.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveConfirm = resolve;
      }),
    );
    ipc.onStatusChanged.mockImplementation((listener: (view: SlackHookView) => void) => {
      pushStatus = listener;
      return () => {};
    });
    const awaitingInstall = (teamId: string): SlackHookView => ({
      ...BASE_HOOK,
      enabled: true,
      status: 'connected',
      serverMultiTeam: true,
      pendingBind: {
        state: 'failed',
        message: 'not installed',
        authorizeUrl: null,
        reason: 'not-installed',
        installUrl: `https://hook.example.test/slack/install?team=${teamId}`,
        teamId,
      },
      binding: {
        state: 'failed',
        slackUserId: null,
        slackUserName: null,
        message: 'not installed',
        authorizeUrl: null,
        reason: 'not-installed',
        installUrl: `https://hook.example.test/slack/install?team=${teamId}`,
        teamName: null,
      },
    });
    ipc.get.mockResolvedValue({ hook: awaitingInstall('TEAM_A') });

    render(<HookConnectionsSection />);
    await waitFor(() => expect(dialog.confirm).toHaveBeenCalledOnce());
    act(() => {
      pushStatus?.(awaitingInstall('TEAM_B'));
    });
    await act(async () => {
      resolveConfirm?.(true);
      await Promise.resolve();
    });

    expect(ipc.openExternal).not.toHaveBeenCalled();
  });

  it('invalidates an old install confirmation when the same Slack target is retried', async () => {
    let pushStatus: ((view: SlackHookView) => void) | undefined;
    const confirmResolvers: Array<(value: boolean) => void> = [];
    dialog.confirm.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          confirmResolvers.push(resolve);
        }),
    );
    ipc.onStatusChanged.mockImplementation((listener: (view: SlackHookView) => void) => {
      pushStatus = listener;
      return () => {};
    });
    const awaitingInstall: SlackHookView = {
      ...BASE_HOOK,
      enabled: true,
      status: 'connected',
      serverMultiTeam: true,
      pendingBind: {
        state: 'failed',
        message: 'not installed',
        authorizeUrl: null,
        reason: 'not-installed',
        installUrl: 'https://hook.example.test/slack/install?team=TEAM_A',
        teamId: 'TEAM_A',
      },
      binding: {
        state: 'failed',
        slackUserId: null,
        slackUserName: null,
        message: 'not installed',
        authorizeUrl: null,
        reason: 'not-installed',
        installUrl: 'https://hook.example.test/slack/install?team=TEAM_A',
        teamName: null,
      },
    };
    ipc.get.mockResolvedValue({ hook: awaitingInstall });

    render(<HookConnectionsSection />);
    await waitFor(() => expect(dialog.confirm).toHaveBeenCalledOnce());
    await act(async () => {
      pushStatus?.({ ...BASE_HOOK, enabled: true, status: 'connected' });
      await Promise.resolve();
    });
    act(() => {
      pushStatus?.(awaitingInstall);
    });
    await waitFor(() => expect(dialog.confirm).toHaveBeenCalledTimes(2));

    await act(async () => {
      confirmResolvers[0]?.(true);
      await Promise.resolve();
    });
    expect(ipc.openExternal).not.toHaveBeenCalled();

    await act(async () => {
      confirmResolvers[1]?.(true);
      await Promise.resolve();
    });
    expect(ipc.openExternal).toHaveBeenCalledOnce();
  });

  it('shows the actionable Telegram transport error instead of only a generic failure', async () => {
    ipc.get.mockResolvedValue({
      hook: {
        ...BASE_HOOK,
        telegram: {
          ...BASE_HOOK.telegram,
          status: 'error',
          lastError: 'Unexpected server response: 503',
        },
      },
    });

    render(<HookConnectionsSection />);
    await expandChannelCard(TELEGRAM_CARD);

    expect(await screen.findByText('Unexpected server response: 503')).toBeTruthy();
  });

  it('does not let a delayed initial snapshot overwrite a newer pushed binding state', async () => {
    let resolveGet: ((value: { hook: SlackHookView }) => void) | undefined;
    let pushStatus: ((view: SlackHookView) => void) | undefined;
    ipc.get.mockReturnValue(
      new Promise<{ hook: SlackHookView }>((resolve) => {
        resolveGet = resolve;
      }),
    );
    ipc.onStatusChanged.mockImplementation((listener: (view: SlackHookView) => void) => {
      pushStatus = listener;
      return () => {};
    });

    render(<HookConnectionsSection />);
    await waitFor(() => expect(pushStatus).toBeTypeOf('function'));
    act(() => {
      pushStatus?.({
        ...BASE_HOOK,
        telegram: {
          ...BASE_HOOK.telegram,
          binding: {
            provider: 'telegram',
            state: 'awaiting_confirmation',
            attemptId: 'attempt-new',
            bindingId: null,
            principalId: 'telegram-user-1',
            principalName: 'Cindy User',
            scopeId: 'bot-1',
            scopeName: 'cindy_example_bot',
            connectUrl: 'https://t.me/cindy_example_bot?start=one-time-token',
            expiresAt: Date.now() + 60_000,
            reason: null,
            remediationUrl: null,
            actions: ['open_connect_url', 'copy_connect_url', 'cancel'],
          },
        },
      });
    });
    await expandChannelCard(TELEGRAM_CARD);
    expect(
      await screen.findByRole('button', {
        name: 'settings.remoteControl.hook.telegram.cancel',
      }),
    ).toBeTruthy();

    await act(async () => {
      resolveGet?.({ hook: BASE_HOOK });
      await Promise.resolve();
    });
    expect(
      screen.queryByRole('button', {
        name: 'settings.remoteControl.hook.telegram.connect',
      }),
    ).toBeNull();
    expect(
      screen.getByRole('button', {
        name: 'settings.remoteControl.hook.telegram.cancel',
      }),
    ).toBeTruthy();
  });

  it('does not let an older action reply overwrite a newer local action reply', async () => {
    let resolveFirst: ((value: { hook: SlackHookView }) => void) | undefined;
    let resolveSecond: ((value: { hook: SlackHookView }) => void) | undefined;
    ipc.get.mockResolvedValue({ hook: BASE_HOOK });
    ipc.providerBindStart
      .mockReturnValueOnce(
        new Promise<{ hook: SlackHookView }>((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise<{ hook: SlackHookView }>((resolve) => {
          resolveSecond = resolve;
        }),
      );

    render(<HookConnectionsSection />);
    await expandChannelCard(TELEGRAM_CARD);
    const connect = await screen.findByRole('button', {
      name: 'settings.remoteControl.hook.telegram.connect',
    });
    fireEvent.click(connect);
    fireEvent.click(connect);
    expect(ipc.providerBindStart).toHaveBeenCalledTimes(2);

    const pendingHook: SlackHookView = {
      ...BASE_HOOK,
      telegram: {
        ...BASE_HOOK.telegram,
        binding: {
          provider: 'telegram',
          state: 'pending',
          attemptId: 'attempt-new',
          bindingId: null,
          principalId: null,
          principalName: null,
          scopeId: 'bot-1',
          scopeName: 'cindy_example_bot',
          connectUrl: 'https://t.me/cindy_example_bot?start=one-time-token',
          expiresAt: Date.now() + 60_000,
          reason: null,
          remediationUrl: null,
          actions: ['open_connect_url', 'copy_connect_url', 'cancel'],
        },
      },
    };
    await act(async () => {
      resolveSecond?.({ hook: pendingHook });
      await Promise.resolve();
    });
    expect(
      await screen.findByRole('button', {
        name: 'settings.remoteControl.hook.telegram.cancel',
      }),
    ).toBeTruthy();

    await act(async () => {
      resolveFirst?.({ hook: BASE_HOOK });
      await Promise.resolve();
    });
    expect(
      screen.queryByRole('button', {
        name: 'settings.remoteControl.hook.telegram.connect',
      }),
    ).toBeNull();
    expect(
      screen.getByRole('button', {
        name: 'settings.remoteControl.hook.telegram.cancel',
      }),
    ).toBeTruthy();
  });

  it('does not unlink a replacement Telegram binding from a stale confirmation', async () => {
    let pushStatus: ((view: SlackHookView) => void) | undefined;
    let resolveConfirm: ((value: boolean) => void) | undefined;
    dialog.confirm.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveConfirm = resolve;
      }),
    );
    ipc.onStatusChanged.mockImplementation((listener: (view: SlackHookView) => void) => {
      pushStatus = listener;
      return () => {};
    });
    const confirmed = (bindingId: string): SlackHookView => ({
      ...BASE_HOOK,
      telegram: {
        ...BASE_HOOK.telegram,
        binding: {
          provider: 'telegram',
          state: 'confirmed',
          attemptId: null,
          bindingId,
          principalId: `user-${bindingId}`,
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
    });
    ipc.get.mockResolvedValue({ hook: confirmed('binding-1') });

    render(<HookConnectionsSection />);
    await expandChannelCard(TELEGRAM_CARD);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'settings.remoteControl.hook.telegram.unlink',
      }),
    );
    await waitFor(() => expect(dialog.confirm).toHaveBeenCalledOnce());

    act(() => {
      pushStatus?.(confirmed('binding-2'));
    });
    await act(async () => {
      resolveConfirm?.(true);
      await Promise.resolve();
    });

    expect(ipc.providerBindRevoke).not.toHaveBeenCalled();
  });

  it('shows global official Telegram defaults, behavior, and group settings only after linking', async () => {
    ipc.get.mockResolvedValue({
      hook: {
        ...BASE_HOOK,
        telegram: {
          ...BASE_HOOK.telegram,
          behaviorAvailable: true,
          binding: {
            provider: 'telegram',
            state: 'confirmed',
            attemptId: null,
            bindingId: 'binding-settings',
            principalId: '12345',
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
      },
    });

    render(<HookConnectionsSection />);
    await expandChannelCard(TELEGRAM_CARD);
    expect(await screen.findByTestId('im-defaults-global')).toBeTruthy();
    expect(screen.getByTestId('telegram-behavior').getAttribute('data-binding-id')).toBe(
      'binding-settings',
    );
    expect(screen.getByTestId('telegram-groups').getAttribute('data-binding-id')).toBe(
      'binding-settings',
    );
  });

  it('keeps local Telegram defaults visible when the linked server lacks behavior capability', async () => {
    ipc.get.mockResolvedValue({
      hook: {
        ...BASE_HOOK,
        telegram: {
          ...BASE_HOOK.telegram,
          behaviorAvailable: false,
          binding: {
            provider: 'telegram',
            state: 'confirmed',
            attemptId: null,
            bindingId: 'legacy-binding',
            principalId: '12345',
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
      },
    });

    render(<HookConnectionsSection />);
    await expandChannelCard(TELEGRAM_CARD);
    expect(await screen.findByTestId('im-defaults-global')).toBeTruthy();
    expect(screen.queryByTestId('telegram-behavior')).toBeNull();
    expect(screen.queryByTestId('telegram-groups')).toBeNull();
  });

  it('does not remove a changed Slack binding from a stale confirmation', async () => {
    let pushStatus: ((view: SlackHookView) => void) | undefined;
    let resolveConfirm: ((value: boolean) => void) | undefined;
    dialog.confirm.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveConfirm = resolve;
      }),
    );
    ipc.onStatusChanged.mockImplementation((listener: (view: SlackHookView) => void) => {
      pushStatus = listener;
      return () => {};
    });
    const withBinding = (displaced: boolean): SlackHookView => ({
      ...BASE_HOOK,
      enabled: true,
      status: 'connected',
      serverMultiTeam: true,
      bindings: [
        {
          teamId: 'team-1',
          teamName: 'Cindy Team',
          slackUserId: 'user-1',
          slackUserName: 'Cindy User',
          displaced,
        },
      ],
    });
    ipc.get.mockResolvedValue({ hook: withBinding(false) });

    render(<HookConnectionsSection />);
    await expandChannelCard(SLACK_CARD);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'settings.remoteControl.hook.multi.removeAria',
      }),
    );
    await waitFor(() => expect(dialog.confirm).toHaveBeenCalledOnce());

    act(() => {
      pushStatus?.(withBinding(true));
    });
    await act(async () => {
      resolveConfirm?.(true);
      await Promise.resolve();
    });

    expect(ipc.revokeTeam).not.toHaveBeenCalled();
  });

  it('默认工作目录控件只出现在 X 卡, 且展示当前生效的目录名', async () => {
    // X 一次交互只有一条公开推文, 没有目录选择面板的位置 —— 不预设就只能永远
    // 落在「对话」上、碰不到本地仓库, 所以这个入口是 X 的唯一目录来源。
    // 注: 下拉展开后的写入路径没在这里覆盖(Radix 菜单在 jsdom 下不展开, 本仓
    // 同款 team chip 也没测); 写入语义由 store 层的默认目录用例保证。
    const xView = {
      enabled: true,
      url: 'wss://x-hook.example.test',
      status: 'connected' as const,
      lastError: null,
      available: true,
      capabilityPending: false,
      defaultWorkspace: 'cindy',
      binding: null,
    };
    const hook: SlackHookView = {
      ...BASE_HOOK,
      workspaces: { cindy: '/Users/dash/Code/cindy' },
      x: xView,
      telegram: { ...xView, url: 'wss://tg-hook.example.test', defaultWorkspace: null },
    };
    ipc.get.mockResolvedValue({ hook });

    render(<HookConnectionsSection />);
    await expandChannelCard(X_CARD);
    expect(
      await screen.findByLabelText('settings.remoteControl.hook.form.defaultWorkspaceAria'),
    ).toBeTruthy();

    // Telegram 能在会话里当场选目录, 不该出现这个预设控件。
    cleanup();
    ipc.get.mockResolvedValue({ hook });
    render(<HookConnectionsSection />);
    await expandChannelCard(TELEGRAM_CARD);
    expect(
      screen.queryByLabelText('settings.remoteControl.hook.form.defaultWorkspaceAria'),
    ).toBeNull();
  });

  /**
   * 「服务端已开放端点、但用户还没打开开关」的 X 卡 —— 评估阶段的真实形态。
   *
   * 不能直接用 BASE_HOOK: 它的 x.url 是空串, 而空端点会让整张卡不渲染
   * (见上面「hides the X card entirely while the endpoint manifest leaves
   * xHookWsUrl empty」那条), 于是用法与风险小节根本没有宿主。
   */
  function xUnboundHook(): SlackHookView {
    return {
      ...BASE_HOOK,
      x: { ...BASE_HOOK.x, url: 'wss://x-hook.example.test' },
    };
  }

  /** confirmed 态的 X binding, 只有 principalId 不同(确认门按它记账)。 */
  function xConfirmedHook(principalId: string): SlackHookView {
    return {
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
          bindingId: `x-binding-${principalId}`,
          principalId,
          principalName: '@dash',
          scopeId: 'bot-x',
          scopeName: 'CindyBot',
          connectUrl: null,
          expiresAt: null,
          reason: null,
          remediationUrl: 'https://x.com/CindyBot',
          actions: ['open_provider', 'revoke'],
        },
      },
    };
  }

  it('用法与风险小节只出现在 X 卡: Telegram 是私密通道, 没有这条性质差异', async () => {
    // X 的回复是一条**公开推文**, Slack / Telegram 不是 —— 这一节的存在理由就是
    // 这个差异, 所以它不该跟着渲染进别的渠道卡。
    ipc.get.mockResolvedValue({ hook: xUnboundHook() });
    render(<HookConnectionsSection />);
    await expandChannelCard(X_CARD);
    expect(
      await screen.findByText('settings.remoteControl.hook.x.guide.riskPublicBody'),
    ).toBeTruthy();

    cleanup();
    ipc.get.mockResolvedValue({ hook: xUnboundHook() });
    render(<HookConnectionsSection />);
    await expandChannelCard(TELEGRAM_CARD);
    expect(
      screen.queryByText('settings.remoteControl.hook.x.guide.riskPublicBody'),
    ).toBeNull();
  });

  it('说明区可选可复制: 弹窗根节点带 select-none, 不覆盖就复制不了 @askmycindy', async () => {
    // 本组件也渲染进 ConfirmDialog, 而它的 Content 根节点带 select-none
    // (confirm-dialog.tsx)。DESIGN.md §14.1 的判据是「用户会不会想复制它」——
    // `@askmycindy` 与 `/delete` 是用户要**打进 X** 的字符串, 当然会
    // (#1347 review 由 codex 指出 P2)。
    ipc.get.mockResolvedValue({ hook: xUnboundHook() });
    render(<HookConnectionsSection />);
    await expandChannelCard(X_CARD);
    const body = await screen.findByText('settings.remoteControl.hook.x.guide.usageBody');
    // 三组共同的祖先就是 XUsageGuide 的根
    const root = body.closest('.select-text');
    expect(root, 'XUsageGuide 根节点必须带 select-text 覆盖弹窗的 select-none').not.toBeNull();
    expect(
      root?.textContent?.includes('settings.remoteControl.hook.x.guide.withdrawBody'),
    ).toBe(true);
  });

  it('说明区没有任何小于 12px 的字号: 这是逐句阅读的正文, 不是辅助标签', async () => {
    // DESIGN.md §3 把 Small(12px)定为 sans 的最小字号, 并对 Micro Label(10–13px)写明
    // 「Auxiliary / non-reading labels only … Never used for body text or anything the
    // user reads sentence-by-sentence」。这一节的正文既要逐句读、还要照着往 X 里打字
    // (@askmycindy / delete 命令), 是正文而非标签(#1347 review 由 codex 指出 P2)。
    //
    // 刻意钉整个子树而不是单个 className: 初版只有 GuideBody 一处踩线, 但下一处新增的
    // 说明同样会想「顺手用 text-11」—— 钉子树才拦得住第二次。
    ipc.get.mockResolvedValue({ hook: xUnboundHook() });
    render(<HookConnectionsSection />);
    await expandChannelCard(X_CARD);
    const root = (
      await screen.findByText('settings.remoteControl.hook.x.guide.usageBody')
    ).closest('.select-text');
    expect(root).not.toBeNull();

    const tooSmall: string[] = [];
    for (const el of [root!, ...Array.from(root!.querySelectorAll('*'))]) {
      for (const cls of Array.from(el.classList)) {
        // 本仓的字号既有 `text-11` 这种自定义档, 也有 `text-[11px]` 这种字面量
        const px = /^text-(\d+)$/.exec(cls)?.[1] ?? /^text-\[(\d+)px\]$/.exec(cls)?.[1];
        if (px !== undefined && Number(px) < 12) tooSmall.push(cls);
      }
    }
    expect(tooSmall, `说明区出现了小于 12px 的字号: ${tooSmall.join(', ')}`).toEqual([]);
  });

  it('三组都在场, 且「默认工作目录」那条风险必须写出来', async () => {
    // 「X 任务都落在默认工作目录、agent 能读写其中文件、结论会公开回帖」是
    // 「回帖公开」的直接后果, 也是用户判断该不该把默认目录指到工作仓库的唯一依据
    // (Dash 2026-08-02 明确要求写出来) —— 少了它这一节就等于没说清风险。
    ipc.get.mockResolvedValue({ hook: xUnboundHook() });
    render(<HookConnectionsSection />);
    await expandChannelCard(X_CARD);
    for (const key of [
      'usageLabel',
      'usageBody',
      'riskLabel',
      'riskPublicBody',
      'riskWorkdirBody',
      'withdrawLabel',
      'withdrawBody',
    ]) {
      expect(
        await screen.findByText(`settings.remoteControl.hook.x.guide.${key}`),
      ).toBeTruthy();
    }
  });

  it('X 未启用、未绑定时小节照样显示: 评估阶段最需要看到风险', async () => {
    // BASE_HOOK 的 x 是 enabled:false / available:false / binding:null。工作目录区
    // 按 view.enabled 门控, 这一节刻意不跟 —— 决定要不要打开的人才最需要读它。
    ipc.get.mockResolvedValue({ hook: xUnboundHook() });
    render(<HookConnectionsSection />);
    await expandChannelCard(X_CARD);
    expect(
      await screen.findByText('settings.remoteControl.hook.x.guide.riskWorkdirBody'),
    ).toBeTruthy();
    // 同一张卡上工作目录区确实是收起的, 证明两者门控独立
    expect(
      screen.queryByLabelText('settings.remoteControl.hook.form.defaultWorkspaceAria'),
    ).toBeNull();
  });

  it('首次绑定成功弹一次确认门: 单按钮、不可用取消绕过', async () => {
    ipc.get.mockResolvedValue({ hook: xConfirmedHook('x-user-1') });
    render(<HookConnectionsSection />);

    await waitFor(() => expect(dialog.confirm).toHaveBeenCalledTimes(1));
    expect(dialog.confirm.mock.calls[0][0]).toMatchObject({
      title: 'settings.remoteControl.hook.x.guide.ackTitle',
      confirmText: 'settings.remoteControl.hook.x.guide.ackConfirm',
      // 告知不该有「取消」这个出口 —— 它不是一个可选操作
      showCancel: false,
    });
  });

  it('点过「我明白」之后不再弹: 一次性告知, 不是每次开设置都拦', async () => {
    ipc.get.mockResolvedValue({ hook: xConfirmedHook('x-user-1') });
    render(<HookConnectionsSection />);
    await waitFor(() => expect(dialog.confirm).toHaveBeenCalledTimes(1));

    cleanup();
    dialog.confirm.mockClear();
    ipc.get.mockResolvedValue({ hook: xConfirmedHook('x-user-1') });
    render(<HookConnectionsSection />);
    await expandChannelCard(X_CARD);
    // 给 effect 一个真实的机会跑完再断言"没弹"
    await waitFor(() =>
      expect(screen.queryByText('settings.remoteControl.hook.x.guide.usageBody')).toBeTruthy(),
    );
    expect(dialog.confirm).not.toHaveBeenCalled();
  });

  it('换绑到另一个 X 账号会再确认一次: 新账号 = 新的公开面', async () => {
    ipc.get.mockResolvedValue({ hook: xConfirmedHook('x-user-1') });
    render(<HookConnectionsSection />);
    await waitFor(() => expect(dialog.confirm).toHaveBeenCalledTimes(1));

    cleanup();
    dialog.confirm.mockClear();
    ipc.get.mockResolvedValue({ hook: xConfirmedHook('x-user-2') });
    render(<HookConnectionsSection />);
    await waitFor(() => expect(dialog.confirm).toHaveBeenCalledTimes(1));
  });

  it('Esc / 点遮罩关掉不算已知晓: 下次仍然弹', async () => {
    // confirm-dialog 在 Esc / 遮罩点击时 resolve 成 cancel(ok=false)。那种情况下
    // 用户并没有读到告知, 记账就等于把风险悄悄咽掉了。
    dialog.confirm.mockResolvedValue(false);
    ipc.get.mockResolvedValue({ hook: xConfirmedHook('x-user-1') });
    render(<HookConnectionsSection />);
    await waitFor(() => expect(dialog.confirm).toHaveBeenCalledTimes(1));

    cleanup();
    dialog.confirm.mockClear();
    dialog.confirm.mockResolvedValue(true);
    ipc.get.mockResolvedValue({ hook: xConfirmedHook('x-user-1') });
    render(<HookConnectionsSection />);
    await waitFor(() => expect(dialog.confirm).toHaveBeenCalledTimes(1));
  });

  it('未绑定 / 绑定中不弹确认门: 只在转入 confirmed 那一沿', async () => {
    const pending = xConfirmedHook('x-user-1');
    ipc.get.mockResolvedValue({
      hook: {
        ...pending,
        x: {
          ...pending.x,
          binding: { ...pending.x.binding!, state: 'pending' as const },
        },
      },
    });
    render(<HookConnectionsSection />);
    await expandChannelCard(X_CARD);
    await waitFor(() =>
      expect(screen.queryByText('settings.remoteControl.hook.x.guide.usageBody')).toBeTruthy(),
    );
    expect(dialog.confirm).not.toHaveBeenCalled();
  });
});
