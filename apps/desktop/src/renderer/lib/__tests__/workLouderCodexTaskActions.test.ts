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
      { role: 'assistant', clientId: 'a2', content: 'later', id: 'm2', createdAt: '2026-08-18T01:00:00.000Z' },
      { role: 'user', clientId: 'u2', content: 'again', id: 'm3', createdAt: '2026-08-18T00:30:00.000Z' },
      { role: 'assistant', clientId: 'a1', content: 'hi', id: 'm1', createdAt: '2026-08-18T00:00:00.000Z' },
    ]);
    mocks.forkAtMessage.mockResolvedValue({ id: 'forked' });
    const navigate = vi.fn();

    await forkCurrentTaskFromKeyboard('session-1', { navigate, t: (key) => key });

    expect(mocks.forkAtMessage).toHaveBeenCalledWith('session-1', 'a2');
    expect(mocks.emitRefresh).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith('/cc-agent/forked');
  });

  it('copies readable conversation markdown', async () => {
    const newestPage: Array<{
      role: 'user' | 'assistant';
      content: string;
      id: string;
      createdAt: string;
    }> = Array.from({ length: 100 }, (_, index) => ({
      role: 'user',
      content: `later-${index}`,
      id: `later-${index}`,
      createdAt: '2026-08-18T02:00:00.000Z',
    }));
    newestPage[0] = {
      role: 'assistant',
      content: 'latest',
      id: 'latest',
      createdAt: '2026-08-18T02:01:00.000Z',
    };
    mocks.listMessagesFor
      .mockResolvedValueOnce(newestPage)
      .mockResolvedValueOnce([
        { role: 'assistant', content: 'world', id: 'old-2', createdAt: '2026-08-18T00:01:00.000Z' },
        { role: 'user', content: 'hello', id: 'old-1', createdAt: '2026-08-18T00:00:00.000Z' },
      ]);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    await copyCurrentTaskMarkdown('session-1', { navigate: vi.fn(), t: (key) => key });

    expect(writeText).toHaveBeenCalledWith(
      expect.stringMatching(/^## User\n\nhello\n\n## Cindy\n\nworld[\s\S]*## Cindy\n\nlatest$/),
    );
    expect(mocks.listMessagesFor).toHaveBeenCalledTimes(2);
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
