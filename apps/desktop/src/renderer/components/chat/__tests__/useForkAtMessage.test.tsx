// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  forkAtMessage: vi.fn(),
  navigate: vi.fn(),
  emitRefresh: vi.fn(),
  reportSessionNavigation: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm }),
}));

vi.mock('@/lib/sessionService', () => ({
  forkAtMessage: mocks.forkAtMessage,
}));

vi.mock('@/lib/composerDraftStore', () => ({
  saveDraft: vi.fn(),
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

vi.mock('@/features/cc-agent/embeddedSessionNavigation', () => ({
  useSessionNavigationMode: () => 'route-owner',
  useSessionNavigationIntent: () => mocks.reportSessionNavigation,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.toastError } }));

import { useForkAtMessage } from '../useForkAtMessage';

describe('useForkAtMessage introduction dialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.forkAtMessage.mockResolvedValue({ id: 'new-session' });
  });

  it('introduces the feature and only creates a conversation after confirmation', async () => {
    mocks.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { result } = renderHook(() =>
      useForkAtMessage({
        sessionId: 'source-session',
        messageClientId: 'message-1',
      }),
    );

    const onConfirmed = vi.fn();
    await act(async () => result.current({ onConfirmed }));
    expect(mocks.confirm).toHaveBeenLastCalledWith({
      title: 'chat.messageActionBar.forkConfirmTitle',
      description: 'chat.messageActionBar.forkConfirmDescription',
      confirmText: 'chat.messageActionBar.forkConfirm',
      cancelText: 'chat.messageActionBar.forkCancel',
      autoFocusConfirm: true,
    });
    expect(mocks.forkAtMessage).not.toHaveBeenCalled();
    expect(onConfirmed).not.toHaveBeenCalled();

    await act(async () => result.current({ onConfirmed }));
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(mocks.forkAtMessage).toHaveBeenCalledWith('source-session', 'message-1');
    expect(mocks.emitRefresh).toHaveBeenCalledTimes(1);
    expect(mocks.reportSessionNavigation).toHaveBeenCalledWith('new-session', 'new-session');
    expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/new-session');
  });
  it('explains an outdated provider host without navigating to an empty task', async () => {
    mocks.confirm.mockResolvedValue(true);
    mocks.forkAtMessage.mockRejectedValue(new Error('[REMOTE_AGENT_PEER_TOO_OLD] update the host'));
    const { result } = renderHook(() => useForkAtMessage({ sessionId: 'shared-task', messageClientId: 'reply' }));
    await act(async () => {
      await expect(result.current()).rejects.toThrow('REMOTE_AGENT_PEER_TOO_OLD');
    });
    expect(mocks.toastError).toHaveBeenCalledWith('chat.remoteError.REMOTE_AGENT_PEER_TOO_OLD');
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});
