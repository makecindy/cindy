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
  addBinding: vi.fn(),
  rebindTeam: vi.fn(),
  cancelPendingBind: vi.fn(),
  revokeTeam: vi.fn(),
  openProviderAction: vi.fn(),
  openExternal: vi.fn(),
  setProviderDefaultWorkspace: vi.fn(),
  imDefaultSettingsGet: vi.fn(),
  imDefaultSettingsReset: vi.fn(),
}));
const dialog = vi.hoisted(() => ({ confirm: vi.fn() }));
const workspacePrefsEditor = vi.hoisted(() => ({ render: vi.fn() }));
const toast = vi.hoisted(() => ({ error: vi.fn() }));

/** t 只回键名 —— 插值参数另存一份, 让"文案带没带上正确的值"也能断言。 */
const tCalls: Array<{ key: string; vars?: Record<string, unknown> }> = [];
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      tCalls.push({ key, vars });
      return key;
    },
  }),
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

const prefsReload = vi.fn(async () => {});
vi.mock('../HookWorkspacePrefsEditor', () => ({
  useHookWorkspacePrefs: () => ({
    reloadImDefaults: prefsReload,
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
    prefsReload.mockClear();
    tCalls.length = 0;
    resetXUsageNoticeMemoryState();
    ipc.onStatusChanged.mockReturnValue(() => {});
    ipc.setEnabled.mockResolvedValue({ hook: BASE_HOOK });
    ipc.setLifecycleAnnouncement.mockResolvedValue({ hook: BASE_HOOK });
    ipc.providerBindRevoke.mockResolvedValue({ hook: BASE_HOOK });
    ipc.addBinding.mockResolvedValue({ hook: BASE_HOOK });
    ipc.rebindTeam.mockResolvedValue({ hook: BASE_HOOK });
    ipc.cancelPendingBind.mockResolvedValue({ hook: BASE_HOOK });
    ipc.revokeTeam.mockResolvedValue({ hook: BASE_HOOK });
    ipc.openProviderAction.mockResolvedValue(undefined);
    // 默认: 没有存量 global override(绝大多数设备) —— 收尾入口一次都不该露出来
    ipc.imDefaultSettingsGet.mockResolvedValue({ isCustomized: false, customizedKeys: [] });
    ipc.imDefaultSettingsReset.mockResolvedValue({ isCustomized: false, customizedKeys: [] });
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
        addBinding: ipc.addBinding,
        rebindTeam: ipc.rebindTeam,
        cancelPendingBind: ipc.cancelPendingBind,
        revokeTeam: ipc.revokeTeam,
        openProviderAction: ipc.openProviderAction,
        setProviderDefaultWorkspace: ipc.setProviderDefaultWorkspace,
      },
      maker: {
        imDefaultSettingsGet: ipc.imDefaultSettingsGet,
        imDefaultSettingsReset: ipc.imDefaultSettingsReset,
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
    await expandChannelCard(SLACK_CARD);
    expect(
      screen.queryByRole('button', {
        name: 'settings.remoteControl.hook.binding.reauthorize',
      }),
    ).toBeNull();
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
        intent: 'add',
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
        intent: 'add',
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

  it('offers a direct Slack reauthorization action after single-workspace authorization is denied', async () => {
    ipc.get.mockResolvedValue({
      hook: {
        ...BASE_HOOK,
        status: 'connected',
        binding: {
          state: 'denied',
          slackUserId: null,
          slackUserName: null,
          message: 'server-specific cancellation text',
          authorizeUrl: null,
          reason: null,
          installUrl: null,
          teamName: null,
        },
      },
    });

    render(<HookConnectionsSection />);
    await expandChannelCard(SLACK_CARD);
    expect(
      await screen.findByText('settings.remoteControl.hook.binding.state.denied'),
    ).toBeTruthy();
    expect(screen.queryByText('server-specific cancellation text')).toBeNull();
    expect(tCalls).toContainEqual({
      key: 'settings.remoteControl.hook.transportStatus',
      vars: { status: 'settings.remoteControl.hook.status.connected' },
    });
    expect(tCalls).toContainEqual({
      key: 'settings.remoteControl.hook.accountStatus',
      vars: { status: 'settings.remoteControl.hook.statusUnbound' },
    });
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'settings.remoteControl.hook.binding.reauthorize',
      }),
    );

    await waitFor(() => expect(ipc.setEnabled).toHaveBeenCalledWith(true));
    expect(ipc.addBinding).not.toHaveBeenCalled();
  });

  it('keeps the confirmed Slack account visible while the transport reconnects', async () => {
    ipc.get.mockResolvedValue({
      hook: {
        ...BASE_HOOK,
        enabled: true,
        status: 'connecting',
        binding: {
          state: 'confirmed',
          slackUserId: 'USER_BOUND',
          slackUserName: 'bound-user',
          message: null,
          authorizeUrl: null,
          reason: null,
          installUrl: null,
          teamName: 'Bound workspace',
        },
      },
    });

    render(<HookConnectionsSection />);
    await waitFor(() =>
      expect(tCalls).toContainEqual({
        key: 'settings.remoteControl.hook.accountStatus',
        vars: { status: 'settings.remoteControl.hook.statusBoundTeam' },
      }),
    );
    expect(tCalls).toContainEqual({
      key: 'settings.remoteControl.hook.transportStatus',
      vars: { status: 'settings.remoteControl.hook.status.connecting' },
    });
  });

  it('keeps active Slack workspaces visible while the multi-workspace transport is offline', async () => {
    ipc.get.mockResolvedValue({
      hook: {
        ...BASE_HOOK,
        enabled: true,
        status: 'error',
        lastError: 'network unavailable',
        serverMultiTeam: true,
        bindings: [
          {
            teamId: 'TEAM_BOUND',
            teamName: 'Bound workspace',
            slackUserId: 'USER_BOUND',
            slackUserName: 'bound-user',
            displaced: false,
          },
        ],
      },
    });

    render(<HookConnectionsSection />);
    await waitFor(() =>
      expect(tCalls).toContainEqual({
        key: 'settings.remoteControl.hook.accountStatus',
        vars: { status: 'settings.remoteControl.hook.statusBoundTeam' },
      }),
    );
    expect(tCalls).toContainEqual({
      key: 'settings.remoteControl.hook.transportStatus',
      vars: { status: 'settings.remoteControl.hook.status.error' },
    });
  });

  it('allows only one Slack reauthorization request while the action is in flight', async () => {
    let resolveEnable: ((value: { hook: SlackHookView }) => void) | undefined;
    ipc.setEnabled.mockReturnValue(
      new Promise<{ hook: SlackHookView }>((resolve) => {
        resolveEnable = resolve;
      }),
    );
    ipc.get.mockResolvedValue({
      hook: {
        ...BASE_HOOK,
        status: 'connected',
        binding: {
          state: 'expired',
          slackUserId: null,
          slackUserName: null,
          message: null,
          authorizeUrl: null,
          reason: null,
          installUrl: null,
          teamName: null,
        },
      },
    });

    render(<HookConnectionsSection />);
    await expandChannelCard(SLACK_CARD);
    const button = await screen.findByRole('button', {
      name: 'settings.remoteControl.hook.binding.reauthorize',
    });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(ipc.setEnabled).toHaveBeenCalledTimes(1);
    expect(button).toHaveProperty('disabled', true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    // The button is disabled while the action is in flight, so it must not be focusable.
    button.focus();
    expect(document.activeElement).not.toBe(button);
    await act(async () => {
      resolveEnable?.({ hook: BASE_HOOK });
      await Promise.resolve();
    });
  });

  it('does not let a stale reauthorization reply replace a newer Slack push', async () => {
    let pushStatus: ((view: SlackHookView) => void) | undefined;
    let resolveEnable: ((value: { hook: SlackHookView }) => void) | undefined;
    const deniedHook: SlackHookView = {
      ...BASE_HOOK,
      status: 'connected',
      binding: {
        state: 'denied',
        slackUserId: null,
        slackUserName: null,
        message: null,
        authorizeUrl: null,
        reason: null,
        installUrl: null,
        teamName: null,
      },
    };
    ipc.get.mockResolvedValue({ hook: deniedHook });
    ipc.setEnabled.mockReturnValue(
      new Promise<{ hook: SlackHookView }>((resolve) => {
        resolveEnable = resolve;
      }),
    );
    ipc.onStatusChanged.mockImplementation((listener: (view: SlackHookView) => void) => {
      pushStatus = listener;
      return () => {};
    });

    render(<HookConnectionsSection />);
    await expandChannelCard(SLACK_CARD);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'settings.remoteControl.hook.binding.reauthorize',
      }),
    );
    act(() => {
      pushStatus?.({
        ...BASE_HOOK,
        enabled: true,
        status: 'connected',
        binding: {
          state: 'confirmed',
          slackUserId: 'USER_NEW',
          slackUserName: 'new-user',
          message: null,
          authorizeUrl: null,
          reason: null,
          installUrl: null,
          teamName: 'New workspace',
        },
      });
    });
    await act(async () => {
      resolveEnable?.({ hook: deniedHook });
      await Promise.resolve();
    });

    expect(
      screen.queryByRole('button', {
        name: 'settings.remoteControl.hook.binding.reauthorize',
      }),
    ).toBeNull();
  });

  it('restarts the initial multi-workspace authorization through the existing enable flow', async () => {
    const denied = {
      state: 'denied' as const,
      message: null,
      authorizeUrl: null,
      reason: null,
      installUrl: null,
      teamId: null,
      intent: 'add',
    };
    ipc.get.mockResolvedValue({
      hook: {
        ...BASE_HOOK,
        status: 'connected',
        serverMultiTeam: true,
        pendingBind: denied,
        binding: {
          ...denied,
          slackUserId: null,
          slackUserName: null,
          teamName: null,
        },
      },
    });

    render(<HookConnectionsSection />);
    await expandChannelCard(SLACK_CARD);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'settings.remoteControl.hook.binding.reauthorize',
      }),
    );

    await waitFor(() => expect(ipc.setEnabled).toHaveBeenCalledWith(true));
    expect(ipc.addBinding).not.toHaveBeenCalled();
  });

  it('retries a failed additional Slack workspace without disturbing active bindings', async () => {
    const denied = {
      state: 'denied' as const,
      message: null,
      authorizeUrl: null,
      reason: null,
      installUrl: null,
      teamId: null,
      intent: 'add',
    };
    ipc.get.mockResolvedValue({
      hook: {
        ...BASE_HOOK,
        enabled: true,
        status: 'connected',
        serverMultiTeam: true,
        bindings: [
          {
            teamId: 'TEAM_ACTIVE',
            teamName: 'Active workspace',
            slackUserId: 'USER_ACTIVE',
            slackUserName: 'active-user',
            displaced: false,
          },
        ],
        pendingBind: denied,
        binding: {
          ...denied,
          slackUserId: null,
          slackUserName: null,
          teamName: null,
        },
      },
    });

    render(<HookConnectionsSection />);
    await expandChannelCard(SLACK_CARD);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'settings.remoteControl.hook.binding.reauthorize',
      }),
    );

    await waitFor(() => expect(ipc.addBinding).toHaveBeenCalledOnce());
    expect(ipc.setEnabled).not.toHaveBeenCalled();
  });

  it('retries a pinned Slack workspace authorization with rebindTeam', async () => {
    const denied = {
      state: 'denied' as const,
      message: null,
      authorizeUrl: null,
      reason: null,
      installUrl: null,
      teamId: 'TEAM_PINNED',
      intent: 'rebind',
    };
    ipc.get.mockResolvedValue({
      hook: {
        ...BASE_HOOK,
        enabled: true,
        status: 'connected',
        serverMultiTeam: true,
        bindings: [
          {
            teamId: 'TEAM_ACTIVE',
            teamName: 'Active workspace',
            slackUserId: 'USER_ACTIVE',
            slackUserName: 'active-user',
            displaced: false,
          },
        ],
        pendingBind: denied,
        binding: {
          ...denied,
          slackUserId: null,
          slackUserName: null,
          teamName: null,
        },
      },
    });

    render(<HookConnectionsSection />);
    await expandChannelCard(SLACK_CARD);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'settings.remoteControl.hook.binding.reauthorize',
      }),
    );

    await waitFor(() => expect(ipc.rebindTeam).toHaveBeenCalledWith('TEAM_PINNED'));
    expect(ipc.addBinding).not.toHaveBeenCalled();
    expect(ipc.setEnabled).not.toHaveBeenCalled();
  });

  // The server may include the collided teamId in an add failure; that identity
  // describes the conflict, not a request to pin the next OAuth flow to that team.
  it('re-runs the add flow instead of rebinding when an add attempt fails as already-bound', async () => {
    const alreadyBound = {
      state: 'failed' as const,
      message: null,
      authorizeUrl: null,
      reason: 'already-bound',
      installUrl: null,
      teamId: 'TEAM_ACTIVE',
      intent: 'add',
    };
    ipc.get.mockResolvedValue({
      hook: {
        ...BASE_HOOK,
        enabled: true,
        status: 'connected',
        serverMultiTeam: true,
        bindings: [
          {
            teamId: 'TEAM_ACTIVE',
            teamName: 'Active workspace',
            slackUserId: 'USER_ACTIVE',
            slackUserName: 'active-user',
            displaced: false,
          },
        ],
        pendingBind: alreadyBound,
        binding: {
          ...alreadyBound,
          slackUserId: null,
          slackUserName: null,
          teamName: null,
        },
      },
    });

    render(<HookConnectionsSection />);
    await expandChannelCard(SLACK_CARD);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'settings.remoteControl.hook.binding.reauthorize',
      }),
    );

    await waitFor(() => expect(ipc.addBinding).toHaveBeenCalledOnce());
    expect(ipc.rebindTeam).not.toHaveBeenCalled();
    expect(ipc.setEnabled).not.toHaveBeenCalled();
  });

  // An add attempt that ends denied/expired/failed also carries the collided
  // teamId from the server reply; the retry must stay in the add flow so the
  // user can pick a different workspace, not pin the OAuth page to that team.
  it('keeps the retry in the add flow when a terminal add state echoes a teamId', async () => {
    const deniedWithTeam = {
      state: 'denied' as const,
      message: null,
      authorizeUrl: null,
      reason: null,
      installUrl: null,
      teamId: 'TEAM_ECHOED',
      intent: 'add' as const,
    };
    ipc.get.mockResolvedValue({
      hook: {
        ...BASE_HOOK,
        enabled: true,
        status: 'connected',
        serverMultiTeam: true,
        bindings: [
          {
            teamId: 'TEAM_ACTIVE',
            teamName: 'Active workspace',
            slackUserId: 'USER_ACTIVE',
            slackUserName: 'active-user',
            displaced: false,
          },
        ],
        pendingBind: deniedWithTeam,
        binding: {
          ...deniedWithTeam,
          slackUserId: null,
          slackUserName: null,
          teamName: null,
        },
      },
    });

    render(<HookConnectionsSection />);
    await expandChannelCard(SLACK_CARD);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'settings.remoteControl.hook.binding.reauthorize',
      }),
    );

    await waitFor(() => expect(ipc.addBinding).toHaveBeenCalledOnce());
    expect(ipc.rebindTeam).not.toHaveBeenCalled();
    expect(ipc.setEnabled).not.toHaveBeenCalled();
  });

  it('blocks conflicting Slack authorization controls while reauthorization is in flight', async () => {
    let resolveAdd: ((value: { hook: SlackHookView }) => void) | undefined;
    ipc.addBinding.mockReturnValue(
      new Promise<{ hook: SlackHookView }>((resolve) => {
        resolveAdd = resolve;
      }),
    );
    const denied = {
      state: 'denied' as const,
      message: null,
      authorizeUrl: null,
      reason: null,
      installUrl: null,
      teamId: null,
      intent: 'add',
    };
    ipc.get.mockResolvedValue({
      hook: {
        ...BASE_HOOK,
        enabled: true,
        status: 'connected',
        serverMultiTeam: true,
        bindings: [
          {
            teamId: 'TEAM_ACTIVE',
            teamName: 'Active workspace',
            slackUserId: 'USER_ACTIVE',
            slackUserName: 'active-user',
            displaced: false,
          },
        ],
        pendingBind: denied,
        binding: {
          ...denied,
          slackUserId: null,
          slackUserName: null,
          teamName: null,
        },
      },
    });

    render(<HookConnectionsSection />);
    await expandChannelCard(SLACK_CARD);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'settings.remoteControl.hook.binding.reauthorize',
      }),
    );
    const toggle = screen.getByRole('switch', {
      name: 'settings.remoteControl.hook.toggleAria',
    });
    const addWorkspace = screen.getByRole('button', {
      name: 'settings.remoteControl.hook.multi.addWorkspace',
    });
    const dismiss = screen.getByRole('button', {
      name: 'settings.remoteControl.hook.multi.dismiss',
    });
    expect(toggle).toHaveProperty('disabled', true);
    expect(addWorkspace).toHaveProperty('disabled', true);
    expect(dismiss).toHaveProperty('disabled', true);
    fireEvent.click(toggle);
    fireEvent.click(addWorkspace);
    fireEvent.click(dismiss);

    expect(ipc.addBinding).toHaveBeenCalledTimes(1);
    expect(ipc.setEnabled).not.toHaveBeenCalled();
    expect(ipc.cancelPendingBind).not.toHaveBeenCalled();
    await act(async () => {
      resolveAdd?.({ hook: BASE_HOOK });
      await Promise.resolve();
    });
  });

  it('unlocks Slack reauthorization after an IPC failure', async () => {
    ipc.setEnabled
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ hook: BASE_HOOK });
    ipc.get.mockResolvedValue({
      hook: {
        ...BASE_HOOK,
        status: 'connected',
        binding: {
          state: 'expired',
          slackUserId: null,
          slackUserName: null,
          message: null,
          authorizeUrl: null,
          reason: null,
          installUrl: null,
          teamName: null,
        },
      },
    });

    render(<HookConnectionsSection />);
    await expandChannelCard(SLACK_CARD);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'settings.remoteControl.hook.binding.reauthorize',
      }),
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalledOnce());
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'settings.remoteControl.hook.binding.reauthorize',
      }),
    );

    await waitFor(() => expect(ipc.setEnabled).toHaveBeenCalledTimes(2));
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

  it('官方 Telegram 卡不再有「新对话配置」, 行为与群设置在绑定后出现', async () => {
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
    expect(screen.getByTestId('telegram-behavior').getAttribute('data-binding-id')).toBe(
      'binding-settings',
    );
    // 它与目录行的 agent/model/effort 是同一份配置的两个入口, 画成平级两套只会
    // 让人以为可以分别设 —— global scope 仍是目录行的兜底, 只是不再有 UI 入口。
    expect(screen.queryByTestId('im-defaults-global')).toBeNull();
    expect(screen.getByTestId('telegram-groups').getAttribute('data-binding-id')).toBe(
      'binding-settings',
    );
  });

  it('老服务端(无 behavior 能力)时不渲染行为/群设置, 也不回退出「新对话配置」', async () => {
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
    // 卡确实展开了(目录区渲染出来了), 只是没有行为/群设置那两块
    expect(await screen.findAllByRole('radio')).not.toHaveLength(0);
    expect(screen.queryByTestId('telegram-behavior')).toBeNull();
    expect(screen.queryByTestId('telegram-groups')).toBeNull();
    expect(screen.queryByTestId('im-defaults-global')).toBeNull();
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

  it('X 卡是 chip 形态, Telegram 卡是目录行内的选中态单选', async () => {
    // X 一次交互只有一条公开推文, 没有目录选择面板的位置; Telegram 虽能在会话里
    // /workspace, 但那是每会话各自设的 —— 设置页绑好目录后进新群仍会落「对话」。
    // 注: chip 下拉展开后的写入路径没在这里覆盖(Radix 菜单在 jsdom 下不展开, 本仓
    // 同款 team chip 也没测); Telegram 的行内单选可以直接点, 下面就点了。
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
    // X: 标题行的 chip, 且没有行内单选
    expect(
      await screen.findByLabelText('settings.remoteControl.hook.form.defaultWorkspaceAria'),
    ).toBeTruthy();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);

    cleanup();
    ipc.get.mockResolvedValue({ hook });
    render(<HookConnectionsSection />);
    await expandChannelCard(TELEGRAM_CARD);
    // Telegram: 目录清单是一组单选 —— 「对话」+ 一个真实目录
    const radios = await screen.findAllByRole('radio');
    expect(radios).toHaveLength(2);
    // defaultWorkspace=null → 选中的是「对话」那一行
    expect(radios[0].getAttribute('aria-checked')).toBe('true');
    expect(radios[1].getAttribute('aria-checked')).toBe('false');

    fireEvent.click(radios[1]);
    await waitFor(() =>
      expect(ipc.setProviderDefaultWorkspace).toHaveBeenCalledWith('telegram', 'cindy'),
    );
  });

  /** 目录清单 + 两条 provider lane 的 hook 视图(默认目录相关用例共用)。 */
  function hookWithWorkdirs(
    telegramDefault: string | null,
    opts: { telegramEnabled?: boolean } = {},
  ): SlackHookView {
    const lane = {
      enabled: true,
      url: 'wss://tg-hook.example.test',
      status: 'connected' as const,
      lastError: null,
      available: true,
      capabilityPending: false,
      defaultWorkspace: telegramDefault,
      binding: null,
    };
    return {
      ...BASE_HOOK,
      workspaces: { cindy: '/Users/dash/Code/cindy', blog: '/Users/dash/Code/blog' },
      telegram: { ...lane, enabled: opts.telegramEnabled ?? true },
      x: { ...lane, url: 'wss://x-hook.example.test', defaultWorkspace: null },
    };
  }

  it('方向键能在目录之间切换默认工作目录(roving tabIndex 之外还要能换项)', async () => {
    // 只给 roving tabIndex 的话, 键盘用户 Tab 进组后其余项都是 tabIndex=-1,
    // 没有方向键处理就再也切不动 —— 这一条锁住 WAI-ARIA radio group 的换项行为。
    ipc.get.mockResolvedValue({ hook: hookWithWorkdirs(null) });
    render(<HookConnectionsSection />);
    await expandChannelCard(TELEGRAM_CARD);

    const radios = await screen.findAllByRole('radio');
    expect(radios).toHaveLength(3); // 对话 + cindy + blog
    radios[0].focus();
    // 从 radio 自身派发(真实路径: 焦点在 radio 上按键), 事件冒泡到组容器。
    fireEvent.keyDown(radios[0], { key: 'ArrowDown' });
    await waitFor(() =>
      expect(ipc.setProviderDefaultWorkspace).toHaveBeenCalledWith('telegram', 'cindy'),
    );
    // 焦点也要跟过去, 否则连按方向键只会在原处反复触发同一项
    expect(document.activeElement).toBe(radios[1]);
  });

  it('别名输入框里未保存的临时值不影响选中态, 也不会被写进 IPC', async () => {
    // 默认目录写的是别名, 而 store 只接受 workspaces 里已有的别名 —— 拿输入框的
    // 临时值当判据会把未保存的名字显示成已选中, 点下去还会触发 store 校验报错。
    ipc.get.mockResolvedValue({ hook: hookWithWorkdirs('cindy') });
    render(<HookConnectionsSection />);
    await expandChannelCard(TELEGRAM_CARD);

    const radios = await screen.findAllByRole('radio');
    // cindy 是当前默认 → 第二项选中(第一项是「对话」)
    expect(radios[1].getAttribute('aria-checked')).toBe('true');

    // 把 cindy 这一行的别名改成 renamed 但**不失焦**(不落盘)
    const aliasInput = screen.getByDisplayValue('cindy');
    fireEvent.change(aliasInput, { target: { value: 'renamed' } });

    // 选中态仍按已保存的映射走, 没有跳成"未选中"
    expect(screen.getAllByRole('radio')[1].getAttribute('aria-checked')).toBe('true');
    // 点它写回去的也必须是已保存的 cindy, 不是 renamed
    ipc.setProviderDefaultWorkspace.mockClear();
    fireEvent.click(screen.getAllByRole('radio')[1]);
    await waitFor(() =>
      expect(ipc.setProviderDefaultWorkspace).toHaveBeenCalledWith('telegram', 'cindy'),
    );
    expect(ipc.setProviderDefaultWorkspace).not.toHaveBeenCalledWith(
      'telegram',
      expect.stringContaining('renamed'),
    );
  });

  it('别名输入框里的方向键照常移动光标, 不得被单选组劫持', async () => {
    // 单选组容器同时包着别名输入框: 不做事件目标判定的话, 在输入框里按 ←/→ 会被
    // 当成"换选项", 焦点跳到相邻 radio 并点击它 —— 用户改个名字就换掉了默认目录。
    ipc.get.mockResolvedValue({ hook: hookWithWorkdirs('cindy') });
    render(<HookConnectionsSection />);
    await expandChannelCard(TELEGRAM_CARD);
    await screen.findAllByRole('radio');

    const aliasInput = screen.getByDisplayValue('cindy');
    aliasInput.focus();
    ipc.setProviderDefaultWorkspace.mockClear();
    fireEvent.keyDown(aliasInput, { key: 'ArrowRight' });
    fireEvent.keyDown(aliasInput, { key: 'ArrowDown' });

    expect(ipc.setProviderDefaultWorkspace).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(aliasInput);
  });

  it('只用 X 的升级用户也能清掉存量 global override', async () => {
    // global scope 是 Telegram 与 X 共用的那一份(session-runner 对 sourceIm='x' 同样读
    // readImDefaultSettings(undefined))。入口只挂在 Telegram 上时, 关掉 Telegram 的用户
    // 就得靠猜"重新打开 Telegram 才能清", 而旧值一直在被 X 任务消费。
    ipc.get.mockResolvedValue({ hook: hookWithWorkdirs(null, { telegramEnabled: false }) });
    ipc.imDefaultSettingsGet.mockResolvedValue(customizedGlobalDefaults());
    ipc.imDefaultSettingsReset.mockResolvedValue({ isCustomized: false, customizedKeys: [] });

    render(<HookConnectionsSection />);
    await expandChannelCard(X_CARD);
    await screen.findByTestId('hook-legacy-global-defaults');
    fireEvent.click(screen.getByTestId('hook-legacy-global-defaults-restore'));
    await waitFor(() => expect(ipc.imDefaultSettingsReset).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('hook-legacy-global-defaults')).toBeNull());
  });

  it('清掉存量 override 后, Telegram 与 X 两份生效值都重读', async () => {
    // 两张卡的目录行都以 global scope 为解析源 —— 只刷新当前这张, 另一张会继续显示
    // 磁盘上已经不存在的旧默认。
    ipc.get.mockResolvedValue({ hook: hookWithWorkdirs(null) });
    ipc.imDefaultSettingsGet.mockResolvedValue(customizedGlobalDefaults());
    ipc.imDefaultSettingsReset.mockResolvedValue({ isCustomized: false, customizedKeys: [] });

    render(<HookConnectionsSection />);
    await expandChannelCard(TELEGRAM_CARD);
    await screen.findByTestId('hook-legacy-global-defaults');
    prefsReload.mockClear();
    fireEvent.click(screen.getByTestId('hook-legacy-global-defaults-restore'));
    await waitFor(() => expect(prefsReload).toHaveBeenCalledTimes(2));
  });

  /**
   * 存量 global override 的 fixture: 除了当前 agent(codex)之外, **另一个** agent
   * (claude-code)的模型/档位也被改过 —— 那正是只报当前 agent 会漏掉的部分。
   */
  function customizedGlobalDefaults() {
    return {
      isCustomized: true,
      customizedKeys: ['agentKind', 'agents.codex', 'agents.claude-code'],
      agentKind: 'codex',
      permissionMode: 'auto',
      agents: {
        'claude-code': { providerId: 'byom-1', model: 'claude-opus-4-8', effort: 'max' },
        codex: { providerId: null, model: 'codex/gpt-5.5-pro', effort: 'xhigh' },
        pi: { providerId: null, model: 'claude-sonnet-5', effort: 'high' },
      },
      defaults: {
        agentKind: 'claude-code',
        permissionMode: 'auto',
        agents: {
          'claude-code': { providerId: null, model: 'claude-opus-4-8', effort: 'xhigh' },
          codex: { providerId: null, model: 'codex/gpt-5.5', effort: 'high' },
          pi: { providerId: null, model: 'claude-sonnet-5', effort: 'high' },
        },
      },
    };
  }

  it('恢复默认前列出**全部**将被清除的 override, 不只是当前 Agent 那一条', async () => {
    // imDefaultSettingsReset() 清的是整个 global scope, 包含 agents 里其它 agent 的
    // model / effort / 来源。只报当前 agent 一行, 等于让用户在不知道范围的情况下改掉
    // "显式选了那个 agent、但模型档位仍跟随默认"的目录的实际路由。
    ipc.get.mockResolvedValue({ hook: hookWithWorkdirs(null) });
    ipc.imDefaultSettingsGet.mockResolvedValue(customizedGlobalDefaults());
    render(<HookConnectionsSection />);
    await expandChannelCard(TELEGRAM_CARD);
    await screen.findByTestId('hook-legacy-global-defaults');

    // 三条 customizedKeys → 三行
    expect(screen.getAllByTestId('hook-legacy-global-defaults-row')).toHaveLength(3);

    // 另一个 agent(claude-code)那一行必须在, 且带上它真正被改过的子字段:
    // effort(max → xhigh)与来源(byom-1 → 跟随全局); model 没变则不该出现在其中。
    const otherAgent = tCalls.filter(
      (c) =>
        c.key === 'settings.remoteControl.hook.form.legacyDefaultsRowAgent' &&
        c.vars?.agent === 'claude-code',
    );
    expect(otherAgent).toHaveLength(1);
    const effort = tCalls.find(
      (c) =>
        c.key === 'settings.remoteControl.hook.form.legacyDefaultsField.effort' &&
        c.vars?.current === 'max',
    );
    expect(effort?.vars).toMatchObject({ current: 'max', fallback: 'xhigh' });
    expect(
      tCalls.some(
        (c) =>
          c.key === 'settings.remoteControl.hook.form.legacyDefaultsField.source' &&
          c.vars?.current === 'byom-1',
      ),
    ).toBe(true);
    // claude-code 的 model 与默认相同 —— 不得列成"会被清除"
    expect(
      tCalls.some(
        (c) =>
          c.key === 'settings.remoteControl.hook.form.legacyDefaultsField.model' &&
          c.vars?.current === 'claude-opus-4-8',
      ),
    ).toBe(false);
  });

  it('存量 global override: 露出可恢复入口, 恢复后消失; 从未设过的设备看不到', async () => {
    // 删掉「新对话配置」后, 旧 override 仍被 session-runner 与目录行解析当 fallback,
    // 却再也没有入口 —— 那是"旧设置继续生效但完全不可管理"(review 指出)。
    ipc.get.mockResolvedValue({ hook: hookWithWorkdirs(null) });
    ipc.imDefaultSettingsGet.mockResolvedValue(customizedGlobalDefaults());
    ipc.imDefaultSettingsReset.mockResolvedValue({ isCustomized: false, customizedKeys: [] });

    render(<HookConnectionsSection />);
    await expandChannelCard(TELEGRAM_CARD);
    await screen.findByTestId('hook-legacy-global-defaults');
    // 「查看」: 说清它是什么, 而不是只说"有个旧设置"。t 的 mock 只回键名, 所以断言
    // 插值参数(否则这条会在文案退化成"存在旧设置"时照样绿)。
    expect(
      tCalls.find((c) => c.key === 'settings.remoteControl.hook.form.legacyDefaultsRow.agentKind')
        ?.vars,
    ).toMatchObject({ current: 'codex', fallback: 'claude-code' });

    fireEvent.click(screen.getByTestId('hook-legacy-global-defaults-restore'));
    await waitFor(() => expect(ipc.imDefaultSettingsReset).toHaveBeenCalled());
    // 恢复后永久消失(不是折叠起来)
    await waitFor(() => expect(screen.queryByTestId('hook-legacy-global-defaults')).toBeNull());

    // 从未改过的设备一次都不该看到它 —— 否则等于把删掉的重叠原样放回来
    cleanup();
    ipc.imDefaultSettingsGet.mockResolvedValue({ isCustomized: false, customizedKeys: [] });
    ipc.get.mockResolvedValue({ hook: hookWithWorkdirs(null) });
    render(<HookConnectionsSection />);
    await expandChannelCard(TELEGRAM_CARD);
    await screen.findAllByRole('radio');
    expect(screen.queryByTestId('hook-legacy-global-defaults')).toBeNull();
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
    expect(screen.queryByText('settings.remoteControl.hook.x.guide.riskPublicBody')).toBeNull();
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
    expect(root?.textContent?.includes('settings.remoteControl.hook.x.guide.withdrawBody')).toBe(
      true,
    );
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
    const root = (await screen.findByText('settings.remoteControl.hook.x.guide.usageBody')).closest(
      '.select-text',
    );
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
      expect(await screen.findByText(`settings.remoteControl.hook.x.guide.${key}`)).toBeTruthy();
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
