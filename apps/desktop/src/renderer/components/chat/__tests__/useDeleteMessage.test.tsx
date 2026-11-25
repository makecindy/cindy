// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
  deleteMessageFor: vi.fn(),
  removeMessagesByClientIds: vi.fn(),
  emitRefresh: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm }),
}));

vi.mock('@/lib/makerTransport', () => ({
  deleteMessageFor: mocks.deleteMessageFor,
}));

vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    removeMessagesByClientIds: mocks.removeMessagesByClientIds,
  },
}));

vi.mock('@/lib/sessionsBus', () => ({
  emitRefresh: mocks.emitRefresh,
}));

vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  getSessionDeviceId: () => undefined,
}));

vi.mock('@/features/device-link/refreshRemoteSessions', () => ({
  refreshRemoteDeviceSessions: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn() },
}));

import { toast } from '@/lib/toast';

import { useDeleteMessage } from '../useDeleteMessage';

describe('useDeleteMessage invoke fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Unit: the response can start after the confirmation opens. Exercise the hook
  // with an Electron-wrapped refusal; the earlier success tests only cover committed deletes.
  it.each([
    ['SESSION_RUNNING', 'ipcError.SESSION_RUNNING'],
    ['NOT_FOUND', 'chat.messageActionBar.deleteFailed'],
  ])('shows the appropriate feedback after a %s refusal', async (code, key) => {
    mocks.deleteMessageFor.mockRejectedValueOnce(new Error(
      `Error invoking remote method 'maker:message:delete': Error: [${code}] request refused`,
    ));
    const { result } = renderHook(() => useDeleteMessage({
      sessionId: 's1',
      messageClientId: 'final',
    }));

    await act(async () => result.current());

    expect(toast.error).toHaveBeenCalledWith(key);
    expect(mocks.removeMessagesByClientIds).not.toHaveBeenCalled();
  });

  it('mirrors every committed id returned by a new host', async () => {
    mocks.deleteMessageFor.mockResolvedValue({
      sessionId: 's1',
      clientId: 'final',
      clientIds: ['progress', 'thinking', 'final'],
    });
    const { result } = renderHook(() => useDeleteMessage({
      sessionId: 's1',
      messageClientId: 'final',
    }));

    await act(async () => result.current());

    expect(mocks.removeMessagesByClientIds).toHaveBeenCalledWith(
      's1',
      ['progress', 'thinking', 'final'],
    );
  });

  it('falls back to the clicked id for an old host response', async () => {
    mocks.deleteMessageFor.mockResolvedValue({
      sessionId: 's1',
      clientId: 'final',
    });
    const { result } = renderHook(() => useDeleteMessage({
      sessionId: 's1',
      messageClientId: 'final',
    }));

    await act(async () => result.current());

    expect(mocks.removeMessagesByClientIds).toHaveBeenCalledWith('s1', ['final']);
  });
});
