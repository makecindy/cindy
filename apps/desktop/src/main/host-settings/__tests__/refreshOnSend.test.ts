import { describe, expect, it, vi } from 'vitest';
import { LIBRARY_READ_ROOT } from '@cindy/maker-core';
import { libraryExtraDirSlot } from '../../maker-ipc/extraDirsValidator.js';
import { createPersonalizationRefresh } from '../refreshOnSend.js';

function fixture(kind: 'pi' | 'claude-code' | 'codex' = 'pi', proxy = false) {
  const original = {
    agentKind: kind, sdkSessionId: 'native-history', remoteHostId: null, agentDeviceId: null,
    hostStartupPreferences: { userPrompt: 'old', makerMemoryEnabled: true },
    codexUsesProxyInstructions: proxy,
    getStatus: () => 'active' as const,
    isTurnRunning: vi.fn(() => false),
    hasPendingHostOperation: vi.fn(() => false),
    hasLiveBackgroundWork: vi.fn(async () => false),
  };
  let active: typeof original | undefined = original;
  let owner = {};
  const deps = {
    getOwner: () => owner,
    getSession: () => active,
    readPrompt: vi.fn(async () => 'new'),
    readCreateOpts: vi.fn(async () => ({
      agentKind: kind, model: 'fixture-model', workingDir: '/fixture', resumeSessionId: original.sdkSessionId,
    })),
    readExtraDirs: vi.fn(async (): Promise<string[]> => []),
    rebuild: vi.fn(async (request: {
      opts: { resumeSessionId?: string };
      userPrompt: string; beforeClose(): Promise<boolean>; assertCurrent(): void;
    }) => {
      if (!await request.beforeClose()) return original;
      active = undefined;
      request.assertCurrent();
      return active = { ...original, hostStartupPreferences: {
        ...original.hostStartupPreferences, userPrompt: request.userPrompt,
      } };
    }),
  };
  const refresh = createPersonalizationRefresh(deps);
  return { original, deps, resetOwner: () => { owner = {}; }, close: () => { active = undefined; },
    send: (ownerInput = true) => refresh('task', active, ownerInput, () => {}) };
}

// Unit coverage of the send-time refresh entry. Startup capture tests cover
// new sessions only. A changed or cleared prompt on an existing native handle
// must reach the strict resume path without sending on a replacement history.
describe('personal instructions at the next user send', () => {
  it('keeps the same handle for unchanged instructions and leaves background continuation alone', async () => {
    const { original, deps, send } = fixture();
    expect(await send(false)).toBe(original);
    expect(deps.readPrompt).not.toHaveBeenCalled();
    deps.readPrompt.mockResolvedValueOnce('old');
    expect(await send()).toBe(original);
    expect(deps.rebuild).not.toHaveBeenCalled();
  });

  it.each([
    ['claude-code', false, 'updated'],
    ['pi', false, ''],
    ['codex', true, 'updated'],
  ] as const)('resumes the same history with the saved value (%s)', async (kind, proxy, latest) => {
    const { deps, send } = fixture(kind, proxy);
    deps.readPrompt.mockResolvedValueOnce(latest);
    const resumed = await send();
    expect(resumed?.hostStartupPreferences.userPrompt).toBe(latest);
    expect(deps.rebuild).toHaveBeenCalledWith(expect.objectContaining({
      userPrompt: latest,
      opts: expect.objectContaining({ resumeSessionId: 'native-history', makerMemoryEnabled: true }),
    }));
  });

  it.each(['rewind', 'background'] as const)('defers replacement while %s needs the original handle', async reason => {
    const { original, deps, send } = fixture(reason === 'rewind' ? 'claude-code' : 'codex', true);
    original.hasPendingHostOperation.mockReturnValue(reason === 'rewind');
    original.hasLiveBackgroundWork.mockResolvedValue(reason === 'background');
    expect(await send()).toBe(original);
    expect(deps.getSession()).toBe(original);
    original.hasPendingHostOperation.mockReturnValue(false);
    original.hasLiveBackgroundWork.mockResolvedValue(false);
    expect((await send())?.hostStartupPreferences.userPrompt).toBe('new');
  });

  it('restores read-only directories and the host-owned library slot before rebuilding', async () => {
    const { deps, send } = fixture();
    deps.readExtraDirs.mockResolvedValueOnce(['/readonly', libraryExtraDirSlot('/library')]);
    await send();
    expect(deps.rebuild).toHaveBeenCalledWith(expect.objectContaining({
      opts: expect.objectContaining({ extraDirs: ['/readonly', '/library'], [LIBRARY_READ_ROOT]: '/library' }),
    }));
  });

  it('keeps the original handle when native Codex cannot replace the instructions reliably', async () => {
    const { original, deps, send } = fixture('codex');
    await expect(send()).rejects.toThrow('while preserving the current history');
    expect(deps.getSession()).toBe(original);
    expect(deps.rebuild).not.toHaveBeenCalled();
  });

  it('retains strict resume on retry after the handle closed but its native resume failed', async () => {
    const { original, deps, send, close } = fixture();
    deps.rebuild.mockImplementationOnce(async request => {
      if (!await request.beforeClose()) return original;
      close();
      throw new Error('Native resume failed');
    });
    await expect(send()).rejects.toThrow('Native resume failed');
    await expect(send(false)).rejects.toThrow('original Agent history');
    deps.readPrompt.mockResolvedValueOnce('latest saved');
    expect((await send())?.hostStartupPreferences.userPrompt).toBe('latest saved');
    expect(deps.rebuild.mock.calls[1]?.[0].opts.resumeSessionId).toBe('native-history');
  });

  it('stops before closing the old handle if the account or turn changed during the preference read', async () => {
    const account = fixture();
    account.deps.readPrompt.mockImplementationOnce(async () => {
      account.resetOwner();
      return 'new';
    });
    await expect(account.send()).rejects.toThrow('account changed');
    expect(account.deps.rebuild).not.toHaveBeenCalled();

    const turn = fixture();
    turn.deps.readPrompt.mockImplementationOnce(async () => {
      turn.original.isTurnRunning.mockReturnValue(true);
      return 'new';
    });
    await expect(turn.send()).rejects.toThrow('Agent changed');
    expect(turn.deps.rebuild).not.toHaveBeenCalled();
  });
});
