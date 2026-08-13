import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listMessagesFor: vi.fn(),
  forkAtMessage: vi.fn(),
  emitRefresh: vi.fn(),
  getSessionDeviceId: vi.fn(),
  refreshRemoteDeviceSessions: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/lib/makerTransport', () => ({
  listMessagesFor: mocks.listMessagesFor,
}));
vi.mock('@/lib/sessionService', () => ({
  forkAtMessage: mocks.forkAtMessage,
}));
vi.mock('@/lib/sessionsBus', () => ({
  emitRefresh: mocks.emitRefresh,
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  getSessionDeviceId: mocks.getSessionDeviceId,
}));
vi.mock('@/features/device-link/refreshRemoteSessions', () => ({
  refreshRemoteDeviceSessions: mocks.refreshRemoteDeviceSessions,
}));
vi.mock('@/lib/toast', () => ({
  toast: mocks.toast,
}));
vi.mock('@/lib/sessionMessageText', () => ({
  sessionMessageDisplayText: (message: { content?: string }) => message.content ?? null,
}));

import {
  copyCurrentTaskMarkdown,
  forkCurrentTaskFromKeyboard,
} from '../workLouderCodexTaskActions';

describe('workLouderCodexTaskActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionDeviceId.mockReturnValue(undefined);
  });

  it('forks at the latest assistant reply and opens the new task', async () => {
    mocks.listMessagesFor.mockResolvedValue([
      { role: 'user', clientId: 'u1', content: 'hello' },
      { role: 'assistant', clientId: 'a1', content: 'hi' },
    ]);
    mocks.forkAtMessage.mockResolvedValue({ id: 'forked' });
    const navigate = vi.fn();

    await forkCurrentTaskFromKeyboard('session-1', { navigate, t: (key) => key });

    expect(mocks.forkAtMessage).toHaveBeenCalledWith('session-1', 'a1');
    expect(mocks.emitRefresh).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith('/cc-agent/forked');
  });

  it('copies readable conversation markdown', async () => {
    mocks.listMessagesFor.mockResolvedValue([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    await copyCurrentTaskMarkdown('session-1', { navigate: vi.fn(), t: (key) => key });

    expect(writeText).toHaveBeenCalledWith('## User\n\nhello\n\n## Cindy\n\nworld');
    expect(mocks.toast.success).toHaveBeenCalled();
  });

  it('shows an error when there is no assistant reply to fork from', async () => {
    mocks.listMessagesFor.mockResolvedValue([{ role: 'user', clientId: 'u1', content: 'hello' }]);

    await forkCurrentTaskFromKeyboard('session-1', { navigate: vi.fn(), t: (key) => key });

    expect(mocks.forkAtMessage).not.toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalledWith('chat.userMessage.forkErrors.noPriorAssistant');
  });

  it('warns when there is no conversation text to copy', async () => {
    mocks.listMessagesFor.mockResolvedValue([]);

    await copyCurrentTaskMarkdown('session-1', { navigate: vi.fn(), t: (key) => key });

    expect(mocks.toast.warning).toHaveBeenCalledWith(
      'settings.shortcuts.workLouderCodex.commands.copyConversationMarkdown.empty',
    );
  });
});
