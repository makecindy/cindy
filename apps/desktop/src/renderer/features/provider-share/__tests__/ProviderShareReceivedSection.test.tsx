// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderShareReceived } from '@cindy/device-link';

import { ProviderShareReceivedSection } from '../ProviderShareReceivedSection';
import { resetProviderShareStoreForTests } from '../providerShareStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && Object.keys(options).length > 0 ? `${key}:${JSON.stringify(options)}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/remoteCatalogSnapshot', () => ({ refreshRemoteCatalogSnapshot: vi.fn(async () => undefined) }));
const confirmSpy = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: confirmSpy }) }));
const joinSpy = vi.hoisted(() => vi.fn());
vi.mock('../joinIntent', () => ({ requestProviderShareJoin: joinSpy }));

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

describe('ProviderShareReceivedSection', () => {
  it('stays visible when empty and hands a pasted link to the apply dialog', async () => {
    render(<ProviderShareReceivedSection />);
    expect(screen.getByText('providerShare.received.title')).toBeTruthy();
    expect(screen.getByText('providerShare.received.empty')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'providerShare.received.paste' }));
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

  it('lists received shares with their status and leaves after confirmation', async () => {
    received = [share];
    render(<ProviderShareReceivedSection />);
    expect(await screen.findByTestId('provider-share-received-row')).toBeTruthy();
    expect(screen.getByText('providerShare.received.statusPaused')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /providerShare\.received\.leaveAria/ }));
    await waitFor(() => expect(command).toHaveBeenCalledWith({ action: 'leave', memberId: 'mem-1' }));
    expect(confirmSpy).toHaveBeenCalledWith(expect.objectContaining({ confirmVariant: 'destructive' }));
  });
});
