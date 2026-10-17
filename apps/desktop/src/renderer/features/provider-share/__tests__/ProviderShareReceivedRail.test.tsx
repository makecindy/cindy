// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderShareReceived } from '@cindy/device-link';

import { toast } from '@/lib/toast';

import { ProviderSharePasteButton } from '../ProviderSharePasteDialog';
import { ProviderShareReceivedDetail, ProviderShareReceivedRailGroup } from '../ProviderShareReceivedRail';
import { resetProviderShareStoreForTests } from '../providerShareStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && Object.keys(options).length > 0 ? `${key}:${JSON.stringify(options)}` : key,
    i18n: { language: 'en' },
  }),
}));
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

afterEach(() => cleanup());

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

  it('lists the shared models the owner left visible', () => {
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
    render(<ProviderShareReceivedDetail share={{ ...share, status: 'active' }} />);
    expect(catalogDeviceIds).toContain('share:share-1');
    const list = screen.getByTestId('provider-share-received-models');
    expect(Array.from(list.querySelectorAll('li')).map((item) => item.textContent)).toEqual(['Opus 5.5', 'GPT-5.5']);
  });

  it('says why the models cannot be read and offers a reload', () => {
    catalog.value = {
      providers: [], loading: false, error: '[DEVICE_LINK_TIMEOUT] timed out', unsupported: false,
    };
    render(<ProviderShareReceivedDetail share={{ ...share, status: 'active' }} />);
    expect(screen.getByText('providerShare.received.modelsFailedWithCode:{"code":"DEVICE_LINK_TIMEOUT"}')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'providerShare.received.retryModels' }));
    expect(refreshCatalog).toHaveBeenCalledWith('share:share-1');
  });

  it('tells a refusal by the owner computer apart from a failed read', () => {
    catalog.value = {
      providers: [], loading: false,
      error: 'Error invoking remote method: Error: [REMOTE_AGENT_SHARE_UNAVAILABLE] not available', unsupported: false,
    };
    render(<ProviderShareReceivedDetail share={{ ...share, status: 'active' }} />);
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

    fireEvent.click(toggle);
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
    fireEvent.click(toggle);
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
    fireEvent.click(toggle);
    await waitFor(() => expect(saves.has('share-1')).toBe(true));

    view.rerender(<ProviderShareReceivedDetail share={{ ...share, shareId: 'share-2', memberId: 'mem-2' }} />);
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    fireEvent.click(toggle);
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

    fireEvent.click(toggle);
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

    fireEvent.click(toggle);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('providerShare.received.credentialConsent.writeFailed'));
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });
});
