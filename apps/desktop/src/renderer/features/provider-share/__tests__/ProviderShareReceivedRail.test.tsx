// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderShareReceived } from '@cindy/device-link';

import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { ProviderShareInsights } from '../../../../shared/providerShareInsights';
import { ProviderShareInsightsSection } from '../ProviderShareInsightsSection';
import { toast } from '@/lib/toast';

import { ProviderSharePasteButton } from '../ProviderSharePasteDialog';
import { ProviderShareReceivedDetail, ProviderShareReceivedRailGroup } from '../ProviderShareReceivedRail';
import { resetProviderShareStoreForTests } from '../providerShareStore';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && Object.keys(options).length > 0 ? `${key}:${JSON.stringify(options)}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => true }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const refreshCatalog = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/remoteCatalogSnapshot', () => ({ refreshRemoteCatalogSnapshot: refreshCatalog }));
const confirmSpy = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: confirmSpy }) }));
const joinSpy = vi.hoisted(() => vi.fn());
vi.mock('../joinIntent', () => ({ requestProviderShareJoin: joinSpy }));
const catalog = vi.hoisted(() => ({
  value: { providers: [] as unknown[], loading: false, error: null as string | null, unsupported: false },
}));
const catalogDeviceIds = vi.hoisted(() => [] as Array<string | undefined>);
vi.mock('@/hooks/useDeviceProviders', () => ({
  useDeviceProviders: (deviceId?: string) => {
    catalogDeviceIds.push(deviceId);
    return catalog.value;
  },
}));

vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({ useDeviceLinkDeviceList: () => [] }));
vi.mock('@/features/provider-group/useLocalProviderGroups', () => ({ useLocalProviderGroups: () => ({}) }));

const share: ProviderShareReceived = {
  shareId: 'share-1',
  memberId: 'mem-1',
  providerId: 'xd',
  providerLabel: 'Cindy AI',
  hostDeviceId: 'host-1',
  deviceName: "Magi's Mac Mini",
  owner: { displayName: 'Magi', avatarUrl: null, region: 'global' },
  status: 'paused',
  hostOnline: true,
  hostCapable: true,
};

let received: ProviderShareReceived[] = [];
const command = vi.fn();

beforeEach(() => {
  resetProviderShareStoreForTests();
  joinSpy.mockClear();
  refreshCatalog.mockClear();
  confirmSpy.mockClear();
  vi.mocked(toast.error).mockClear();
  catalogDeviceIds.length = 0;
  catalog.value = { providers: [], loading: false, error: null, unsupported: false };
  received = [];
  command.mockReset();
  command.mockImplementation(async (cmd: { action: string }) => {
    if (cmd.action === 'received') return received;
    if (cmd.action === 'leave') return { ok: true };
    if (cmd.action === 'get-credential-consent') return { skip: false };
    throw new Error(`unexpected ${cmd.action}`);
  });
  Object.assign(window, {
    electronAPI: { providerShare: { command, onReceivedChanged: () => () => undefined } },
  });
});

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('ProviderSharePasteButton', () => {
  it('hands an entered link to the apply dialog', async () => {
    render(<ProviderSharePasteButton />);
    fireEvent.click(screen.getByRole('button', { name: 'providerShare.received.enterLink' }));
    const dialog = await screen.findByTestId('provider-share-paste-dialog');
    fireEvent.click(screen.getByRole('button', { name: 'providerShare.received.pasteDialog.open' }));
    expect(joinSpy).not.toHaveBeenCalled();
    expect(dialog.textContent).toContain('providerShare.received.pasteDialog.empty');

    fireEvent.change(screen.getByLabelText('providerShare.received.pasteDialog.label'), {
      target: { value: '  see https://x.test/provider-share/join#abc  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'providerShare.received.pasteDialog.open' }));
    expect(joinSpy).toHaveBeenCalledWith('see https://x.test/provider-share/join#abc');
    await waitFor(() => expect(screen.queryByTestId('provider-share-paste-dialog')).toBeNull());
  });
});

describe('ProviderShareReceivedRailGroup', () => {
  it('is hidden while nothing is shared with me', async () => {
    render(<ProviderShareReceivedRailGroup selectedShareId={null} onSelect={() => undefined} />);
    await waitFor(() => expect(command).toHaveBeenCalledWith({ action: 'received' }));
    expect(screen.queryByTestId('provider-share-received')).toBeNull();
    expect(screen.queryByText('providerShare.received.title')).toBeNull();
  });

  it('lists received shares next to the providers and selects one', async () => {
    received = [share];
    const onSelect = vi.fn();
    render(<ProviderShareReceivedRailGroup selectedShareId={null} onSelect={onSelect} />);
    const row = await screen.findByTestId('provider-share-received-row');
    expect(screen.getByText('providerShare.received.title')).toBeTruthy();
    expect(row.textContent).toContain('Cindy AI');
    expect(row.getAttribute('aria-label')).toContain('providerShare.received.statusPaused');
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith('share-1');
  });
});

describe('ProviderShareReceivedDetail', () => {
  it('refreshes an active share whose catalog is empty without an error', async () => {
    await act(async () => { render(<ProviderShareReceivedDetail share={{ ...share, status: 'active' }} />); });
    expect(screen.getByText('providerShare.received.modelsEmpty')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.models.refreshBuiltinAria' }));
    expect(refreshCatalog).toHaveBeenCalledTimes(1);
    expect(refreshCatalog).toHaveBeenCalledWith('share:share-1');
    expect(screen.queryByRole('button', { name: 'providerShare.received.retryModels' })).toBeNull();
  });

  it('keeps the refresh action visible but disabled while the catalog is loading', async () => {
    catalog.value.loading = true;
    await act(async () => { render(<ProviderShareReceivedDetail share={{ ...share, status: 'active' }} />); });
    const button = screen.getByRole('button', { name: 'settings.providers.models.refreshingAria' });
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(button);
    expect(refreshCatalog).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'paused' as const },
    { status: 'active' as const, hostOnline: false },
    { status: 'active' as const, hostCapable: false },
  ])('hides refresh when the share is unavailable: %j', async (unavailable) => {
    await act(async () => { render(<ProviderShareReceivedDetail share={{ ...share, ...unavailable }} />); });
    expect(screen.queryByRole('button', { name: /settings\.providers\.models\.refresh/ })).toBeNull();
  });

  it('shows anonymous status only for an active grouped share', async () => {
    catalog.value.providers = [{ id: 'xd', groupSize: 2, models: {} }];
    const invoke = vi.fn(async () => ({ providers: [{ id: 'xd', groupSize: 2, groupStatus: ['available', 'needs-update'] }] }));
    Object.assign(window.electronAPI, { deviceLink: { invoke } });
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<ProviderShareReceivedDetail share={{ ...share, status: 'active' }} />); });
    expect(screen.getByTestId('shared-provider-group-status')).toBeTruthy();
    expect(screen.getByText('providerShare.received.groupStatus.state.needs-update')).toBeTruthy();
    expect(screen.queryByText(share.deviceName)).toBeNull();
    await act(async () => { view.rerender(<ProviderShareReceivedDetail share={share} />); });
    expect(screen.queryByTestId('shared-provider-group-status')).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('explains a paused share without reading its models, and leaves after confirmation', async () => {
    render(<ProviderShareReceivedDetail share={share} />);
    expect(screen.getByText('providerShare.received.statusPaused')).toBeTruthy();
    expect(screen.getByText('providerShare.received.pausedNote')).toBeTruthy();
    expect(catalogDeviceIds.every((deviceId) => deviceId === undefined)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /providerShare\.received\.leaveAria/ }));
    await waitFor(() => expect(command).toHaveBeenCalledWith({ action: 'leave', memberId: 'mem-1' }));
    expect(confirmSpy).toHaveBeenCalledWith(expect.objectContaining({ confirmVariant: 'destructive' }));
  });

  it('lists the shared models the owner left visible', async () => {
    catalog.value = {
      providers: [{
        id: 'xd', name: 'Cindy AI', agents: ['claude-code', 'codex'], connected: true, routing: {},
        models: {
          'claude-code': [{ id: 'opus', name: 'Opus 5.5' }, { id: 'hidden', name: 'Hidden' }],
          codex: [{ id: 'opus', name: 'Opus 5.5' }, { id: 'gpt', name: 'GPT-5.5' }],
        },
      }],
      modelVisibilityOverrides: { 'claude-code:xd:hidden': false },
      loading: false,
      error: null,
      unsupported: false,
    } as typeof catalog.value;
    await act(async () => { render(<ProviderShareReceivedDetail share={{ ...share, status: 'active' }} />); });
    expect(catalogDeviceIds).toContain('share:share-1');
    const list = screen.getByTestId('provider-share-received-models');
    expect(Array.from(list.querySelectorAll('li')).map((item) => item.textContent)).toEqual(['Opus 5.5', 'GPT-5.5']);
    expect(screen.getByRole('button', { name: 'settings.providers.models.refreshBuiltinAria' })).toBeTruthy();
  });

  it('says why the models cannot be read and offers a reload', async () => {
    catalog.value = {
      providers: [], loading: false, error: '[DEVICE_LINK_TIMEOUT] timed out', unsupported: false,
    };
    await act(async () => { render(<ProviderShareReceivedDetail share={{ ...share, status: 'active' }} />); });
    expect(screen.getByText('providerShare.received.modelsFailedWithCode:{"code":"DEVICE_LINK_TIMEOUT"}')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'settings.providers.models.refreshBuiltinAria' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'providerShare.received.retryModels' }));
    expect(refreshCatalog).toHaveBeenCalledWith('share:share-1');
  });

  it('tells a refusal by the owner computer apart from a failed read', async () => {
    catalog.value = {
      providers: [], loading: false,
      error: 'Error invoking remote method: Error: [REMOTE_AGENT_SHARE_UNAVAILABLE] not available', unsupported: false,
    };
    await act(async () => { render(<ProviderShareReceivedDetail share={{ ...share, status: 'active' }} />); });
    expect(screen.getByText('providerShare.received.modelsRefused')).toBeTruthy();
  });

  const consentSwitch = () =>
    screen.findByRole('switch', { name: 'providerShare.received.credentialConsent.ariaLabel:{"name":"Magi","provider":"Cindy AI"}' });

  it.each([
    { initial: true, outcome: 'success' },
    { initial: true, outcome: 'failure' },
    { initial: false, outcome: 'success' },
    { initial: false, outcome: 'failure' },
  ] as const)('keeps the effective trust state while saving (initial=$initial, outcome=$outcome)', async ({ initial, outcome }) => {
    let finishSave!: (view: { skip: boolean }) => void;
    let failSave!: (error: Error) => void;
    const pendingSave = new Promise<{ skip: boolean }>((resolve, reject) => {
      finishSave = resolve;
      failSave = reject;
    });
    command.mockImplementation(async (cmd: { action: string }) => {
      if (cmd.action === 'received') return received;
      if (cmd.action === 'get-credential-consent') return { skip: initial };
      if (cmd.action === 'set-credential-consent') return pendingSave;
      throw new Error('unexpected ' + cmd.action);
    });
    render(<ProviderShareReceivedDetail share={share} />);
    const toggle = await consentSwitch();
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    expect(toggle.getAttribute('aria-checked')).toBe(String(initial));

    await act(async () => { fireEvent.click(toggle); });
    expect(command).toHaveBeenCalledWith({ action: 'set-credential-consent', shareId: 'share-1', skip: !initial });
    expect(toggle.hasAttribute('disabled')).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe(String(initial));

    await act(async () => {
      if (outcome === 'success') finishSave({ skip: !initial });
      else failSave(new Error('disk'));
    });
    expect(toggle.getAttribute('aria-checked')).toBe(String(outcome === 'success' ? !initial : initial));
    expect(toggle.hasAttribute('disabled')).toBe(false);
    if (outcome === 'failure') {
      expect(toast.error).toHaveBeenCalledWith('providerShare.received.credentialConsent.writeFailed');
    } else {
      expect(toast.error).not.toHaveBeenCalled();
    }
  });

  it.each(['success', 'failure'] as const)('ignores a stale save %s after switching shares', async (outcome) => {
    let finishSave!: (view: { skip: boolean }) => void;
    let failSave!: (error: Error) => void;
    const pendingSave = new Promise<{ skip: boolean }>((resolve, reject) => {
      finishSave = resolve;
      failSave = reject;
    });
    command.mockImplementation(async (cmd: { action: string }) => {
      if (cmd.action === 'received') return received;
      if (cmd.action === 'get-credential-consent') return { skip: true };
      if (cmd.action === 'set-credential-consent') return pendingSave;
      throw new Error('unexpected ' + cmd.action);
    });
    const view = render(<ProviderShareReceivedDetail share={share} />);
    const toggle = await consentSwitch();
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    await act(async () => { fireEvent.click(toggle); });
    await waitFor(() => expect(command).toHaveBeenCalledWith({ action: 'set-credential-consent', shareId: 'share-1', skip: false }));

    view.rerender(<ProviderShareReceivedDetail share={{ ...share, shareId: 'share-2', memberId: 'mem-2' }} />);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    await act(async () => {
      if (outcome === 'success') finishSave({ skip: false });
      else failSave(new Error('disk'));
    });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.hasAttribute('disabled')).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('does not end a new share save when the previous share save finishes', async () => {
    const saves = new Map<string, (view: { skip: boolean }) => void>();
    command.mockImplementation(async (cmd: { action: string; shareId?: string }) => {
      if (cmd.action === 'received') return received;
      if (cmd.action === 'get-credential-consent') return { skip: true };
      if (cmd.action === 'set-credential-consent') {
        return new Promise<{ skip: boolean }>((resolve) => { saves.set(cmd.shareId!, resolve); });
      }
      throw new Error('unexpected ' + cmd.action);
    });
    const view = render(<ProviderShareReceivedDetail share={share} />);
    const toggle = await consentSwitch();
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    await act(async () => { fireEvent.click(toggle); });
    await waitFor(() => expect(saves.has('share-1')).toBe(true));

    view.rerender(<ProviderShareReceivedDetail share={{ ...share, shareId: 'share-2', memberId: 'mem-2' }} />);
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    await act(async () => { fireEvent.click(toggle); });
    await waitFor(() => expect(saves.has('share-2')).toBe(true));
    await act(async () => { saves.get('share-1')!({ skip: false }); });
    expect(toggle.hasAttribute('disabled')).toBe(true);
    await act(async () => { saves.get('share-2')!({ skip: false }); });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.hasAttribute('disabled')).toBe(false);
  });

  it('reads whether credential operations skip confirmation here and saves a toggle', async () => {
    let skip = true;
    command.mockImplementation(async (cmd: { action: string; shareId?: string; skip?: boolean }) => {
      if (cmd.action === 'received') return received;
      if (cmd.action === 'get-credential-consent') return { skip };
      if (cmd.action === 'set-credential-consent') {
        skip = cmd.skip === true;
        return { skip };
      }
      throw new Error(`unexpected ${cmd.action}`);
    });
    render(<ProviderShareReceivedDetail share={share} />);
    const toggle = await consentSwitch();
    // 标题写「信任 {分享者}」：信任的是分享给我的人。
    expect(screen.getByText('providerShare.received.credentialConsent.label:{"name":"Magi"}')).toBeTruthy();
    expect(screen.getByText('providerShare.received.credentialConsent.description')).toBeTruthy();
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));

    await act(async () => { fireEvent.click(toggle); });
    await waitFor(() => expect(command).toHaveBeenCalledWith({ action: 'set-credential-consent', shareId: 'share-1', skip: false }));
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('keeps the saved choice and says so when the preference cannot be saved', async () => {
    command.mockImplementation(async (cmd: { action: string }) => {
      if (cmd.action === 'received') return received;
      if (cmd.action === 'get-credential-consent') return { skip: false };
      if (cmd.action === 'set-credential-consent') throw new Error('disk');
      throw new Error(`unexpected ${cmd.action}`);
    });
    render(<ProviderShareReceivedDetail share={share} />);
    const toggle = await consentSwitch();
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    await act(async () => { fireEvent.click(toggle); });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('providerShare.received.credentialConsent.writeFailed'));
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });
});

/* 真实详情组件验证两开关组合及轮询/身份切换时清空；不覆盖已有模型目录测试。tier: unit。 */
const insights = (quota = true, usage = true, includeUsage = true): ProviderShareInsights => ({
  version: 1, capabilities: { quota, usage }, status: { quota: quota ? 'ready' : 'disabled', usage: !usage ? 'disabled' : includeUsage ? 'ready' : 'not-requested' },
  quota: quota ? { group: false, partial: false, accounts: [{ state: 'ready', updatedAt: null, windows: [], balance: { remaining: 12.34, total: null, currency: 'USD', resetsAt: null, pools: [] } }] } : null,
  usage: usage && includeUsage ? { todayKey: '2026-10-19', coverageStart: null, parties: [{ key: 'owner', displayName: 'Shared Owner', avatarUrl: null, isYou: false, isOwner: true, isRelay: false, lastUsedAt: null, days: [] }] } : null,
});
describe('shared read-only insights', () => {
  it.each([[false, false], [true, false], [false, true], [true, true]])('renders independent quota=%s usage=%s permissions', async (quota, usage) => {
    const original = command.getMockImplementation()!;
    command.mockImplementation((cmd) => cmd.action === 'insights' ? Promise.resolve(insights(quota, usage, cmd.includeUsage)) : original(cmd));
    await act(async () => { render(<ProviderShareReceivedDetail share={{ ...share, status: 'active' }} />); });
    expect(Boolean(screen.queryByText('$12.34'))).toBe(quota);
    expect(screen.queryByText('Shared Owner')).toBeNull();
    if (usage) await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'providerShare.insights.usageTitle' })); });
    expect(Boolean(screen.queryByText('Shared Owner'))).toBe(usage);
    expect(screen.queryByText('providerGroup.usage.stack.computer')).toBeNull();
    expect(screen.queryByTestId('share-member-menu')).toBeNull();
  });
  it('clears the previous display when polling observes closed permissions', async () => {
    vi.useFakeTimers();
    command.mockImplementation(async (cmd) => cmd.action === 'insights' ? insights(true, true, cmd.includeUsage) : []);
    await act(async () => { render(<ProviderShareInsightsSection share={{ ...share, status: 'active' }} />); });
    expect(screen.getByText('$12.34')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'providerShare.insights.usageTitle' })); });
    expect(screen.getByText('Shared Owner')).toBeTruthy();
    command.mockImplementation(async (cmd) => cmd.action === 'insights' ? insights(false, false) : []);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.queryByText('$12.34')).toBeNull(); expect(screen.queryByText('Shared Owner')).toBeNull();
  });
  // 默认收起不挡模型；轮询不改变用户选择，切换身份不能继承展开状态。tier: unit。
  it('keeps usage collapsed by default and preserves explicit toggles across polling', async () => {
    vi.useFakeTimers();
    command.mockImplementation(async (cmd) => cmd.action === 'insights' ? insights(true, true, cmd.includeUsage) : []);
    await act(async () => { render(<ProviderShareInsightsSection share={{ ...share, status: 'active' }} />); });
    const toggle = screen.getByRole('button', { name: 'providerShare.insights.usageTitle' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Shared Owner')).toBeNull();
    expect(screen.getByText('$12.34')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { fireEvent.click(toggle); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Shared Owner')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await act(async () => { fireEvent.click(toggle); });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Shared Owner')).toBeNull();
    expect(screen.getByText('$12.34')).toBeTruthy();
  });
  // 明细请求失败后仍可看额度和重新展开；仅折叠轮询不能伪装成重试成功。
  it('keeps quota and the actual usage failure until an explicit retry', async () => {
    vi.useFakeTimers();
    let fail = true;
    command.mockImplementation(async (cmd) => {
      if (cmd.action !== 'insights') return [];
      const view = insights(true, true, cmd.includeUsage);
      return cmd.includeUsage && fail ? { ...view, status: { ...view.status, usage: 'unavailable' }, usage: null } : view;
    });
    await act(async () => { render(<ProviderShareInsightsSection share={{ ...share, status: 'active' }} />); });
    expect(screen.queryByText('providerShare.insights.usageUnavailable')).toBeNull();
    const toggle = screen.getByRole('button', { name: 'providerShare.insights.usageTitle' });
    await act(async () => { fireEvent.click(toggle); });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('$12.34')).toBeTruthy();
    expect(screen.getByText('providerShare.insights.usageUnavailable')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(command.mock.lastCall?.[0].includeUsage).toBe(false);
    expect(screen.getByText('providerShare.insights.usageUnavailable')).toBeTruthy();
    fail = false;
    await act(async () => { fireEvent.click(toggle); });
    expect(screen.getByText('Shared Owner')).toBeTruthy();
    expect(screen.queryByText('providerShare.insights.usageUnavailable')).toBeNull();
  });
  it.each(['share', 'account'])('resets expanded usage after %s changes', async (change) => {
    command.mockImplementation(async (cmd) => cmd.action === 'insights' ? insights(true, true, cmd.includeUsage) : []);
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<ProviderShareInsightsSection share={{ ...share, status: 'active' }} />); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'providerShare.insights.usageTitle' })); });
    expect(screen.getByText('Shared Owner')).toBeTruthy();
    await act(async () => {
      if (change === 'account') setDataOwnerGeneration('new-owner');
      view.rerender(<ProviderShareInsightsSection share={{ ...share, status: 'active', shareId: change === 'share' ? 'new-share' : share.shareId }} />);
    });
    expect(screen.getByRole('button', { name: 'providerShare.insights.usageTitle' }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Shared Owner')).toBeNull();
    expect(command.mock.calls.filter(([cmd]) => cmd.action === 'insights').at(-1)?.[0].includeUsage).toBe(false);
    setDataOwnerGeneration(null);
  });
  // 分享余额曾把剩余比例当普通余额条，缺少低余额预警。经真实分享组件验证剩余/已用转换；
  // 最小输入15%剩余应warn，未知总额不得预警。沿用QuotaBar阈值测试，不复制阈值算法。tier: unit。
  it.each([
    { remaining: 100, total: 100, expected: '100', severity: 'normal' },
    { remaining: 64.8, total: 100, expected: '65', severity: 'normal' },
    { remaining: 15, total: 100, expected: '15', severity: 'warn' },
    { remaining: 10, total: 100, expected: '10', severity: 'crit' },
    { remaining: 5, total: 100, expected: '5', severity: 'crit' },
    { remaining: 0, total: 0, expected: '0', severity: 'crit' },
    { remaining: 25, total: null, expected: null, severity: null },
  ])('renders known balance progress without inventing unknown totals: %j', async ({ remaining, total, expected, severity }) => {
    const data = insights(true, false);
    data.quota!.accounts[0].balance = { remaining, total, currency: 'USD', resetsAt: null, pools: [] };
    command.mockResolvedValue(data);
    await act(async () => { render(<ProviderShareInsightsSection share={{ ...share, status: 'active' }} />); });
    const bar = screen.queryByRole('progressbar');
    expect(bar?.getAttribute('aria-valuenow') ?? null).toBe(expected);
    expect(bar?.getAttribute('data-severity') ?? null).toBe(severity);
  });
  it('uses remaining subscription progress without reset or management actions', async () => {
    const data = insights(true, false);
    data.quota!.accounts[0].balance = null;
    data.quota!.accounts[0].windows = [{ kind: 'week', label: null, windowMinutes: 10080, remainingPercent: 72, resetsAt: Date.now() + 86_400_000 }];
    command.mockResolvedValue(data);
    await act(async () => { render(<ProviderShareInsightsSection share={{ ...share, status: 'active' }} />); });
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('72');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('quotaCard.remainingPercent:{"percent":72}')).toBeTruthy();
  });
  // 新只读通道的旧版/离线错误必须清旧数据并显示原因，不能看起来仍有额度。tier: unit。
  it.each([
    ['UNSUPPORTED_CAPABILITY', 'needs-update'],
    ['DEVICE_LINK_DEVICE_OFFLINE', 'offline'],
  ])('clears the previous display when polling returns %s', async (code, message) => {
    vi.useFakeTimers();
    command.mockImplementation(async (cmd) => cmd.action === 'insights' ? insights(true, true, cmd.includeUsage) : []);
    await act(async () => { render(<ProviderShareInsightsSection share={{ ...share, status: 'active' }} />); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'providerShare.insights.usageTitle' })); });
    expect(screen.getByText('Shared Owner')).toBeTruthy();
    command.mockRejectedValue(new Error(`[${code}] unavailable`));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByRole('status').textContent).toBe(`providerShare.insights.${message}`);
    expect(screen.queryByText('$12.34')).toBeNull();
    expect(screen.queryByText('Shared Owner')).toBeNull();
  });
  it('resumes fresh reads after batched pause/resume events without accepting the old response', async () => {
    vi.useFakeTimers();
    let finish!: (value: ProviderShareInsights) => void;
    command.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    let listener!: (value: ProviderShareReceived[]) => void;
    window.electronAPI.providerShare.onReceivedChanged = (next) => { listener = next; return () => {}; };
    await act(async () => { render(<ProviderShareInsightsSection share={{ ...share, status: 'active' }} />); });
    await act(async () => { listener([{ ...share, status: 'paused' }]); listener([{ ...share, status: 'active' }]); finish(insights()); });
    expect(screen.queryByText('$12.34')).toBeNull();
    command.mockImplementation(async (cmd) => cmd.action === 'insights' ? insights(true, true, cmd.includeUsage) : []);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByText('$12.34')).toBeTruthy();
  });
  it.each(['share', 'account', 'removed'])('discards in-flight results after %s changes', async (change) => {
    let resolve!: (value: ProviderShareInsights) => void;
    command.mockImplementation(() => new Promise<ProviderShareInsights>((done) => { resolve = done; }));
    let receivedListener!: (value: ProviderShareReceived[]) => void;
    window.electronAPI.providerShare.onReceivedChanged = (listener) => { receivedListener = listener; return () => {}; };
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<ProviderShareInsightsSection share={{ ...share, status: 'active' }} />); });
    const late = resolve;
    await act(async () => {
      if (change === 'share') view.rerender(<ProviderShareInsightsSection share={{ ...share, shareId: 'different', status: 'active' }} />);
      if (change === 'account') { setDataOwnerGeneration('another-owner'); view.rerender(<ProviderShareInsightsSection share={{ ...share, status: 'active' }} />); }
      if (change === 'removed') receivedListener([]);
      late(insights());
    });
    expect(screen.queryByText('$12.34')).toBeNull(); expect(screen.queryByText('Shared Owner')).toBeNull();
    setDataOwnerGeneration(null);
  });
});
