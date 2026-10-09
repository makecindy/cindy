// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderShareReceived } from '@cindy/device-link';

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
  catalogDeviceIds.length = 0;
  catalog.value = { providers: [], loading: false, error: null, unsupported: false };
  received = [];
  command.mockReset();
  command.mockImplementation(async (cmd: { action: string }) => {
    if (cmd.action === 'received') return received;
    if (cmd.action === 'leave') return { ok: true };
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
});
