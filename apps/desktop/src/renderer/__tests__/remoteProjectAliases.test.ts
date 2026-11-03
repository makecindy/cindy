// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { resetRemoteDataOwnerPushFence } from '@/lib/remoteDataOwnerPushFence';
import { remoteProjectAliases } from '@/features/device-link/remoteProjectAliases';

const snapshot = (name: string, owner = 'owner') => ({
  aliases: [{ projectKey: 'local:/repo', alias: name }],
  platform: 'darwin',
  ownerStamp: { dataOwnerId: owner, ownerGeneration: 1 },
});
const invoke = vi.fn();

beforeEach(() => {
  remoteProjectAliases.clear();
  resetRemoteDataOwnerPushFence();
  setDataOwnerGeneration('owner', 1);
  invoke.mockReset();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { deviceLink: { invoke } },
  });
});
afterEach(() => {
  remoteProjectAliases.clear();
  resetRemoteDataOwnerPushFence();
  setDataOwnerGeneration(null, 0);
  Reflect.deleteProperty(window, 'electronAPI');
});

describe('Desktop project alias mirror adapter', () => {
  it('reads the owning host without writing local aliases and preserves other device snapshots', async () => {
    invoke.mockResolvedValueOnce(snapshot('A')).mockResolvedValueOnce(snapshot('B'));
    await remoteProjectAliases.refresh('a', () => true);
    await remoteProjectAliases.refresh('b', () => true);
    expect(invoke).toHaveBeenCalledWith('a', 'sidebar-settings:get-project-aliases', []);
    expect(remoteProjectAliases.getSnapshot().get('a')?.aliases[0].alias).toBe('A');
    expect(remoteProjectAliases.getSnapshot().get('b')?.aliases[0].alias).toBe('B');
    remoteProjectAliases.remove('a');
    expect(remoteProjectAliases.getSnapshot().has('a')).toBe(false);
    expect(remoteProjectAliases.getSnapshot().get('b')?.aliases[0].alias).toBe('B');
  });

  it('rejects a different source owner and hides the previous owner immediately on account change', async () => {
    invoke.mockResolvedValueOnce({ aliases: [{ projectKey: 'local:/repo', alias: 'Unstamped' }], platform: 'darwin' });
    await remoteProjectAliases.refresh('a', () => true);
    expect(remoteProjectAliases.getSnapshot().size).toBe(0);
    invoke.mockResolvedValueOnce(snapshot('Wrong account', 'other'));
    await remoteProjectAliases.refresh('a', () => true);
    expect(remoteProjectAliases.getSnapshot().size).toBe(0);
    invoke.mockResolvedValueOnce(snapshot('Owner project'));
    await remoteProjectAliases.refresh('a', () => true);
    expect(remoteProjectAliases.getSnapshot().size).toBe(1);
    setDataOwnerGeneration('other', 2);
    expect(remoteProjectAliases.getSnapshot().size).toBe(0);
  });

  it('discards a read settled after account change or device revocation', async () => {
    let complete!: (value: unknown) => void;
    invoke.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const oldAccount = remoteProjectAliases.refresh('a', () => true);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    setDataOwnerGeneration('other', 2);
    complete(snapshot('Old account'));
    await oldAccount;
    expect(remoteProjectAliases.getSnapshot().size).toBe(0);
    let eligible = true;
    const revoked = remoteProjectAliases.refresh('a', () => eligible);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    eligible = false;
    remoteProjectAliases.remove('a');
    complete(snapshot('Revoked', 'other'));
    await revoked;
    expect(remoteProjectAliases.getSnapshot().size).toBe(0);
  });
});
