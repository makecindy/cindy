/**
 * Test value: the public renderer mirror must show host aliases without crossing account/link scopes.
 * The shared mirror suite cannot cover Desktop owner stamps or authenticated preload ingress.
 * Minimal regressions: one stale read after account/revocation, or generation 8 -> reset -> 1;
 * an older read must not lower a newer push watermark. Unit tier; no DOM or real transport needed.
 */
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
  vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
});
afterEach(() => {
  remoteProjectAliases.clear();
  resetRemoteDataOwnerPushFence();
  setDataOwnerGeneration(null, 0);
  vi.unstubAllGlobals();
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

  it('retains same-owner names across a local generation change while fencing old reads', async () => {
    invoke.mockResolvedValueOnce(snapshot('A')).mockResolvedValueOnce(snapshot('B'));
    await remoteProjectAliases.refresh('a', () => true);
    await remoteProjectAliases.refresh('b', () => true);
    const previous = remoteProjectAliases.getSnapshot();
    let complete!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const pending = remoteProjectAliases.refresh('a', () => true);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));

    setDataOwnerGeneration('owner', 2);
    const duringRepair = remoteProjectAliases.getSnapshot();
    complete(snapshot('Stale local generation'));
    await pending;
    expect(duringRepair).toBe(previous);
    expect(remoteProjectAliases.getSnapshot()).toBe(previous);

    invoke.mockResolvedValueOnce(snapshot('Fresh A'));
    await remoteProjectAliases.refresh('a', () => true);
    expect(remoteProjectAliases.getSnapshot().get('a')?.aliases[0].alias).toBe('Fresh A');
    expect(remoteProjectAliases.getSnapshot().get('b')).toBe(previous.get('b'));
    setDataOwnerGeneration('other', 3);
    expect(remoteProjectAliases.getSnapshot().size).toBe(0);
  });

  it('retains host watermarks and rejects old local pushes across same-owner repair', async () => {
    const hostStamp = { dataOwnerId: 'owner', ownerGeneration: 8 };
    invoke.mockResolvedValueOnce({ ...snapshot('Current host'), ownerStamp: hostStamp });
    await remoteProjectAliases.refresh('a', () => true);
    setDataOwnerGeneration('owner', 2);
    expect(remoteProjectAliases.acceptChanged('a', hostStamp,
      { dataOwnerId: 'owner', ownerGeneration: 1 }, () => true)).toBe(false);
    invoke.mockResolvedValueOnce(snapshot('Old host generation'));
    await remoteProjectAliases.refresh('a', () => true);
    expect(remoteProjectAliases.getSnapshot().get('a')?.aliases[0].alias).toBe('Current host');
    expect(remoteProjectAliases.acceptChanged('a', hostStamp,
      { dataOwnerId: 'owner', ownerGeneration: 2 }, () => true)).toBe(true);
  });

  it('accepts a restarted host generation after suspension while rejecting older reads within one link', async () => {
    invoke.mockResolvedValueOnce({ ...snapshot('Before restart'), ownerStamp: { dataOwnerId: 'owner', ownerGeneration: 8 } });
    await remoteProjectAliases.refresh('a', () => true);
    invoke.mockResolvedValueOnce(snapshot('Old generation'));
    await remoteProjectAliases.refresh('a', () => true);
    expect(remoteProjectAliases.getSnapshot().get('a')?.aliases[0].alias).toBe('Before restart');
    remoteProjectAliases.suspend('a');
    invoke.mockResolvedValueOnce(snapshot('After restart'));
    await remoteProjectAliases.refresh('a', () => true);
    expect(remoteProjectAliases.getSnapshot().get('a')?.aliases[0].alias).toBe('After restart');
  });

  it('keeps a newer push watermark when an older read settles and rejects stale local notifications', async () => {
    invoke.mockResolvedValueOnce(snapshot('Initial'));
    await remoteProjectAliases.refresh('a', () => true);
    let complete!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const pending = remoteProjectAliases.refresh('a', () => true);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    const stamp = { dataOwnerId: 'owner', ownerGeneration: 8 };
    expect(remoteProjectAliases.acceptChanged('a', stamp, undefined, () => false)).toBe(false);
    expect(remoteProjectAliases.acceptChanged('a', stamp, { dataOwnerId: 'owner', ownerGeneration: 0 }, () => true)).toBe(false);
    expect(remoteProjectAliases.acceptChanged('a', stamp, undefined, () => true)).toBe(true);
    complete(snapshot('Stale response'));
    await pending;
    expect(remoteProjectAliases.getSnapshot().get('a')?.aliases[0].alias).toBe('Initial');
    expect(remoteProjectAliases.acceptChanged('a', { ...stamp, ownerGeneration: 7 }, undefined, () => true)).toBe(false);
    invoke.mockResolvedValueOnce({ ...snapshot('Fresh'), ownerStamp: stamp });
    await remoteProjectAliases.refresh('a', () => true);
    expect(remoteProjectAliases.getSnapshot().get('a')?.aliases[0].alias).toBe('Fresh');
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
