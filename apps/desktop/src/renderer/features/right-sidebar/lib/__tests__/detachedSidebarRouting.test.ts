// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sidebarWindow: false,
  secondaryWindow: false,
  sendCommand: vi.fn(
    async (): Promise<'attached' | 'routed' | 'queued' | 'stale-context'> => 'routed',
  ),
}));

vi.mock('@/lib/sidebarWindow', () => ({
  isSidebarWindow: () => mocks.sidebarWindow,
}));
vi.mock('@/lib/secondaryWindow', () => ({
  isSecondaryWindow: () => mocks.secondaryWindow,
}));

import { routeSidebarCommand } from '../detachedSidebarRouting';

describe('routeSidebarCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sidebarWindow = false;
    mocks.secondaryWindow = false;
    mocks.sendCommand.mockResolvedValue('routed');
    Object.assign(window, {
      electronAPI: {
        rightSidebarWindow: { sendCommand: mocks.sendCommand },
      },
    });
  });

  it.each(['attached', 'routed', 'queued', 'stale-context'] as const)(
    'returns the main-owned route result %s without consulting a renderer snapshot',
    async (result) => {
      mocks.sendCommand.mockResolvedValueOnce(result);
      const command = { type: 'open-terminal' as const, sessionId: 's1' };

      await expect(routeSidebarCommand(command)).resolves.toBe(result);
      expect(mocks.sendCommand).toHaveBeenCalledWith({
        command,
        allowOpen: true,
        userInitiated: true,
      });
    },
  );

  it('moves allowOpen into the IPC envelope', async () => {
    const command = { type: 'close-orca-workers-tab' as const, sessionId: 's1' };
    await routeSidebarCommand(command, { allowOpen: false });

    expect(mocks.sendCommand).toHaveBeenCalledWith({
      command,
      allowOpen: false,
      userInitiated: true,
    });
  });

  it.each([
    { type: 'open-terminal' as const, sessionId: 's1' },
    { type: 'open-web-browser' as const, sessionId: 's1', url: 'https://x.dev' },
    {
      type: 'open-file-browser' as const,
      sessionId: 's1',
      relPath: 'AGENTS.md',
      targetKind: 'file' as const,
    },
    { type: 'ensure-orca-workers-tab' as const, sessionId: 's1', focusTab: true },
  ])('keeps $type attached in a secondary renderer', async (command) => {
    mocks.secondaryWindow = true;

    await expect(routeSidebarCommand(command)).resolves.toBe('attached');
    expect(mocks.sendCommand).not.toHaveBeenCalled();
  });

  it('keeps sidebar-window commands in that renderer', async () => {
    mocks.sidebarWindow = true;
    await expect(
      routeSidebarCommand({ type: 'open-terminal', sessionId: 's1' }),
    ).resolves.toBe('attached');
    expect(mocks.sendCommand).not.toHaveBeenCalled();
  });
});
