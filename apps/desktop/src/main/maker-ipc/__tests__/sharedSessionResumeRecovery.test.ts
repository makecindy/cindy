import { describe, expect, it, vi } from 'vitest';
import { withSharedSessionResumeRecovery, type SharedSessionResumeRecoveryDeps } from '../sharedSessionResumeRecovery.js';
import type { MakerSessionCreateOpts } from '../sessionRequest.js';

const rejection = () => new Error('[REMOTE_AGENT_INVALID] this conversation cannot be resumed on this computer');
function fixture() {
  const options: MakerSessionCreateOpts = {
    id: 'task', agentKind: 'codex', workingDir: '/task', model: 'model', providerId: 'provider',
    agentDeviceId: 'share:provider', resumeSessionId: 'old-native',
    vendorOptions: { threadId: 'old-native', forkSession: true, resumeSessionAt: 'tail', tailTurnsToDrop: 2, keep: 'value' },
  };
  const row = { sdkSessionId: 'old-native', status: 'active', agentKind: 'codex', agentDeviceId: 'share:provider',
    providerId: 'provider', model: 'model', clearedAt: null, effort: null, fastMode: false } as const;
  const deps: SharedSessionResumeRecoveryDeps = {
    assertCurrent: vi.fn(), readGeneration: vi.fn(() => 0), getSessionRow: vi.fn(async () => row),
    listMessages: vi.fn(async () => [{ role: 'user', content: 'Keep the original requirements', createdAt: 1 }]),
    commit: vi.fn(async () => ({ updatedAt: 2 })), setPending: vi.fn(), publish: vi.fn(),
  };
  return { options, deps, row };
}

// #10187 / unit: only an explicit pre-SDK refusal can replace native history;
// a lost open acknowledgement may already have started an Agent and must not replay.
describe('shared session ownership resume recovery', () => {
  it('commits the history and conditional SDK reset before starting fresh exactly once', async () => {
    const { options, deps } = fixture();
    const start = vi.fn(async () => {
      if (options.resumeSessionId) throw rejection();
      expect(deps.commit).toHaveBeenCalledOnce();
      expect(deps.setPending).toHaveBeenCalledOnce();
      expect(options.vendorOptions).toEqual({ keep: 'value' });
      return 'opened';
    });
    expect(await withSharedSessionResumeRecovery(options, start, deps)).toBe('opened');
    expect(start).toHaveBeenCalledTimes(2);
    expect(deps.commit).toHaveBeenCalledWith('task', expect.stringContaining('Keep the original requirements'),
      expect.objectContaining({ reason: 'native-session-recovery', expectedClearedAt: null,
        expectedSdkSessionId: 'old-native' }));
    expect(deps.publish).toHaveBeenCalledExactlyOnceWith('task');
  });

  it.each([
    '[REMOTE_AGENT_TIMEOUT] open timed out',
    '[REMOTE_AGENT_INVALID] this shared task is not authorized on this computer',
    '[REMOTE_AGENT_INVALID] unsupported method',
    '[REMOTE_AGENT_INVALID] This conversation cannot be resumed on this computer.',
  ])('does not clear history or replay %s', async message => {
    const { options, deps } = fixture();
    const start = vi.fn(async () => { throw new Error(message); });
    await expect(withSharedSessionResumeRecovery(options, start, deps)).rejects.toThrow(message);
    expect(start).toHaveBeenCalledOnce();
    expect(deps.commit).not.toHaveBeenCalled();
    expect(options.resumeSessionId).toBe('old-native');
  });

  it.each([{ agentDeviceId: 'own-computer' }, { resumeSessionId: undefined }, { remoteHostId: 'ssh-host' }])(
    'does not rebuild outside a shared native resume: %j', async patch => {
      const { options, deps } = fixture(); Object.assign(options, patch);
      const start = vi.fn(async () => { throw rejection(); });
      await expect(withSharedSessionResumeRecovery(options, start, deps)).rejects.toThrow('cannot be resumed');
      expect(start).toHaveBeenCalledOnce(); expect(deps.commit).not.toHaveBeenCalled();
    });

  it('returns a second refusal without looping, retaining durable pending history', async () => {
    const { options, deps } = fixture();
    const start = vi.fn(async () => { throw rejection(); });
    await expect(withSharedSessionResumeRecovery(options, start, deps)).rejects.toThrow('cannot be resumed');
    expect(start).toHaveBeenCalledTimes(2); expect(deps.commit).toHaveBeenCalledOnce();
    expect(deps.setPending).toHaveBeenCalledOnce(); expect(options.resumeSessionId).toBeUndefined();
  });

  it('does not clear options or open fresh when the atomic write fails', async () => {
    const { options, deps } = fixture();
    vi.mocked(deps.commit).mockRejectedValue(new Error('PRECONDITION_FAILED'));
    const start = vi.fn(async () => { throw rejection(); });
    await expect(withSharedSessionResumeRecovery(options, start, deps)).rejects.toThrow('PRECONDITION_FAILED');
    expect(start).toHaveBeenCalledOnce(); expect(deps.setPending).not.toHaveBeenCalled();
    expect(options.resumeSessionId).toBe('old-native');
  });

  it.each([{ sdkSessionId: 'newer-native' }, { status: 'deleted' }, { providerId: 'other-provider' },
    { agentDeviceId: 'share:other' }, { model: 'new-model' }, { agentKind: 'pi' }] as const)(
    'does not overwrite a changed task: %j', async patch => {
      const { options, deps, row } = fixture();
      vi.mocked(deps.getSessionRow).mockResolvedValue({ ...row, ...patch });
      const start = vi.fn(async () => { throw rejection(); });
      await expect(withSharedSessionResumeRecovery(options, start, deps)).rejects.toThrow('cannot be resumed');
      expect(start).toHaveBeenCalledOnce(); expect(deps.commit).not.toHaveBeenCalled();
    });

  it.each(['account', 'history', 'abort'])('stops when %s changes while reading history', async change => {
    const { options, deps } = fixture();
    vi.mocked(deps.listMessages).mockImplementation(async () => {
      if (change === 'history') vi.mocked(deps.readGeneration).mockReturnValue(1);
      else vi.mocked(deps.assertCurrent).mockImplementation(() => { throw new Error(change); });
      return [];
    });
    const start = vi.fn(async () => { throw rejection(); });
    await expect(withSharedSessionResumeRecovery(options, start, deps)).rejects.toThrow();
    expect(start).toHaveBeenCalledOnce(); expect(deps.commit).not.toHaveBeenCalled();
  });

  it('does not reopen or publish to a new account after committing', async () => {
    const { options, deps } = fixture();
    vi.mocked(deps.commit).mockImplementation(async () => {
      vi.mocked(deps.assertCurrent).mockImplementation(() => { throw new Error('account changed'); });
      return { updatedAt: 2 };
    });
    const start = vi.fn(async () => { throw rejection(); });
    await expect(withSharedSessionResumeRecovery(options, start, deps)).rejects.toThrow('account changed');
    expect(start).toHaveBeenCalledOnce(); expect(deps.setPending).not.toHaveBeenCalled();
    expect(deps.publish).not.toHaveBeenCalled();
  });
});
