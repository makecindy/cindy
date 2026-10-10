// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderShareOwnerState } from '../../../../shared/providerShare';
import { ProviderShareManagePage } from '../ProviderShareManagePage';
import { getProviderSharePendingRequests, resetProviderShareStoreForTests } from '../providerShareStore';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && Object.keys(options).length > 0 ? `${key}:${JSON.stringify(options)}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => [{ deviceId: 'self', name: "Magi's Mac Mini", isSelf: true }],
}));
const confirmSpy = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: confirmSpy }) }));

const owned = (): ProviderShareOwnerState => ({
  ready: true,
  shares: [
    {
      shareId: 'share-1',
      providerId: 'xd',
      providerLabel: 'Cindy AI',
      createdAt: '2026-09-01T00:00:00Z',
      requests: [
        {
          requestId: 'req-1',
          displayName: 'Wang Yi',
          avatarUrl: null,
          region: 'global',
          pairingCode: '4827',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
      ],
      members: [
        {
          memberId: 'mem-1',
          displayName: 'Lizi',
          avatarUrl: null,
          region: 'global',
          status: 'active',
          joinedAt: '2026-09-28T00:00:00Z',
          lastUsedAt: Date.now() - 60_000,
          runningTasks: 1,
          models: [
            {
              kind: 'claude-code',
              providerId: 'xd',
              model: 'claude-opus-5-5',
              turns: 96,
              inputTokens: 1_310_000,
              outputTokens: 188_000,
              cacheReadTokens: 0,
              cacheCreateTokens: 0,
              amount: { amount: 31.2, currency: 'USD' },
            },
          ],
        },
      ],
    },
    // 另一个供应商的分享不出现在这一页。
    { shareId: 'share-2', providerId: 'openai', providerLabel: 'OpenAI', createdAt: '2026-09-01T00:00:00Z', requests: [], members: [] },
  ],
});

const command = vi.fn();

beforeEach(() => {
  resetProviderShareStoreForTests();
  confirmSpy.mockClear();
  command.mockReset();
  command.mockImplementation(async (cmd: { action: string }) => {
    if (cmd.action === 'owned') return owned();
    if (cmd.action === 'set-member' || cmd.action === 'approve' || cmd.action === 'reject') return { ok: true };
    throw new Error(`unexpected ${cmd.action}`);
  });
  Object.assign(window, {
    electronAPI: {
      providerShare: { command, onOwnedChanged: () => () => undefined },
      // 页面上方的供应商组一块(由 ProviderGroupSection 自己的测试覆盖)：这里只给一个空组。
      providerGroup: {
        command: async (cmd: { providerId: string }) => ({ providerId: cmd.providerId, config: null, members: [] }),
        onChanged: () => () => undefined,
      },
    },
  });
});

afterEach(() => cleanup());

function renderPage(gate: 'on' | 'remote-off' | 'invocation-off' = 'on') {
  const onBack = vi.fn();
  render(<ProviderShareManagePage providerId="xd" providerName="Cindy AI" providerIcon={null} gate={gate} onBack={onBack} />);
  return { onBack };
}

describe('ProviderShareManagePage', () => {
  it('lists pending requests and members for this provider only, and publishes pending requests', async () => {
    renderPage();
    expect(await screen.findAllByTestId('provider-share-member-row')).toHaveLength(1);
    expect(screen.getAllByTestId('provider-share-pending-row')).toHaveLength(1);
    expect(command).toHaveBeenCalledWith({ action: 'owned', range: 'month' });
    expect(getProviderSharePendingRequests().map((item) => item.request.requestId)).toEqual(['req-1']);
    expect(screen.getByText(/providerShare\.manage\.members\.statusRunning/)).toBeTruthy();
    expect(screen.getByText(/providerShare\.manage\.descriptionWithDevice/)).toBeTruthy();
  });

  it('re-reads usage when the period changes and expands the per-model breakdown', async () => {
    renderPage();
    await screen.findAllByTestId('provider-share-member-row');
    fireEvent.click(screen.getByRole('radio', { name: 'providerShare.manage.members.range.7d' }));
    await waitFor(() => expect(command).toHaveBeenCalledWith({ action: 'owned', range: '7d' }));

    fireEvent.click(screen.getByRole('button', { name: /providerShare\.manage\.members\.expandAria/ }));
    expect(screen.getByText('Opus 5.5')).toBeTruthy();
    expect(screen.getByText('$31.20')).toBeTruthy();
    expect(screen.getByText('providerShare.manage.members.estimateNote')).toBeTruthy();
  });

  it('pauses and removes a member after confirmation', async () => {
    renderPage();
    await screen.findAllByTestId('provider-share-member-row');
    fireEvent.click(screen.getByRole('button', { name: 'providerShare.manage.members.pause' }));
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({ action: 'set-member', memberId: 'mem-1', status: 'pause' }),
    );
    fireEvent.click(screen.getByRole('button', { name: /providerShare\.manage\.members\.removeAria/ }));
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({ action: 'set-member', memberId: 'mem-1', status: 'remove' }),
    );
    expect(confirmSpy).toHaveBeenCalledWith(expect.objectContaining({ confirmVariant: 'destructive' }));
  });

  it('disables link creation and explains why when sharing is gated', async () => {
    renderPage('invocation-off');
    await screen.findAllByTestId('provider-share-member-row');
    const create = screen.getByRole('button', { name: 'providerShare.manage.createLink' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('providerShare.manage.gateInvocation');
  });
});
